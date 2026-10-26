import { createRequire } from "node:module";
import inject from "light-my-request";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createFakeLlmProvider } from "../../src/llm/fake.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { issueTeamsAction, TEAMS_ACTION_PATH } from "../../src/teams/actions.js";
import { createTeamsGraphReader, TeamsApiError } from "../../src/teams/graph.js";
import { dispatchTeamsMessage, TEAMS_JOB_PATH, teamsTaskName } from "../../src/teams/ingress.js";
import { teamsChannelKey, teamsTargetId } from "../../src/teams/job.js";
import { renderTeamsRecordSnapshot } from "../../src/teams/records.js";
import {
  createTeamsApp,
  createTeamsRecordVerifier,
  createTeamsRecordWriter,
  createTeamsReply,
  createTeamsSdk,
  createTeamsWorker,
} from "../../src/teams/runtime.js";
import type { TeamsSharePointClient } from "../../src/teams/sharepoint.js";
import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";
const channelId = "19:channel@thread.tacv2";
const userId = "44444444-4444-4444-8444-444444444444";
const trust = { appId, tenantId, allowedTeamIds: new Set([teamId]) };
describe("W09の起動と定期修復", () => {
  const now = () => new Date("2026-10-26T00:00:00Z");
  const scope = { tenantId, teamId, channelId, rootMessageId: "1700000000000" };
  async function setup(
    flags: Record<string, string> = {},
    sharepointClient?: TeamsSharePointClient,
  ) {
    const work = createMemoryTeamsWorkStore({ now, renderSnapshot: renderTeamsRecordSnapshot });
    const human = { scope, actorAadId: userId, now: now() };
    await work.ensureSettings({
      ...human,
      reference: { serviceUrl: activity().serviceUrl, conversationId: channelId },
    });
    await work.reserveRecord({
      ...human,
      expectedRevision: 0,
      snapshot: { scope, revision: 1, slots: ["記録"], todos: [] },
    });
    const writer = {
      create: vi.fn().mockResolvedValue({ activityId: "managed-id" }),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const store = createMemoryStore();
    const reply = vi.fn().mockResolvedValue("summary-id");
    const llm = createFakeLlmProvider();
    const graph = { getThread: vi.fn(), getChannel: vi.fn() };
    const verifyActivity = vi.fn().mockResolvedValue({ scope, botOwned: true });
    const worker = createTeamsWorker({
      config: config(flags),
      store,
      llm,
      now,
      graph,
      reply,
      work: { store: work, writer, verifyActivity, sharepointClient },
    });
    const enqueue = vi.fn().mockResolvedValue({ created: true });
    await dispatchTeamsMessage(activity(), { ...trust, enqueue, now });
    const payload = enqueue.mock.calls[0]?.[0].payload;
    return { work, worker, writer, store, reply, llm, graph, payload, verifyActivity };
  }
  it("全フラグoffでは注入storeがあっても管理ルートを登録しない", async () => {
    const s = await setup();
    for (const url of [TEAMS_ACTION_PATH, "/cron/teams-reminders", "/cron/teams-repair"]) {
      expect(
        (await inject(s.worker.handle, { method: "POST", url, payload: { platform: "teams" } }))
          .statusCode,
      ).toBe(404);
    }
  });
  it("修復cronはplatform検査を先に行い、taskNameなしで毎回最新revisionを修復する", async () => {
    const s = await setup({ TEAMS_RECORD_MODE: "message" });
    const dedupe = vi.spyOn(s.store.events, "markProcessed");
    expect(
      (
        await inject(s.worker.handle, {
          method: "POST",
          url: "/cron/teams-repair",
          payload: { platform: "slack" },
        })
      ).statusCode,
    ).toBe(400);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await inject(s.worker.handle, {
            method: "POST",
            url: "/cron/teams-repair",
            payload: { platform: "teams" },
          })
        ).statusCode,
      ).toBe(200);
    expect(s.writer.create).toHaveBeenCalledOnce();
    expect(s.writer.update).toHaveBeenCalledOnce();
    expect(dedupe).not.toHaveBeenCalled();
    expect((await s.work.getRecord(scope))?.slots[0]?.activityId).toBe("managed-id");
  });
  it("記録offとdisabledは新規送信せず、通知cronは再試行を維持する", async () => {
    const off = await setup({ TEAMS_TODO_ENABLED: "true" });
    expect(
      (
        await inject(off.worker.handle, {
          method: "POST",
          url: "/cron/teams-repair",
          payload: { platform: "teams" },
        })
      ).statusCode,
    ).toBe(200);
    expect(off.writer.create).not.toHaveBeenCalled();
    const s = await setup({ TEAMS_RECORD_MODE: "message" });
    await s.work.disableThread({ scope, now: now() });
    expect(
      (
        await inject(s.worker.handle, {
          method: "POST",
          url: "/cron/teams-repair",
          payload: { platform: "teams" },
        })
      ).statusCode,
    ).toBe(200);
    expect(s.writer.create).not.toHaveBeenCalled();
  });
  it("修復は別scopeを継続し、一時失敗を最後に失敗HTTPへ返す", async () => {
    const s = await setup({ TEAMS_RECORD_MODE: "message" });
    const other = { ...scope, rootMessageId: "other" };
    const human = { scope: other, actorAadId: userId, now: now() };
    await s.work.ensureSettings({
      ...human,
      reference: { serviceUrl: activity().serviceUrl, conversationId: channelId },
    });
    await s.work.reserveRecord({
      ...human,
      expectedRevision: 0,
      snapshot: { scope: other, revision: 1, slots: ["別記録"], todos: [] },
    });
    await inject(s.worker.handle, {
      method: "POST",
      url: "/cron/teams-repair",
      payload: { platform: "teams" },
    });
    s.writer.update.mockRejectedValueOnce(new TeamsApiError(503));
    const res = await inject(s.worker.handle, {
      method: "POST",
      url: "/cron/teams-repair",
      payload: { platform: "teams" },
    });
    expect(res.statusCode).toBe(500);
    expect(s.writer.create).toHaveBeenCalledTimes(2);
    expect((await s.work.getRecord(other))?.progress.teams).toBe("applied");
    await inject(s.worker.handle, {
      method: "POST",
      url: "/cron/teams-repair",
      payload: { platform: "teams" },
    });
    expect(s.writer.create).toHaveBeenCalledTimes(2);
  });
  it("recordのみ有効でもToDoは自動登録せず、todoのみ有効なら記録を予約・送信しない", async () => {
    const configurations: Record<string, string>[] = [
      { TEAMS_RECORD_MODE: "message" },
      { TEAMS_TODO_ENABLED: "true" },
    ];
    for (const flags of configurations) {
      const now = () => new Date("2026-10-26T00:00:00Z");
      const work = createMemoryTeamsWorkStore({ now, renderSnapshot: renderTeamsRecordSnapshot });
      const register = vi.spyOn(work, "register");
      const reserve = vi.spyOn(work, "reserveRecord");
      const writer = {
        create: vi.fn().mockResolvedValue({ activityId: "record" }),
        update: vi.fn(),
      };
      const stamp = "1792972800.000000";
      const conversation = {
        messages: [
          {
            ts: stamp,
            text: "合成作業を実行します",
            userId,
            threadTs: null,
            edited: false,
            reactions: [],
          },
        ],
        names: new Map([[userId, "担当者"]]),
        links: new Map([[stamp, "https://teams.microsoft.com/l/message/channel/root"]]),
        sourceIds: new Map([[stamp, scope.rootMessageId]]),
        sourceRefs: new Map([
          [stamp, { ...scope, kind: "root" as const, messageId: scope.rootMessageId }],
        ]),
      };
      const llm = createFakeLlmProvider({
        summarize_patch: () => ({
          overview: [
            { ref: null, text: "合成作業を実行", evidence: ["m1"], quote: "合成作業を実行します" },
          ],
          topics: [],
          responses: [],
          statements: [],
          todos: [
            {
              ref: null,
              text: "合成作業を実行",
              assignee: "p1",
              due_iso: null,
              due_text: null,
              evidence: ["m1"],
              quote: "合成作業を実行します",
              certainty: "explicit",
            },
          ],
          questions: [],
          close: [],
        }),
      });
      const reply = vi.fn().mockResolvedValue("summary-id");
      const enqueue = vi.fn().mockResolvedValue({ created: true });
      await dispatchTeamsMessage(activity(), { ...trust, enqueue, now });
      const payload = enqueue.mock.calls[0]?.[0].payload;
      const store = createMemoryStore();
      const worker = createTeamsWorker({
        config: config(flags),
        work: { store: work, writer },
        store,
        llm,
        now,
        reply,
        graph: { getThread: vi.fn().mockResolvedValue(conversation), getChannel: vi.fn() },
      });
      const response = await inject(worker.handle, {
        method: "POST",
        url: TEAMS_JOB_PATH,
        payload,
      });
      expect(response.statusCode).toBe(200);
      if (flags.TEAMS_RECORD_MODE) {
        expect(register).not.toHaveBeenCalled();
        expect(reserve).toHaveBeenCalledOnce();
        expect(writer.create).toHaveBeenCalledOnce();
      } else {
        expect(register).toHaveBeenCalledOnce();
        expect(reserve).not.toHaveBeenCalled();
        expect(writer.create).not.toHaveBeenCalled();
        expect(await work.getRecord(scope)).toBeNull();
      }
    }
  });
  it("旧summary進捗は管理投稿IDへ流用せず、新しい失敗進捗だけ通常返信後も修復する", async () => {
    const s = await setup({ TEAMS_RECORD_MODE: "message" });
    const progress = {
      targetId: teamsTargetId(s.payload),
      channelId: teamsChannelKey(s.payload),
      threadTs: s.payload.rootMessageId,
      mentionTs: s.payload.mentionId,
      stages: { reply: "done" as const, canvas: "skipped" as "skipped" | "failed" },
      messages: { "summary:0": "legacy-normal-id" },
      replyChunks: ["既送信"],
    };
    await s.store.events.saveRequestProgress(s.payload.taskName, progress);
    const request = {
      method: "POST" as const,
      url: TEAMS_JOB_PATH,
      payload: s.payload,
      headers: { "x-cloudtasks-taskretrycount": "1" },
    };
    expect((await inject(s.worker.handle, request)).statusCode).toBe(200);
    expect(s.writer.create).not.toHaveBeenCalled();
    expect(s.writer.update).not.toHaveBeenCalled();
    progress.stages.canvas = "failed";
    await s.store.events.saveRequestProgress(s.payload.taskName, progress);
    await inject(s.worker.handle, request);
    expect(s.writer.create).toHaveBeenCalledOnce();
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.llm.calls).toHaveLength(0);
    expect(s.graph.getThread).not.toHaveBeenCalled();
    s.writer.update.mockRejectedValueOnce(new TeamsApiError(503));
    // 同revisionの既知ID更新だけをretryし、通常返信を再投稿しない。
    const record = await s.work.getRecord(scope);
    if (!record) throw new Error("必要な記録がありません");
    await s.work.reserveRecord({
      scope,
      actorAadId: userId,
      now: now(),
      expectedRevision: record.desiredRevision,
      snapshot: { ...record.snapshot, revision: record.desiredRevision + 1 },
    });
    expect((await inject(s.worker.handle, request)).statusCode).toBe(500);
    expect((await inject(s.worker.handle, request)).statusCode).toBe(200);
    expect(s.reply).not.toHaveBeenCalled();
  });
  it("managerは認証済み元scopeから明示復旧し、他actor・旧版・任意URLを拒否する", async () => {
    const s = await setup({ TEAMS_RECORD_MODE: "message" });
    s.writer.create.mockRejectedValueOnce(new TeamsApiError(0));
    await inject(s.worker.handle, {
      method: "POST",
      url: "/cron/teams-repair",
      payload: { platform: "teams" },
    });
    const request = async (text: string, mentionId: string, actor = userId) => {
      const payload = { ...s.payload, requestText: text, mentionId, userId: actor };
      payload.taskName = teamsTaskName(payload);
      return inject(s.worker.handle, { method: "POST", url: TEAMS_JOB_PATH, payload });
    };
    await request("record status", "2");
    expect(s.reply.mock.calls.flat().join("\n")).toContain("revision=1");
    await request("record relink 1 0 found-id", "3", appId);
    expect(s.verifyActivity).not.toHaveBeenCalled();
    await request("record relink 2 0 found-id", "4");
    expect(s.verifyActivity).not.toHaveBeenCalled();
    await request("record relink 1 0 https://evil.example/", "5");
    expect(s.verifyActivity).not.toHaveBeenCalled();
    await request("record relink 1 0 found-id", "6");
    expect(s.verifyActivity).toHaveBeenCalledWith(expect.objectContaining(scope), "found-id");
    expect(s.writer.update).toHaveBeenCalledWith(
      expect.objectContaining(scope),
      expect.anything(),
      "found-id",
      expect.anything(),
    );
    expect(s.llm.calls).toHaveLength(0);
  });
  it("record statusは長いactivityIdを持つ全slotを8000文字以下の返信に分割する", async () => {
    const s = await setup({ TEAMS_RECORD_MODE: "message" });
    await s.work.reserveRecord({
      scope,
      actorAadId: userId,
      now: now(),
      expectedRevision: 1,
      snapshot: {
        scope,
        revision: 2,
        slots: Array.from({ length: 20 }, (_, index) => `表示${index}`),
        todos: [],
      },
    });
    let serial = 0;
    s.writer.create.mockImplementation(async () => ({
      activityId: String(++serial).padEnd(512, "a"),
    }));
    await inject(s.worker.handle, {
      method: "POST",
      url: "/cron/teams-repair",
      payload: { platform: "teams" },
    });
    await inject(s.worker.handle, {
      method: "POST",
      url: TEAMS_JOB_PATH,
      payload: { ...s.payload, requestText: "record status" },
    });
    const messages = s.reply.mock.calls.map((call) => String(call[1]));
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 8000)).toBe(true);
    const slots = messages
      .join("\n")
      .split("\n")
      .filter((line) => line.startsWith("slot="));
    expect(slots).toHaveLength(20);
    for (let index = 0; index < 20; index++)
      expect(slots[index]).toBe(
        `slot=${index} state=applied activityId=${String(index + 1).padEnd(512, "a")}`,
      );
  });
  it("アプリ削除はSDK認証後だけ同tenant/teamを停止し、再導入で自動解除しない", async () => {
    const s = await setup({ TEAMS_TODO_ENABLED: "true" });
    const runtime = createTeamsApp(config({ TEAMS_TODO_ENABLED: "true" }), {
      enqueue: vi.fn(),
      now,
      work: { store: s.work },
    });
    await runtime.app.initialize();
    const removal = {
      ...activity(),
      type: "installationUpdate",
      action: "remove",
      entities: [],
      text: "",
    };
    expect(
      (await inject(runtime.handle, { method: "POST", url: "/api/messages", payload: removal }))
        .statusCode,
    ).toBe(401);
    expect((await s.work.getSettings(scope))?.disabled).toBe(false);
    const server = runtime.app.server as unknown as {
      authorize: (...args: unknown[]) => Promise<unknown>;
    };
    vi.spyOn(server, "authorize").mockResolvedValue({
      success: true,
      token: {
        appId,
        tenantId,
        serviceUrl: activity().serviceUrl,
        from: "azure",
        fromId: "https://api.botframework.com",
        isExpired: () => false,
        toString: () => "synthetic",
      },
    });
    await inject(runtime.handle, {
      method: "POST",
      url: "/api/messages",
      payload: { ...removal, channelData: { ...removal.channelData, tenant: { id: appId } } },
    });
    expect((await s.work.getSettings(scope))?.disabled).toBe(false);
    await inject(runtime.handle, { method: "POST", url: "/api/messages", payload: removal });
    expect((await s.work.getSettings(scope))?.disabled).toBe(true);
    await inject(runtime.handle, {
      method: "POST",
      url: "/api/messages",
      payload: { ...removal, action: "add" },
    });
    expect((await s.work.getSettings(scope))?.disabled).toBe(true);
  });
  it("通知cronは元scopeで日次予約し429のRetry-After中は再送しない", async () => {
    const s = await setup({ TEAMS_TODO_ENABLED: "true", TEAMS_REMINDERS_ENABLED: "true" });
    await s.work.register({
      scope,
      actorAadId: userId,
      now: now(),
      requestId: "notification-todo",
      mode: "new",
      recordPolicy: "none",
      candidate: {
        text: "通知対象",
        assigneeAadId: userId,
        dueIso: null,
        dueText: null,
        certainty: "explicit",
        needsReview: false,
        closed: false,
        evidence: [
          {
            ref: { ...scope, kind: "root", messageId: scope.rootMessageId },
            quote: "通知対象",
            link: "https://teams.microsoft.com/l/message/channel/root",
            sourceCreatedAt: now().toISOString(),
          },
        ],
      },
    });
    await s.work.setNotifications({ scope, actorAadId: userId, now: now(), enabled: true });
    s.writer.create.mockRejectedValueOnce(new TeamsApiError(429, 120000));
    const request = {
      method: "POST" as const,
      url: "/cron/teams-reminders",
      payload: { platform: "teams" },
    };
    expect((await inject(s.worker.handle, request)).statusCode).toBe(500);
    expect((await inject(s.worker.handle, request)).statusCode).toBe(500);
    expect(s.writer.create).toHaveBeenCalledOnce();
    expect(s.writer.create.mock.calls[0]?.[0]).toMatchObject(scope);
  });
  it("SharePointの404はTeams投稿成功・通知設定を巻き戻さずSPの失敗だけ保存する", async () => {
    const client = {
      findByKey: vi.fn().mockRejectedValue(new TeamsApiError(404)),
      get: vi.fn(),
      create: vi.fn(),
      patch: vi.fn(),
    };
    const binding = {
      tenantId,
      teamId,
      channelId,
      siteId: "site",
      listId: "list",
      verified: {
        selected: true,
        listWrite: true,
        get: true,
        search: true,
        post: true,
        patch: true,
        precondition: true,
        otherListDenied: true,
        sameAudience: true,
      },
    };
    const s = await setup(
      { TEAMS_RECORD_MODE: "sharepoint", TEAMS_SHAREPOINT_BINDINGS: JSON.stringify([binding]) },
      client,
    );
    await s.work.setNotifications({ scope, actorAadId: userId, now: now(), enabled: true });
    expect(
      (
        await inject(s.worker.handle, {
          method: "POST",
          url: "/cron/teams-repair",
          payload: { platform: "teams" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await s.work.getRecord(scope))?.progress.teams).toBe("applied");
    expect((await s.work.getRecord(scope))?.sharepoint?.state).toBe("failed");
    expect(await s.work.getSettings(scope)).toMatchObject({
      disabled: false,
      notificationsEnabled: true,
    });
  });
  it("削除済み管理slotはcronでは再作成せず、明示todoだけで再作成する", async () => {
    const s = await setup({ TEAMS_TODO_ENABLED: "true", TEAMS_RECORD_MODE: "message" });
    const cron = {
      method: "POST" as const,
      url: "/cron/teams-repair",
      payload: { platform: "teams" },
    };
    await inject(s.worker.handle, cron);
    s.writer.update.mockRejectedValueOnce(new TeamsApiError(404));
    await inject(s.worker.handle, cron);
    expect((await s.work.getRecord(scope))?.slots[0]?.state).toBe("deleted");
    await inject(s.worker.handle, cron);
    expect(s.writer.create).toHaveBeenCalledOnce();
    s.graph.getThread.mockResolvedValue({
      messages: [],
      names: new Map(),
      links: new Map(),
      sourceIds: new Map(),
      sourceRefs: new Map(),
    });
    const payload = { ...s.payload, requestText: "todo" };
    await inject(s.worker.handle, { method: "POST", url: TEAMS_JOB_PATH, payload });
    expect(s.writer.create).toHaveBeenCalledTimes(2);
  });
  it("SharePoint導入ゲート未達なら外部clientへ触れず、管理者の再同期も拒否する", async () => {
    const client = { findByKey: vi.fn(), get: vi.fn(), create: vi.fn(), patch: vi.fn() };
    const binding = {
      tenantId,
      teamId,
      channelId,
      siteId: "site",
      listId: "list",
      verified: {
        selected: false,
        listWrite: true,
        get: true,
        search: true,
        post: true,
        patch: true,
        precondition: true,
        otherListDenied: true,
        sameAudience: true,
      },
    };
    const s = await setup(
      { TEAMS_RECORD_MODE: "sharepoint", TEAMS_SHAREPOINT_BINDINGS: JSON.stringify([binding]) },
      client,
    );
    await inject(s.worker.handle, {
      method: "POST",
      url: "/cron/teams-repair",
      payload: { platform: "teams" },
    });
    await inject(s.worker.handle, {
      method: "POST",
      url: TEAMS_JOB_PATH,
      payload: { ...s.payload, requestText: "record resync 1 acknowledge-generated-overwrite" },
    });
    expect(client.findByKey).not.toHaveBeenCalled();
    expect(s.reply.mock.calls.map((call) => call[1]).join("\n")).toContain("external_not_verified");
    expect((await s.work.getRecord(scope))?.progress.teams).toBe("applied");
  });
});
describe("管理投稿SDK writer", () => {
  it("通知送信のSDK 429からRetry-Afterを安全に保持する", async () => {
    const app = createTeamsSdk(config());
    const createActivity = vi
      .fn()
      .mockRejectedValue({ response: { status: 429, headers: { "retry-after": "120" } } });
    vi.spyOn(app.api, "fromServiceUrl").mockReturnValue({
      conversations: { createActivity },
    } as never);
    const writer = createTeamsRecordWriter(app, trust);
    await expect(
      writer.create(
        { tenantId, teamId, channelId, rootMessageId: "root" },
        { serviceUrl: activity().serviceUrl, conversationId: channelId },
        { text: "通知" },
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
  });
  it("再関連付けは固定Graph経路からbot所有を外部照合する", async () => {
    const scope = { tenantId, teamId, channelId, rootMessageId: "root" };
    const message = {
      id: "found",
      replyToId: "root",
      channelIdentity: { teamId, channelId },
      from: { application: { id: appId, applicationIdentityType: "bot" }, user: null },
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(message)));
    const verify = createTeamsRecordVerifier({
      ...trust,
      token: async () => "synthetic",
      fetch: fetcher,
    });
    expect(await verify(scope, "found")).toEqual({ scope, botOwned: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${encodeURIComponent(channelId)}/messages/root/replies/found`,
    );
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...message,
          from: { application: { id: appId, applicationIdentityType: "outgoingWebhook" } },
        }),
      ),
    );
    await expect(verify(scope, "found")).rejects.toMatchObject({ code: "unauthorized" });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...message, replyToId: "other" })));
    await expect(verify(scope, "found")).rejects.toMatchObject({ code: "invalid_scope" });
  });
  it("create/updateを分け、認証済みreferenceと必須IDを検査する", async () => {
    const app = createTeamsSdk(config());
    const createActivity = vi.fn().mockResolvedValue({ id: "managed" });
    const updateActivity = vi.fn().mockResolvedValue(undefined);
    const api = vi
      .spyOn(app.api, "fromServiceUrl")
      .mockReturnValue({ conversations: { createActivity, updateActivity } } as never);
    const writer = createTeamsRecordWriter(app, trust);
    const scope = { tenantId, teamId, channelId, rootMessageId: "root" };
    const reference = {
      serviceUrl: activity().serviceUrl,
      conversationId: `${channelId};messageid=root`,
    };
    expect(await writer.create(scope, reference, { text: "managed" })).toEqual({
      activityId: "managed",
    });
    await writer.update(scope, reference, "managed", {
      text: "changed",
      card: { type: "AdaptiveCard", version: "1.5", body: [] },
    });
    expect(createActivity).toHaveBeenCalledOnce();
    expect(updateActivity).toHaveBeenCalledWith(
      reference.conversationId,
      "managed",
      expect.objectContaining({ text: "changed", attachments: expect.any(Array) }),
    );
    createActivity.mockResolvedValue({});
    await expect(writer.create(scope, reference, { text: "x" })).rejects.toMatchObject({
      code: "delivery_unknown",
    });
    await expect(
      writer.create(scope, { ...reference, serviceUrl: "https://evil.example/" }, { text: "x" }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(writer.update(scope, reference, "", { text: "x" })).rejects.toMatchObject({
      code: "invalid_evidence",
    });
    expect(api).toHaveBeenCalledTimes(3);
  });
});
function config(overrides: Record<string, string> = {}) {
  const c = loadConfig({
    CHAT_PLATFORM: "teams",
    APP_ROLE: "worker",
    TEAMS_APP_ID: appId,
    TEAMS_APP_SECRET: "synthetic-secret",
    TEAMS_TENANT_ID: tenantId,
    TEAMS_ALLOWED_TEAM_IDS: teamId,
    GCP_PROJECT: "test",
    TASKS_QUEUE: "test",
    TASKS_LOCATION: "test",
    TASKS_INVOKER_SA: "test@example.test",
    LLM_PROVIDER: "fake",
    ...overrides,
  });
  if (c.CHAT_PLATFORM !== "teams") throw new Error("invalid test config");
  return c;
}
function activity() {
  return {
    type: "message",
    id: "1700000000001",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/jp/",
    text: "<at>Arbalest</at>",
    from: { id: "29:person", aadObjectId: userId },
    recipient: { id: `28:${appId}` },
    conversation: { id: `${channelId};messageid=1700000000000`, conversationType: "channel" },
    replyToId: "1700000000000",
    channelData: {
      tenant: { id: tenantId },
      team: { aadGroupId: teamId },
      channel: { id: channelId },
    },
    entities: [{ type: "mention", text: "<at>Arbalest</at>", mentioned: { id: `28:${appId}` } }],
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Teams SDK の境界", () => {
  it("環境変数が匿名許可を要求してもHTTPのJWT必須を維持する", async () => {
    vi.stubEnv("DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS", "true");
    const enqueue = vi.fn().mockResolvedValue({ created: true });
    const runtime = createTeamsApp(config(), { enqueue });
    await runtime.app.initialize();
    const response = await inject(runtime.handle, {
      method: "POST",
      url: "/api/messages",
      payload: activity(),
    });
    expect(response.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("不正JSONの例外へ混じった本文をHTTP応答や既定エラーログへ出さない", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const enqueue = vi.fn();
    const runtime = createTeamsApp(config(), { enqueue });
    await runtime.app.initialize();
    const response = await inject(runtime.handle, {
      method: "POST",
      url: "/api/messages",
      headers: { "content-type": "application/json" },
      payload: '{"synthetic-private-text"',
    });
    expect(response.statusCode).toBe(400);
    expect(response.payload).toBe("invalid request");
    expect(enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("synthetic-private-text");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("synthetic-private-text");
  });

  it("SDKが認証を終えたmessageをキューへ渡し、投入失敗は5xxを返す", async () => {
    const enqueue = vi.fn().mockResolvedValue({ created: true });
    const runtime = createTeamsApp(config(), { enqueue });
    await runtime.app.initialize();
    // 公開HTTPアダプタはtokenを設定しない。ここだけ認証済みtransportを模擬する。
    const request = {
      body: activity(),
      headers: {},
      token: {
        appId,
        tenantId,
        serviceUrl: activity().serviceUrl,
        from: "azure" as const,
        fromId: "https://api.botframework.com",
        isExpired: () => false,
        toString: () => "synthetic",
      },
    };
    const accepted = await runtime.app.server.handleRequest(request);
    expect(accepted.status).toBe(200);
    expect(enqueue).toHaveBeenCalledOnce();
    enqueue.mockRejectedValue(new Error("queue unavailable"));
    const failed = await runtime.app.server.handleRequest(request);
    expect(failed.status).toBe(500);
  });

  it("HTTPでJWTなし・不正JWTを拒否しキューへ渡さない", async () => {
    const enqueue = vi.fn();
    const runtime = createTeamsApp(config(), { enqueue });
    await runtime.app.initialize();
    for (const headers of [{}, { authorization: "Bearer invalid.jwt.value" }]) {
      const res = await inject(runtime.handle, {
        method: "POST",
        url: "/api/messages",
        headers,
        payload: activity(),
      });
      expect(res.statusCode).toBe(401);
    }
    const health = await inject(runtime.handle, { method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("SDKと修正版MSALのclient-credentials APIが接続できる", async () => {
    // SDK内部と同じCJSの依存を使う。ネットワーク通信は置き換える。
    const require = createRequire(import.meta.url);
    const sdkRequire = createRequire(require.resolve("@microsoft/teams.apps"));
    const { ConfidentialClientApplication } = sdkRequire("@azure/msal-node");
    const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ appid: appId, tid: tenantId, exp: 9999999999 })).toString("base64url")}.signature`;
    const acquire = vi
      .spyOn(ConfidentialClientApplication.prototype, "acquireTokenByClientCredential")
      .mockResolvedValue({ accessToken: token });
    const app = createTeamsSdk(config());
    const value = await app.tokenProvider.getAppToken(
      "https://graph.microsoft.com/.default",
      tenantId,
    );
    expect(value?.toString()).toBe(token);
    expect(acquire).toHaveBeenCalledWith({ scopes: ["https://graph.microsoft.com/.default"] });
  });

  it("返信は受信したserviceUrlとスレッドだけを使う", async () => {
    const app = createTeamsSdk(config());
    const sent = vi.fn().mockResolvedValue({ id: "bot-reply" });
    const scoped = vi
      .spyOn(app.api, "fromServiceUrl")
      .mockReturnValue({ conversations: { createActivity: sent } } as never);
    const enqueue = vi.fn().mockResolvedValue({ created: true });
    await dispatchTeamsMessage(activity(), { ...trust, enqueue, now: () => new Date() });
    const p = enqueue.mock.calls[0]?.[0].payload;
    const reply = createTeamsReply(app, trust);
    await reply(p, "結果");
    expect(scoped).toHaveBeenCalledWith({ serviceUrl: activity().serviceUrl });
    expect(sent).toHaveBeenCalledWith(
      `${channelId};messageid=1700000000000`,
      expect.objectContaining({ type: "message", text: "結果" }),
    );
    await expect(reply({ ...p, serviceUrl: "https://evil.test/" }, "result")).rejects.toThrow();
    expect(sent).toHaveBeenCalledOnce();
  });
});

describe("Teams メンションから worker まで", () => {
  it("認証後の入口→タスク→Graph→共通分析→Teams返信、再送の除外", async () => {
    const enqueue = vi.fn().mockResolvedValue({ created: true });
    await dispatchTeamsMessage(activity(), {
      ...trust,
      enqueue,
      now: () => new Date("2026-10-26T00:00:00Z"),
    });
    const p = enqueue.mock.calls[0]?.[0].payload;
    const fetchGraph = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      const body = path.endsWith("/replies")
        ? { value: [] }
        : path.includes("/messages/")
          ? {
              id: "1700000000000",
              messageType: "message",
              createdDateTime: "2023-11-14T22:13:20Z",
              from: { user: { id: userId, displayName: "担当者" } },
              body: { contentType: "html", content: "<p>10月30日に出荷します</p>" },
            }
          : { membershipType: "standard" };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const graph = createTeamsGraphReader({
      tenantId,
      token: async () => "fake",
      fetch: fetchGraph as typeof fetch,
    });
    const reply = vi.fn().mockResolvedValue("bot-reply");
    const llm = createFakeLlmProvider({
      summarize_patch: () => ({
        overview: [
          { ref: null, text: "10月30日に出荷", evidence: ["m1"], quote: "10月30日に出荷します" },
        ],
        topics: [],
        responses: [],
        statements: [],
        todos: [],
        questions: [],
        close: [],
      }),
    });
    const store = createMemoryStore();
    const worker = createTeamsWorker({
      config: config(),
      graph,
      reply,
      llm,
      store,
      now: () => new Date("2026-10-26T00:00:00Z"),
    });
    const res = await inject(worker.handle, { method: "POST", url: TEAMS_JOB_PATH, payload: p });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe("ok");
    expect(llm.calls.length).toBeGreaterThan(0);
    expect(reply).toHaveBeenCalled();
    expect(reply.mock.calls.map((call) => call[1]).join("\n")).toContain("10月30日に出荷");
    expect(reply.mock.calls.map((call) => call[1]).join("\n")).toContain("teams.microsoft.com");
    const before = reply.mock.calls.length;
    expect(
      (await inject(worker.handle, { method: "POST", url: TEAMS_JOB_PATH, payload: p })).payload,
    ).toBe("duplicate");
    expect(reply).toHaveBeenCalledTimes(before);
    const bad = await inject(worker.handle, {
      method: "POST",
      url: TEAMS_JOB_PATH,
      payload: { ...p, tenantId: appId },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("Teams カードのSDK合成HTTP", () => {
  async function setup() {
    const now = () => new Date("2026-10-26T00:00:00Z");
    const store = createMemoryTeamsWorkStore({ now });
    const scope = { tenantId, teamId, channelId, rootMessageId: "1700000000000" };
    const candidate = {
      text: "合成作業",
      assigneeAadId: userId,
      dueIso: null,
      dueText: null,
      certainty: "explicit" as const,
      needsReview: false,
      closed: false,
      evidence: [
        {
          ref: { ...scope, kind: "root" as const, messageId: scope.rootMessageId },
          quote: "合成作業",
          link: "https://teams.microsoft.com/l/message/channel/message",
          sourceCreatedAt: now().toISOString(),
        },
      ],
    };
    const { todo } = await store.register({
      scope,
      actorAadId: userId,
      now: now(),
      requestId: "initial",
      mode: "new",
      candidate,
    });
    const data = await issueTeamsAction(
      {
        scope,
        actorAadId: userId,
        now: now(),
        sourceActivityId: "card-id",
        action: "done",
        todoId: todo.todoId,
        expectedRevision: 1,
        expireAt: new Date("2026-11-20T00:00:00Z"),
      },
      { store },
    );
    const invoke = {
      ...activity(),
      type: "invoke",
      id: "invoke-event",
      name: "adaptiveCard/action",
      text: "",
      entities: [],
      replyToId: "card-id",
      value: { action: { type: "Action.Execute", verb: "ignored-verb", data } },
    };
    const enqueue = vi.fn().mockResolvedValue({ created: true });
    const graph = { getThread: vi.fn(), getChannel: vi.fn() };
    const runtime = createTeamsApp(config({ TEAMS_TODO_ENABLED: "true" }), {
      enqueue,
      now,
      work: { store },
    });
    await runtime.app.initialize();
    return { now, store, scope, invoke, enqueue, graph, runtime };
  }

  function authenticate(runtime: ReturnType<typeof createTeamsApp>) {
    // JWT検証結果だけを合成する。HTTP adapter・SDK routing・invoke serializationは実物。
    const server = runtime.app.server as unknown as {
      authorize: (...args: unknown[]) => Promise<unknown>;
    };
    return vi.spyOn(server, "authorize").mockResolvedValue({
      success: true,
      token: {
        appId,
        tenantId,
        serviceUrl: activity().serviceUrl,
        from: "azure",
        fromId: "https://api.botframework.com",
        isExpired: () => false,
        toString: () => "synthetic",
      },
    });
  }

  it("JWTなしinvokeを拒否し、認証済みメンションなし操作はSDK応答bodyだけを返す", async () => {
    const s = await setup();
    expect(
      (await inject(s.runtime.handle, { method: "POST", url: "/api/messages", payload: s.invoke }))
        .statusCode,
    ).toBe(401);
    expect(s.enqueue).not.toHaveBeenCalled();
    authenticate(s.runtime);
    const res = await inject(s.runtime.handle, {
      method: "POST",
      url: "/api/messages",
      payload: s.invoke,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: "操作を受け付けました。",
    });
    expect(s.enqueue).toHaveBeenCalledOnce();
    expect(s.graph.getThread).not.toHaveBeenCalled();
  });

  it.each(["tenant", "card", "data", "queue"])(
    "%s拒否はinvoke内に閉じ、チャネルへ投稿しない",
    async (field) => {
      const s = await setup();
      authenticate(s.runtime);
      const send = vi.spyOn(s.runtime.app.api, "fromServiceUrl");
      if (field === "tenant") s.invoke.channelData.tenant.id = appId;
      if (field === "card") s.invoke.replyToId = "forwarded";
      if (field === "data") Object.assign(s.invoke.value.action.data, { action: "done" });
      if (field === "queue") s.enqueue.mockRejectedValue(new Error("synthetic-private-body"));
      const res = await inject(s.runtime.handle, {
        method: "POST",
        url: "/api/messages",
        payload: s.invoke,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().type).toBe("application/vnd.microsoft.activity.message");
      expect(res.json().value).not.toBe("操作を受け付けました。");
      expect(res.payload).not.toContain("synthetic-private-body");
      expect(send).not.toHaveBeenCalled();
      if (field !== "queue") expect(s.enqueue).not.toHaveBeenCalled();
    },
  );

  it("任意接続workerは操作を適用し、業務拒否を公開返信しない。未指定は003互換", async () => {
    const s = await setup();
    authenticate(s.runtime);
    await inject(s.runtime.handle, { method: "POST", url: "/api/messages", payload: s.invoke });
    const payload = s.enqueue.mock.calls[0]?.[0].payload;
    const reply = vi.fn();
    const options = {
      config: config(),
      store: createMemoryStore(),
      llm: createFakeLlmProvider(),
      graph: s.graph,
      reply,
      now: s.now,
    };
    const legacy = createTeamsWorker(options);
    expect(
      (await inject(legacy.handle, { method: "POST", url: TEAMS_ACTION_PATH, payload })).statusCode,
    ).toBe(404);
    const worker = createTeamsWorker({
      ...options,
      config: config({ TEAMS_TODO_ENABLED: "true" }),
      work: { store: s.store },
    });
    const accepted = await inject(worker.handle, {
      method: "POST",
      url: TEAMS_ACTION_PATH,
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect((await s.store.getTodos(s.scope))[0]?.status).toBe("done");
    const rejected = await inject(worker.handle, {
      method: "POST",
      url: TEAMS_ACTION_PATH,
      payload: { ...payload, taskName: `teams-action-${"a".repeat(64)}`, actorAadId: appId },
    });
    expect(rejected.statusCode).toBe(200);
    expect(reply).not.toHaveBeenCalled();
    const malformed = await inject(worker.handle, {
      method: "POST",
      url: TEAMS_ACTION_PATH,
      payload: { ...payload, platform: "slack" },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
