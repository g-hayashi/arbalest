import { describe, expect, it, vi } from "vitest";
import type { SummarizePatch } from "../../src/analysis/schemas.js";
import { createFakeLlmProvider, LlmError } from "../../src/llm/index.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import type { RequestProgressInput } from "../../src/store/types.js";
import { TeamsApiError } from "../../src/teams/graph.js";
import { type TeamsTrust, teamsTaskName } from "../../src/teams/ingress.js";
import { createTeamsJob, teamsChannelKey, teamsTargetId } from "../../src/teams/job.js";
import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";
import type { TeamsConversation, TeamsJobPayload } from "../../src/teams/types.js";
import { resolveRequestPeriod } from "../../src/util/time.js";
import { FILTERED_TEXT } from "../../src/worker/server.js";

const NOW = new Date("2026-10-26T03:00:00Z");
const TENANT = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const trust: TeamsTrust = {
  appId: "33333333-3333-4333-8333-333333333333",
  tenantId: TENANT,
  allowedTeamIds: new Set([TEAM]),
};
function payload(over: Partial<TeamsJobPayload> = {}): TeamsJobPayload {
  const p: TeamsJobPayload = {
    platform: "teams",
    taskName: "",
    tenantId: TENANT,
    teamId: TEAM,
    channelId: "19:test@thread.tacv2",
    conversationId: "19:test@thread.tacv2;messageid=100",
    rootMessageId: "100",
    mentionId: "101",
    userId: "44444444-4444-4444-8444-444444444444",
    serviceUrl: "https://smba.trafficmanager.net/jp/",
    requestText: "",
    requestedAt: NOW.toISOString(),
    ...over,
  };
  p.taskName = teamsTaskName(p);
  return p;
}
const TS = "1792972800.000000";
const LINK = "https://teams.microsoft.com/l/message/19%3Atest%40thread.tacv2/100";
const emptyPatch = (): SummarizePatch => ({
  overview: [],
  topics: [],
  responses: [],
  statements: [],
  todos: [],
  questions: [],
  close: [],
});

function setupFindings() {
  const s = setup();
  const llm = createFakeLlmProvider({
    request_intent: () => ({
      intent: "findings",
      suppressTodo: false,
      suppressCanvas: false,
      period: { kind: "rolling_days", amount: 7 },
    }),
    findings_map: () => ({
      candidates: [
        {
          evidence: ["m1"],
          quote: "会議室を予約します",
          theme_hint: "予約手順",
          statement: "予約を担当する",
          kind: "finding",
        },
      ],
    }),
    findings_reduce: () => ({
      themes: [
        { theme: "予約手順", findings: [{ statement: "予約を担当する", candidate_ids: ["c1"] }] },
      ],
    }),
  });
  return { ...s, llm, ctx: { ...s.ctx, llm } };
}

describe("Teams 期間の Findings", () => {
  it("管理機能有効でもFindingsは返信だけで、機能未対応とは表示しない", async () => {
    const s = setupFindings();
    const workStore = createMemoryTeamsWorkStore({ now: () => NOW });
    const register = vi.spyOn(workStore, "register");
    const reserve = vi.spyOn(workStore, "reserveRecord");
    const sync = vi.fn();
    const job = createTeamsJob({
      graph: s.graph,
      reply: s.reply,
      trust,
      work: { store: workStore, now: () => NOW, sync },
    });
    await job(payload({ requestText: "findings 7" }), s.ctx);
    expect(s.reply.mock.calls.map((call) => call[1]).join("\n")).not.toContain("未対応");
    expect(register).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
  it("findings Nは意図AIなしで、requestedAt固定の期間をgetChannelへ渡す", async () => {
    const s = setupFindings();
    const todo = vi.spyOn(s.store.todos, "upsert");
    const canvas = vi.spyOn(s.store.canvases, "set");
    const targets = vi.spyOn(s.store.targets, "put");
    const period = resolveRequestPeriod({ kind: "rolling_days", amount: 7 }, NOW);
    if (period === null) throw new Error("期間なし");
    // Graphが期間外の親を除き、期間内の返信だけを返した取得結果。
    const replyMessage = s.conversation.messages[0];
    if (replyMessage === undefined) throw new Error("返信なし");
    replyMessage.threadTs = "1790000000.000000";
    await s.job(payload({ requestText: "findings 7" }), {
      ...s.ctx,
      now: () => new Date("2026-11-01T00:00:00Z"),
    });
    expect(s.graph.getChannel).toHaveBeenCalledWith(
      TEAM,
      payload().channelId,
      new Date(period.start),
      new Date(period.end),
    );
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(s.llm.calls.map((call) => call.schemaName)).toEqual(["findings_map", "findings_reduce"]);
    expect(s.llm.calls[0]?.input).toContain("会議室を予約します");
    const text = s.reply.mock.calls.map((call) => call[1]).join("\n");
    for (const value of [
      "Findings",
      "投稿1件",
      "予約手順",
      LINK,
      period.start,
      period.end,
      "未対応",
    ])
      expect(text).toContain(value);
    expect(todo).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
    expect(targets).not.toHaveBeenCalled();
  });

  it("自然文の期間を共通解釈し、clarifyでは履歴も分析も取得しない", async () => {
    const s = setupFindings();
    await s.job(payload({ requestText: "直近一週間の動きを教えて" }), s.ctx);
    expect(s.llm.calls.map((call) => call.schemaName)).toEqual([
      "request_intent",
      "findings_map",
      "findings_reduce",
    ]);
    const clarify = createFakeLlmProvider({
      request_intent: () => ({
        intent: "clarify",
        suppressTodo: true,
        suppressCanvas: true,
        period: null,
      }),
    });
    s.graph.getChannel.mockClear();
    await s.job(payload({ mentionId: "102", requestText: "前の時期を調べて" }), {
      ...s.ctx,
      llm: clarify,
    });
    expect(s.graph.getChannel).not.toHaveBeenCalled();
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(clarify.calls).toHaveLength(1);
    expect(s.reply.mock.calls.at(-1)?.[1]).toContain("対象の期間");
  });

  it("期間上限を表示し、空取得ならmap/reduce/意図AIを呼ばない", async () => {
    const s = setupFindings();
    s.conversation.messages = [];
    await s.job(payload({ requestText: "findings 999" }), s.ctx);
    expect(s.llm.calls).toHaveLength(0);
    const text = s.reply.mock.calls.map((call) => call[1]).join("\n");
    expect(text).toContain("90 日に制限");
    expect(text).toContain("投稿0件");
    expect(text).toContain("見つかりませんでした");
  });

  it("同一の取得mapだけで候補を再利用し、sourceIds・表示名変更では取り直す", async () => {
    const s = setupFindings();
    for (const mentionId of ["101", "102"])
      await s.job(payload({ mentionId, requestText: "findings 7" }), s.ctx);
    expect(s.llm.calls.filter((call) => call.schemaName === "findings_map")).toHaveLength(1);
    expect(s.llm.calls.filter((call) => call.schemaName === "findings_reduce")).toHaveLength(2);
    s.conversation.sourceIds.set(TS, "200");
    s.conversation.links.set(TS, LINK.replace("/100", "/200"));
    await s.job(payload({ mentionId: "103", requestText: "findings 7" }), s.ctx);
    expect(s.llm.calls.filter((call) => call.schemaName === "findings_map")).toHaveLength(2);
    expect(s.reply.mock.calls.at(-1)?.[1]).toContain("/200");
    s.conversation.names.set("user", "別名");
    await s.job(payload({ mentionId: "104", requestText: "findings 7" }), s.ctx);
    expect(s.llm.calls.filter((call) => call.schemaName === "findings_map")).toHaveLength(3);
  });

  it("別teamのキャッシュを共有せず、本文や名前をログへ出さない", async () => {
    const s = setupFindings();
    const secondTeam = "55555555-5555-4555-8555-555555555555";
    const job = createTeamsJob({
      graph: s.graph,
      reply: s.reply,
      trust: { ...trust, allowedTeamIds: new Set([TEAM, secondTeam]) },
    });
    await job(payload({ requestText: "findings 7" }), s.ctx);
    await job(payload({ teamId: secondTeam, requestText: "findings 7" }), s.ctx);
    expect(s.llm.calls.filter((call) => call.schemaName === "findings_map")).toHaveLength(2);
    const logs = JSON.stringify(s.ctx.log.mock.calls);
    for (const value of ["会議室", "田中", "https:"]) expect(logs).not.toContain(value);
  });

  it("Findingsの取得とAIも共通の固定失敗通知を使う", async () => {
    const s = setupFindings();
    s.graph.getChannel.mockRejectedValueOnce(new TeamsApiError(403));
    await s.job(payload({ requestText: "findings 7" }), s.ctx);
    expect(s.reply.mock.calls.at(-1)?.[1]).toContain("権限がありません");
    expect(s.llm.calls).toHaveLength(0);
    const llm = createFakeLlmProvider({
      findings_map: () => {
        throw new LlmError("content_filter", "secret");
      },
    });
    await s.job(payload({ mentionId: "102", requestText: "findings 7" }), { ...s.ctx, llm });
    expect(s.reply.mock.calls.at(-1)?.[1]).toContain(FILTERED_TEXT);
  });
});
function patch(): SummarizePatch {
  return {
    ...emptyPatch(),
    overview: [
      { ref: null, evidence: ["m1"], quote: "会議室を予約します", text: "予約を担当する" },
    ],
    todos: [
      {
        ref: null,
        evidence: ["m1"],
        quote: "会議室を予約します",
        text: "会議室の予約",
        assignee: "p1",
        due_iso: null,
        due_text: null,
        certainty: "explicit",
      },
    ],
  };
}
function setup(result = patch()) {
  const conversation: TeamsConversation = {
    messages: [
      {
        ts: TS,
        threadTs: null,
        userId: "user",
        text: "会議室を予約します",
        edited: false,
        reactions: [],
      },
    ],
    names: new Map([["user", "田中"]]),
    links: new Map([[TS, LINK]]),
    sourceIds: new Map([[TS, "100"]]),
    sourceRefs: new Map(),
  };
  const graph = {
    getThread: vi.fn(async () => conversation),
    getChannel: vi.fn(async () => conversation),
  };
  const reply = vi.fn(
    async (_p: TeamsJobPayload, _text: string): Promise<string | undefined> => "reply-id",
  );
  const store = createMemoryStore({ now: () => NOW });
  const llm = createFakeLlmProvider({
    summarize_patch: () => result,
    request_intent: () => ({
      intent: "summary",
      suppressTodo: false,
      suppressCanvas: false,
      period: null,
    }),
  });
  const ctx = { store, llm, now: () => NOW, log: vi.fn() };
  const job = createTeamsJob({ graph, reply, trust });
  return { conversation, graph, reply, store, llm, ctx, job };
}

describe("Teams 要約ジョブ", () => {
  it("カードupdate失敗の再試行は通常返信と分析を再実行しない", async () => {
    const s = setup();
    const p = payload({ requestText: "todo" });
    const source = s.conversation.messages[0];
    if (!source) throw new Error("必要なテスト値がありません");
    source.userId = p.userId;
    s.conversation.names = new Map([[p.userId, "田中"]]);
    s.conversation.sourceRefs.set(TS, { ...p, kind: "root", messageId: "100" });
    const writer = {
      create: vi.fn(),
      update: vi.fn().mockRejectedValueOnce(new TeamsApiError(503)).mockResolvedValue(undefined),
    };
    const work = { store: createMemoryTeamsWorkStore({ now: () => NOW }), now: () => NOW, writer };
    const job = createTeamsJob({ graph: s.graph, reply: s.reply, trust, work });
    await expect(job(p, s.ctx)).rejects.toMatchObject({ status: 503 });
    expect((await s.store.events.getRequestProgress(p.taskName))?.messages["summary:0"]).toBe(
      "reply-id",
    );
    const calls = s.llm.calls.length;
    s.graph.getThread.mockClear();
    s.reply.mockClear();
    await job(p, s.ctx);
    expect(s.llm.calls).toHaveLength(calls);
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(s.reply).not.toHaveBeenCalled();
    expect(writer.update).toHaveBeenCalledTimes(2);
  });
  it.each([
    { suppressTodo: true, suppressCanvas: true },
    { suppressTodo: true, suppressCanvas: false },
    { suppressTodo: false, suppressCanvas: true },
  ])("writer注入でもsummary抑止からカード副作用を新規予約しない: %j", async (flags) => {
    const s = setup();
    const p = payload({ requestText: "自然文のまとめ" });
    const source = s.conversation.messages[0];
    if (!source) throw new Error("必要なテスト値がありません");
    source.userId = p.userId;
    s.conversation.sourceRefs.set(TS, { ...p, kind: "root", messageId: "100" });
    const writer = { create: vi.fn(), update: vi.fn() };
    const work = { store: createMemoryTeamsWorkStore({ now: () => NOW }), now: () => NOW, writer };
    const reserve = vi.spyOn(work.store, "reserveEffect");
    const llm = createFakeLlmProvider({
      summarize_patch: () => patch(),
      request_intent: () => ({ intent: "summary", ...flags, period: null }),
    });
    const job = createTeamsJob({ graph: s.graph, reply: s.reply, trust, work });
    await job(p, { ...s.ctx, llm });
    expect(reserve).not.toHaveBeenCalled();
    expect(writer.update).not.toHaveBeenCalled();
    if (flags.suppressCanvas) expect(await work.store.getRecord(p)).toBeNull();
    if (flags.suppressCanvas && flags.suppressTodo)
      expect(await work.store.getSettings(p)).toBeNull();
  });
  it("work注入時にtodo/done/canvasを意図AIなしで接続し、台帳を表示する", async () => {
    const s = setup();
    const user = payload().userId;
    const source = s.conversation.messages[0];
    if (!source) throw new Error("必要なテストデータがありません");
    source.userId = user;
    s.conversation.names = new Map([[user, "田中"]]);
    s.conversation.sourceRefs.set(TS, {
      tenantId: TENANT,
      teamId: TEAM,
      channelId: payload().channelId,
      rootMessageId: "100",
      kind: "root",
      messageId: "100",
    });
    const work = { store: createMemoryTeamsWorkStore({ now: () => NOW }), now: () => NOW };
    const job = createTeamsJob({ graph: s.graph, reply: s.reply, trust, work });
    await job(payload({ requestText: "まとめ" }), s.ctx);
    expect(await work.store.getTodos(payload())).toHaveLength(1);
    expect(s.reply.mock.calls.at(-1)?.[1]).toContain("T1");
    expect(s.reply.mock.calls.at(-1)?.[1]).toContain("田中");
    expect(s.reply.mock.calls.at(-1)?.[1]).toContain(LINK);
    expect(s.reply.mock.calls.at(-1)?.[1]).not.toContain("未対応");
    expect(s.reply.mock.calls.at(-1)?.[1]).not.toContain("登録候補");
    const analysisCalls = s.llm.calls.filter(
      (call) => call.schemaName === "summarize_patch",
    ).length;
    await job(payload({ mentionId: "102", requestText: "done T1" }), s.ctx);
    expect((await work.store.getTodos(payload()))[0]?.status).toBe("done");
    expect(s.llm.calls.filter((call) => call.schemaName === "summarize_patch")).toHaveLength(
      analysisCalls,
    );
    await job(payload({ mentionId: "103", requestText: "todo" }), s.ctx);
    await job(payload({ mentionId: "104", requestText: "canvas" }), s.ctx);
    expect(s.llm.calls.filter((call) => call.schemaName === "request_intent")).toHaveLength(0);
  });
  it("共通抽出・根拠検証の結果を専用名前空間/TTLで保存し、元の依頼に返信する", async () => {
    const s = setup();
    const p = payload();
    const todo = vi.spyOn(s.store.todos, "upsert");
    const canvas = vi.spyOn(s.store.canvases, "set");
    await s.job(p, s.ctx);
    expect(s.graph.getThread).toHaveBeenCalledWith(TEAM, p.channelId, "100");
    expect(s.llm.calls).toHaveLength(1);
    const saved = await s.store.targets.get(teamsTargetId(p));
    expect(saved).toMatchObject({
      kind: "thread",
      channelId: teamsChannelKey(p),
      threadTs: "100",
      state: { overview: [{ evidence: [TS], needsReview: false }], todos: [{ assignee: "p1" }] },
    });
    expect(saved?.expireAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(s.reply.mock.calls[0]?.[0]).toEqual(p);
    const text = s.reply.mock.calls.map((c) => c[1]).join("\n");
    expect(text).toContain(LINK);
    expect(text).toContain("未対応");
    expect(todo).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
    expect(JSON.stringify(s.ctx.log.mock.calls)).not.toContain("会議室");
    expect(JSON.stringify(s.ctx.log.mock.calls)).not.toContain("田中");
    expect(JSON.stringify(s.ctx.log.mock.calls)).not.toContain("https:");
  });

  it("自然文は共通意図解釈を通し、保存済み分析を再利用せず毎回全量を分析する", async () => {
    const s = setup();
    await s.job(payload(), s.ctx);
    await s.job(payload({ mentionId: "102", requestText: "状況を整理して" }), s.ctx);
    expect(s.llm.calls.map((c) => c.schemaName)).toEqual([
      "summarize_patch",
      "request_intent",
      "summarize_patch",
    ]);
    expect(s.llm.calls[2]?.input).toContain("会議室を予約します");
    expect(s.llm.calls[2]?.input).not.toContain("v1 概要:");
  });

  it("tenant/team/channel/rootを分離し、channel keyはrootによらない", () => {
    const p = payload();
    expect(teamsTargetId(p)).toMatch(/^teams_[a-f0-9]{64}$/);
    expect(teamsChannelKey(p)).toMatch(/^teams_[a-f0-9]{64}$/);
    expect(teamsTargetId(p)).not.toBe(teamsChannelKey(p));
    for (const over of [
      { tenantId: TEAM },
      { teamId: TENANT },
      { channelId: "19:other@thread.tacv2" },
      { rootMessageId: "200" },
    ])
      expect(teamsTargetId(payload(over))).not.toBe(teamsTargetId(p));
    expect(teamsChannelKey(payload({ rootMessageId: "200" }))).toBe(teamsChannelKey(p));
  });

  it.each([
    { tenantId: TEAM },
    { teamId: TENANT },
    { serviceUrl: "https://evil.test/" },
    { conversationId: "19:other@thread.tacv2" },
    { taskName: "forged" },
  ])("不正payloadでは全副作用を止める %j", async (over) => {
    const s = setup();
    const progress = vi.spyOn(s.store.events, "getRequestProgress");
    await expect(s.job({ ...payload(), ...over }, s.ctx)).rejects.toBeInstanceOf(TypeError);
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(s.reply).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(s.llm.calls).toHaveLength(0);
  });

  it.each([401, 403, 404, 422])(
    "取得の恒久エラー%sは固定返信して分析を中止する",
    async (status) => {
      const s = setup();
      s.graph.getThread.mockRejectedValue(new TeamsApiError(status));
      await s.job(payload(), s.ctx);
      expect(s.reply.mock.calls[0]?.[1]).toContain(new TeamsApiError(status).message);
      expect(s.llm.calls).toHaveLength(0);
      expect(await s.store.targets.get(teamsTargetId(payload()))).toBeNull();
    },
  );

  it.each([0, 429, 503])("取得の一時エラー%sはworkerへ伝播する", async (status) => {
    const s = setup();
    const error = new TeamsApiError(status);
    s.graph.getThread.mockRejectedValue(error);
    await expect(s.job(payload(), s.ctx)).rejects.toBe(error);
    expect(s.reply).not.toHaveBeenCalled();
  });

  it("安全フィルタだけ固定通知し、他のLLMエラーはworkerへ伝播する", async () => {
    const s = setup();
    const filtered = createFakeLlmProvider({
      summarize_patch: () => {
        throw new LlmError("content_filter", "secret");
      },
    });
    await s.job(payload(), { ...s.ctx, llm: filtered });
    expect(s.reply.mock.calls[0]?.[1]).toContain(FILTERED_TEXT);
    const error = new LlmError("server", "secret");
    const failed = createFakeLlmProvider({
      summarize_patch: () => {
        throw error;
      },
    });
    await expect(s.job(payload({ mentionId: "102" }), { ...s.ctx, llm: failed })).rejects.toBe(
      error,
    );
  });

  it("成功済みの同じ依頼では返信・分析を繰り返さない", async () => {
    const s = setup();
    await s.job(payload(), s.ctx);
    await s.job(payload(), s.ctx);
    expect(s.reply).toHaveBeenCalledTimes(1);
    expect(s.llm.calls).toHaveLength(1);
  });

  it("複数返信の途中失敗は保存済みslotを飛ばして再開する", async () => {
    const result = emptyPatch();
    result.questions = Array.from({ length: 45 }, (_, i) => ({
      ref: null,
      evidence: ["m1"],
      quote: "会議室を予約します",
      text: `問い${i} ${"あ".repeat(350)}`,
    }));
    const s = setup(result);
    const error = new Error("送信失敗");
    s.reply.mockResolvedValueOnce("first-id").mockRejectedValueOnce(error);
    await expect(s.job(payload(), s.ctx)).rejects.toBe(error);
    const first = s.reply.mock.calls[0]?.[1];
    await s.job(payload(), s.ctx);
    expect(s.reply.mock.calls.filter((c) => c[1] === first)).toHaveLength(1);
    expect((await s.store.events.getRequestProgress(payload().taskName))?.stages.reply).toBe(
      "done",
    );
  });
});

function progressInput(over: Record<string, unknown> = {}): RequestProgressInput {
  const p = payload();
  return {
    targetId: teamsTargetId(p),
    channelId: teamsChannelKey(p),
    threadTs: p.rootMessageId,
    mentionTs: p.mentionId,
    stages: { todos: "skipped", canvas: "skipped" },
    messages: {},
    ...over,
  } as RequestProgressInput;
}

describe("Teams 返信snapshot", () => {
  it("途中失敗後に取得・AIの結果が変わっても、保存した残りの返信だけを再送する", async () => {
    const result = emptyPatch();
    result.questions = Array.from({ length: 45 }, (_, i) => ({
      ref: null,
      evidence: ["m1"],
      quote: "会議室を予約します",
      text: `元の問い${i} ${"あ".repeat(350)}`,
    }));
    const s = setup(result);
    const targetSave = vi.spyOn(s.store.targets, "put");
    const cacheGet = vi.spyOn(s.store.chunkCache, "get");
    const cachePut = vi.spyOn(s.store.chunkCache, "put");
    const error = new Error("途中失敗");
    s.reply.mockResolvedValueOnce("first-id").mockRejectedValueOnce(error);
    await expect(s.job(payload(), s.ctx)).rejects.toBe(error);
    const saved = await s.store.events.getRequestProgress(payload().taskName);
    expect(saved?.replyChunks?.length).toBeGreaterThan(1);
    expect(saved?.messages).toEqual({ "summary:0": "first-id" });
    const originalChunks = saved?.replyChunks;
    if (originalChunks === undefined) throw new Error("snapshotなし");
    expect(s.reply.mock.calls[0]?.[1]).toBe(originalChunks[0]);
    expect(s.reply.mock.calls[1]?.[1]).toBe(originalChunks[1]);
    s.graph.getThread.mockRejectedValue(new Error("取得を再実行してはいけない"));
    s.graph.getThread.mockClear();
    s.reply.mockClear();
    targetSave.mockClear();
    cacheGet.mockClear();
    cachePut.mockClear();
    const changedLlm = createFakeLlmProvider({
      summarize_patch: () => ({
        ...emptyPatch(),
        questions: [{ ref: null, evidence: ["m1"], quote: "変わった", text: "変わった問い" }],
      }),
    });
    await s.job(payload(), { ...s.ctx, llm: changedLlm });
    expect(s.reply.mock.calls.map((call) => call[1])).toEqual(originalChunks.slice(1));
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(s.graph.getChannel).not.toHaveBeenCalled();
    expect(changedLlm.calls).toHaveLength(0);
    expect(targetSave).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("最初の送信前にsnapshotを保存し、その保存に失敗すれば投稿しない", async () => {
    const s = setup();
    const error = new Error("snapshot保存失敗");
    vi.spyOn(s.store.events, "saveRequestProgress").mockRejectedValueOnce(error);
    await expect(s.job(payload(), s.ctx)).rejects.toBe(error);
    expect(s.reply).not.toHaveBeenCalled();
  });

  it("生成した返信のJSON UTF-8全体が256KiBを超えれば投稿しない", async () => {
    const result = emptyPatch();
    result.questions = Array.from({ length: 300 }, (_, i) => ({
      ref: null,
      evidence: ["m1"],
      quote: "会議室を予約します",
      text: `問い${i} ${"あ".repeat(350)}`,
    }));
    const s = setup(result);
    await expect(s.job(payload(), s.ctx)).rejects.toBeInstanceOf(RangeError);
    expect(s.reply).not.toHaveBeenCalled();
    expect(await s.store.events.getRequestProgress(payload().taskName)).toBeNull();
  });

  it.each([
    { name: "空配列", value: [] },
    { name: "null", value: null },
    { name: "数値chunk", value: [123] },
    { name: "空chunk", value: [""] },
    { name: "空白chunk", value: ["   "] },
    { name: "欠損chunk", value: new Array(1) },
    { name: "8001UTF16", value: ["a".repeat(8001)] },
    { name: "UTF8合計超過", value: Array.from({ length: 20 }, () => "あ".repeat(7000)) },
  ])("不正または上限超過の保存snapshot $name では外部処理を止める", async ({ value }) => {
    const s = setup();
    await s.store.events.saveRequestProgress(
      payload().taskName,
      progressInput({ replyChunks: value }),
    );
    await expect(s.job(payload(), s.ctx)).rejects.toThrow();
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(s.llm.calls).toHaveLength(0);
  });

  it("送信slotだけが残りsnapshotがない進捗は、再分析せず停止する", async () => {
    const s = setup();
    await s.store.events.saveRequestProgress(
      payload().taskName,
      progressInput({ messages: { "summary:0": "posted" } }),
    );
    await expect(s.job(payload(), s.ctx)).rejects.toBeInstanceOf(TypeError);
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(s.llm.calls).toHaveLength(0);
  });

  it("doneの再配信は読み取った進捗以外に副作用を起こさない", async () => {
    const s = setup();
    await s.store.events.saveRequestProgress(
      payload().taskName,
      progressInput({
        replyChunks: ["保存した結果"],
        messages: { "summary:0": "posted" },
        stages: { reply: "done" },
      }),
    );
    const save = vi.spyOn(s.store.events, "saveRequestProgress");
    const targets = vi.spyOn(s.store.targets, "put");
    const cache = vi.spyOn(s.store.chunkCache, "put");
    await s.job(payload(), s.ctx);
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.graph.getThread).not.toHaveBeenCalled();
    expect(s.graph.getChannel).not.toHaveBeenCalled();
    expect(s.llm.calls).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(targets).not.toHaveBeenCalled();
    expect(cache).not.toHaveBeenCalled();
  });
});
