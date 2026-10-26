import fc from "fast-check";
import inject from "light-my-request";
import { describe, expect, it, vi } from "vitest";
import { JOB_PATHS, type JobPayload } from "../../src/jobs/types.js";
import { createFakeLlmProvider, LlmError } from "../../src/llm/index.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { todoIdOf } from "../../src/store/types.js";
import { dateToTs, resolveRequestPeriod } from "../../src/util/time.js";
import { requestJob } from "../../src/worker/jobs/request.js";
import { summarizeJob } from "../../src/worker/jobs/summarize.js";
import { todoDoneJob } from "../../src/worker/jobs/todos.js";
import { createWorker, FILTERED_TEXT, type JobContext } from "../../src/worker/server.js";
import { createFakeCanvas } from "../shared/fakeCanvas.js";
import { BOT_USER_ID, createFakeSlack } from "../shared/fakeSlack.js";

const NOW = new Date("2026-10-25T09:00:00.000Z");
const ROOT = "1792890000.000000";
const payload = (over: Partial<JobPayload> = {}): JobPayload => ({
  taskName: "evt-request",
  command: "request",
  teamId: "T1",
  channelId: "C1",
  threadTs: ROOT,
  mentionTs: ROOT,
  userId: "U1",
  requestedAt: NOW.toISOString(),
  requestText: "",
  ...over,
});
const EMPTY = {
  overview: [],
  topics: [],
  responses: [],
  statements: [],
  todos: [],
  questions: [],
  close: [],
};
function setup(handlers: Parameters<typeof createFakeLlmProvider>[0] = {}) {
  const slack = createFakeSlack(new Map([["U1", "田中"]]));
  const store = createMemoryStore({ now: () => NOW });
  const llm = createFakeLlmProvider({
    summarize_patch: () => ({
      ...EMPTY,
      overview: [
        { ref: null, evidence: ["m1"], quote: "資料を共有しました", text: "資料が共有された" },
      ],
    }),
    ...handlers,
  });
  const ctx: JobContext = {
    slack: slack.client,
    store,
    llm,
    now: () => NOW,
    log: vi.fn() as JobContext["log"],
  };
  slack.setThread(ROOT, [{ ts: ROOT, thread_ts: ROOT, user: "U1", text: "資料を共有しました" }]);
  return { slack, store, llm, ctx };
}

describe("requestJob: 概要", () => {
  it.each([
    ["先週の動きを振り返って", "last_week", null],
    ["今週の学びは", "this_week", null],
    ["今月の振り返り", "this_month", null],
    ["直近14日を振り返って", "rolling_days", 14],
    ["この2週間の学びは？", "rolling_weeks", 2],
    ["振り返って", "default", null],
    ["直近100日を振り返って", "rolling_days", 100],
  ] as const)("自然文 %s から確定期間のFindingsへ接続する", async (requestText, kind, amount) => {
    const { ctx, slack, llm, store } = setup({
      request_intent: () => ({
        intent: "findings",
        period: { kind, amount },
        suppressTodo: false,
        suppressCanvas: false,
      }),
      findings_map: () => ({ candidates: [] }),
    });
    const period = resolveRequestPeriod({ kind, amount }, NOW);
    expect(period).not.toBeNull();
    if (period === null) throw new Error("テストの期間が不正です");
    slack.setHistory([{ ts: ROOT, user: "U1", text: "資料を共有しました" }]);
    await requestJob(payload({ requestText }), ctx);
    expect(slack.historyCalls[0]?.oldest).toBe(dateToTs(new Date(period.start)));
    expect(llm.calls.map((c) => c.schemaName)).toEqual(
      kind === "last_week" ? ["request_intent"] : ["request_intent", "findings_map"],
    );
    expect(slack.allText()).toContain(period.label);
    expect(slack.allText()).toContain("対象期間:");
    expect(slack.allText()).toContain(kind === "last_week" ? "投稿0件" : "投稿1件");
    if (period.clamped) expect(slack.allText()).toContain("90 日に制限");
    expect(await store.targets.get(`t_C1_${ROOT.replace(".", "-")}`)).toBeNull();
    for (const post of slack.posts) expect(post.thread_ts).toBe(ROOT);
  });

  it("空メンションをworkerで受け、分析1回で概要と範囲を返信する", async () => {
    const { ctx, slack, llm } = setup();
    const worker = createWorker(ctx);
    worker.registerJob<JobPayload>(JOB_PATHS.request, requestJob);
    const res = await inject(worker.handle, {
      method: "POST",
      url: JOB_PATHS.request,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(payload()),
    });
    expect(res.statusCode).toBe(200);
    expect(llm.calls.map((c) => c.schemaName)).toEqual(["summarize_patch"]);
    expect(slack.allText()).toContain("資料が共有された");
    expect(slack.allText()).toContain("スレッド / 投稿1件");
  });

  it("曖昧な依頼は確認だけを返し、会話を分析しない", async () => {
    const { ctx, slack, llm, store } = setup({
      request_intent: () => ({
        intent: "clarify",
        period: null,
        suppressTodo: true,
        suppressCanvas: true,
      }),
    });
    await requestJob(payload({ requestText: "あれをやって" }), ctx);
    expect(llm.calls.map((c) => c.schemaName)).toEqual(["request_intent"]);
    expect(slack.allText()).toContain("どちらを希望");
    expect(await store.targets.get(`t_C1_${ROOT.replace(".", "-")}`)).toBeNull();
  });

  it("自然文の抑止指定を解釈し、返信に示す", async () => {
    const { ctx, slack } = setup({
      request_intent: () => ({
        intent: "summary",
        period: null,
        suppressTodo: true,
        suppressCanvas: true,
      }),
    });
    await requestJob(payload({ requestText: "登録しないでまとめて" }), ctx);
    expect(slack.allText()).toContain("ToDo登録・canvas更新は行っていません");
  });

  it("空のチャネルは直近7日・投稿0件を返し、AIを呼ばない", async () => {
    const { ctx, slack, llm } = setup();
    await requestJob(payload({ threadTs: null }), ctx);
    expect(llm.calls).toHaveLength(0);
    expect(slack.allText()).toContain("直近7日 / 投稿0件");
  });

  it("依頼解釈の安全フィルタも専用の返信にする", async () => {
    const { ctx, slack } = setup({
      request_intent: () => {
        throw new LlmError("content_filter", "filtered");
      },
    });
    await requestJob(payload({ requestText: "この会話を整理して" }), ctx);
    expect(slack.allText()).toContain(FILTERED_TEXT);
  });
});

function autoSetup(options: { unsafe?: boolean; canvasFails?: boolean } = {}) {
  const canvas = createFakeCanvas();
  const slack = createFakeSlack(new Map([["U1", "田中"]]), { canvas });
  const store = createMemoryStore({ now: () => NOW });
  const llm = createFakeLlmProvider({
    request_intent: () => ({
      intent: "summary",
      period: null,
      suppressTodo: true,
      suppressCanvas: true,
    }),
    summarize_patch: () => ({
      ...EMPTY,
      todos: [
        {
          ref: null,
          evidence: ["m1"],
          quote: options.unsafe ? "存在しない引用" : "資料を共有します",
          text: "資料を共有する",
          assignee: options.unsafe ? null : "p1",
          due_iso: null,
          due_text: null,
          certainty: "explicit",
        },
      ],
    }),
  });
  slack.setThread(ROOT, [{ ts: ROOT, thread_ts: ROOT, user: "U1", text: "資料を共有します" }]);
  if (options.canvasFails) {
    slack.client.conversations.info = vi.fn().mockRejectedValue(new Error("canvas unavailable"));
  }
  const ctx: JobContext = {
    slack: slack.client,
    store,
    llm,
    now: () => NOW,
    log: vi.fn() as JobContext["log"],
  };
  return { canvas, slack, store, llm, ctx };
}

describe("requestJob: 自動記録", () => {
  it.each(["request", "summarize"] as const)(
    "%s は分析1回から担当付きToDoとcanvasを更新する",
    async (command) => {
      const h = autoSetup();
      await (command === "request" ? requestJob : summarizeJob)(payload({ command }), h.ctx);
      const todo = await h.store.todos.get(todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1"));
      expect(todo?.assigneeUserId).toBe("U1");
      expect(todo?.listMessageTs).toBe(h.slack.tsOfPost(1));
      expect(h.canvas.text()).toContain("資料を共有する");
      expect(h.slack.posts).toHaveLength(2);
      expect(h.slack.allText()).toContain("ToDo: 1件登録");
      // canvas へのリンクは URL ボタン。text と本文には URL を入れない
      expect(h.slack.buttons()).toEqual([
        expect.objectContaining({ postIndex: 0, label: "canvas を開く", actionId: "canvas_open" }),
      ]);
      expect(h.slack.allText()).not.toContain("https://example.slack.com/docs/");
      expect(h.slack.posts[0]?.text).toContain("canvas: ");
      expect(JSON.stringify(h.slack.posts[0]?.blocks)).not.toContain('"action_id":"todo_done"');
      expect(JSON.stringify(h.slack.posts[1]?.blocks)).toContain('"action_id":"todo_done"');
      expect(h.llm.calls.map((call) => call.schemaName)).toEqual(["summarize_patch"]);
    },
  );

  it("担当不明・根拠未確認のToDoは返信に残し、自動登録もcanvas作成もしない", async () => {
    const h = autoSetup({ unsafe: true });
    await requestJob(payload(), h.ctx);
    expect(await h.store.todos.get(todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1"))).toBeNull();
    expect(h.canvas.canvasId()).toBeNull();
    expect(h.slack.allText()).toContain("資料を共有する");
    expect(h.slack.allText()).toContain("自動登録対象外 1件");
  });

  it("抑止指定はToDoとcanvasを実行しない", async () => {
    const h = autoSetup();
    await requestJob(payload({ requestText: "見るだけ" }), h.ctx);
    expect(await h.store.todos.get(todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1"))).toBeNull();
    expect(h.canvas.canvasId()).toBeNull();
    expect(h.slack.allText()).toContain("ToDo登録・canvas更新は行っていません");
  });

  it("チャネル直下では自動記録せず、概要だけを返す", async () => {
    const h = autoSetup();
    h.slack.setHistory([{ ts: ROOT, user: "U1", text: "資料を共有します" }]);
    await requestJob(payload({ threadTs: null }), h.ctx);
    expect(await h.store.todos.get(todoIdOf("c_C1", "t1"))).toBeNull();
    expect(h.canvas.canvasId()).toBeNull();
    expect(h.slack.allText()).toContain("チャネル直下のため自動記録なし");
  });

  it("canvasが失敗しても成功したToDoと概要を返し、失敗を示す", async () => {
    const h = autoSetup({ canvasFails: true });
    await requestJob(payload(), h.ctx);
    expect(
      await h.store.todos.get(todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1")),
    ).not.toBeNull();
    expect(h.slack.allText()).toContain("canvas: 更新失敗");
    expect(h.slack.allText()).toContain("ToDo: 1件登録");
  });

  it("再実行でToDoとcanvas節を増やさず、完了済みToDoを再登録しない", async () => {
    const h = autoSetup();
    await requestJob(payload(), h.ctx);
    const id = todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1");
    await h.store.todos.markDone(id, "U1");
    await requestJob(payload({ taskName: "evt-second", mentionTs: "1792890010.000000" }), h.ctx);
    expect((await h.store.todos.get(id))?.status).toBe("done");
    expect(h.canvas.blocks().filter((block) => block.kind === "header")).toHaveLength(1);
    expect(h.canvas.text()).not.toContain("資料を共有する");
    // まとめも ToDo も変わらない再実行は、簡素な返信（canvas のリンクつき）
    expect(h.slack.posts[2]?.text).toContain("前回から変更はありません。");
    expect(h.slack.posts[2]?.text).not.toContain("canvas を開く");
    expect(h.slack.buttons().filter((b) => b.postIndex === 2)).toHaveLength(1);
  });

  it("既存の管理節は調整事項がなくなっても更新し、人の行を残す", async () => {
    const h = autoSetup();
    await requestJob(payload(), h.ctx);
    h.canvas.humanAppend("人が書いたメモ");
    h.slack.setThread(ROOT, []);
    await requestJob(payload({ taskName: "evt-empty" }), h.ctx);
    expect(h.canvas.blocks().filter((block) => block.kind === "header")).toHaveLength(1);
    expect(h.canvas.text()).not.toContain("資料を共有する");
    expect(h.canvas.text()).toContain("人が書いたメモ");
  });

  it("完了ボタンは専用ToDo一覧だけを更新し、概要とcanvas結果の返信を保持する", async () => {
    const h = autoSetup();
    await requestJob(payload(), h.ctx);
    const id = todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1");
    const registered = await h.store.todos.get(id);
    expect(registered?.listMessageTs).toBe(h.slack.tsOfPost(1));
    const summary = structuredClone(h.slack.posts[0]);
    await todoDoneJob({ taskName: "done-auto", todoId: id, channelId: "C1", userId: "U1" }, h.ctx);
    expect(h.slack.updates).toHaveLength(1);
    expect(h.slack.updates[0]?.ts).toBe(h.slack.tsOfPost(1));
    expect(h.slack.updates[0]?.text).toContain("ToDo 一覧");
    expect(h.slack.posts[0]).toEqual(summary);
    expect(summary?.text).toContain("取得範囲");
    expect(summary?.text).not.toContain("canvas を開く");
    expect(summary?.text).not.toContain("https://example.slack.com/docs/");
  });
});

describe("requestJob: 再試行", () => {
  function withPostedReplies(h: ReturnType<typeof autoSetup>) {
    const replies = h.slack.client.conversations.replies.bind(h.slack.client.conversations);
    h.slack.client.conversations.replies = vi.fn(async (args) => {
      const result = await replies(args);
      return {
        ...result,
        messages: [
          ...(result.messages ?? []),
          ...h.slack.posts
            .filter((p) => p.thread_ts === args.ts)
            .map((p) => ({
              ...p,
              user: BOT_USER_ID,
              bot_id: "B1",
              ts: h.slack.tsOfPost(h.slack.posts.indexOf(p)),
            })),
        ],
      };
    }) as typeof h.slack.client.conversations.replies;
  }

  it("同一依頼の再試行では概要と専用一覧を再投稿せず更新する", async () => {
    const h = autoSetup();
    withPostedReplies(h);
    await requestJob(payload(), h.ctx);
    await requestJob(payload(), h.ctx);
    expect(h.slack.posts).toHaveLength(2);
    expect(h.slack.updates.map((u) => u.ts)).toEqual([h.slack.tsOfPost(0), h.slack.tsOfPost(1)]);
    expect((await h.store.events.getRequestProgress("evt-request"))?.messages).toHaveProperty(
      "summary:0",
    );
  });

  it.each([0, 1])("投稿%s成功後の応答消失をrepliesで復元し、重複させない", async (failureIndex) => {
    const h = autoSetup();
    withPostedReplies(h);
    const post = h.slack.client.chat.postMessage.bind(h.slack.client.chat);
    let fail = true;
    h.slack.client.chat.postMessage = vi.fn(async (args) => {
      const result = await post(args);
      if (fail && h.slack.posts.length - 1 === failureIndex) {
        fail = false;
        throw new Error("response lost");
      }
      return result;
    }) as typeof h.slack.client.chat.postMessage;
    await expect(requestJob(payload(), h.ctx)).rejects.toThrow("response lost");
    await requestJob(payload(), h.ctx);
    expect(h.slack.posts).toHaveLength(2);
    expect(
      (await h.store.todos.get(todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1")))?.listMessageTs,
    ).toBe(h.slack.tsOfPost(1));
  });

  it("返信tsの保存失敗を復元し、別taskNameには流用しない", async () => {
    const h = autoSetup();
    withPostedReplies(h);
    const save = h.store.events.saveRequestProgress.bind(h.store.events);
    let fail = true;
    vi.spyOn(h.store.events, "saveRequestProgress").mockImplementation(async (name, input) => {
      if (fail && Object.keys(input.messages).length > 0) {
        fail = false;
        throw new Error("store unavailable");
      }
      return save(name, input);
    });
    await expect(requestJob(payload(), h.ctx)).rejects.toThrow("store unavailable");
    await requestJob(payload(), h.ctx);
    expect(h.slack.posts).toHaveLength(2);
    await requestJob(payload({ taskName: "evt-other" }), h.ctx);
    // 別 taskName は新規に投稿する。変化がないので簡素な返信 1 通だけ（ToDo 一覧は出さない）。
    expect(h.slack.posts).toHaveLength(3);
    expect(h.slack.posts[2]?.text).toContain("前回から変更はありません。");
  });

  it.each(["todos", "canvas"] as const)(
    "%s完了直後の保存失敗から再照合し、新しいToDoも登録する",
    async (stage) => {
      const h = autoSetup();
      withPostedReplies(h);
      const save = h.store.events.saveRequestProgress.bind(h.store.events);
      let fail = true;
      vi.spyOn(h.store.events, "saveRequestProgress").mockImplementation(async (name, input) => {
        if (fail && input.stages[stage] === "done") {
          fail = false;
          throw new Error("stage save failed");
        }
        return save(name, input);
      });
      await expect(requestJob(payload(), h.ctx)).rejects.toThrow("stage save failed");
      h.slack.setThread(ROOT, [
        { ts: ROOT, thread_ts: ROOT, user: "U1", text: "資料を共有します" },
        { ts: "1792890010.000000", thread_ts: ROOT, user: "U1", text: "会場も予約します" },
      ]);
      h.ctx.llm = createFakeLlmProvider({
        summarize_patch: () => ({
          ...EMPTY,
          todos: [
            {
              ref: null,
              evidence: ["m1"],
              quote: "会場も予約します",
              text: "会場を予約する",
              assignee: "p1",
              due_iso: null,
              due_text: null,
              certainty: "explicit",
            },
          ],
        }),
      });
      await requestJob(payload(), h.ctx);
      const targetId = `t_C1_${ROOT.replace(".", "-")}`;
      expect((await h.store.todos.get(todoIdOf(targetId, "t1")))?.text).toBe("資料を共有する");
      expect((await h.store.todos.get(todoIdOf(targetId, "t2")))?.text).toBe("会場を予約する");
      expect(h.canvas.blocks().filter((b) => b.kind === "header")).toHaveLength(1);
      expect(h.slack.posts).toHaveLength(2);
    },
  );

  it("再試行回数によらずToDoとcanvasが一意で、完了済みToDoを復活させない", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.boolean(), async (retries, done) => {
        const h = autoSetup();
        withPostedReplies(h);
        await requestJob(payload(), h.ctx);
        const id = todoIdOf(`t_C1_${ROOT.replace(".", "-")}`, "t1");
        if (done) await h.store.todos.markDone(id, "U1");
        for (let i = 0; i < retries; i++) await requestJob(payload(), h.ctx);
        expect(h.slack.posts).toHaveLength(2);
        expect(h.canvas.blocks().filter((b) => b.kind === "header")).toHaveLength(1);
        expect((await h.store.todos.get(id))?.status).toBe(done ? "done" : "open");
        if (done) {
          const lastList = h.slack.updates.filter((u) => u.ts === h.slack.tsOfPost(1)).at(-1);
          expect(JSON.stringify(lastList?.blocks)).not.toContain('"action_id":"todo_done"');
        }
      }),
      { numRuns: 10 },
    );
  });
});
