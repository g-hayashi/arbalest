/**
 * 前回の状態がある再実行で、まとめ（概要、決定事項、未決定事項、問い）が変わっていないときの簡素な返信。
 * 初回、全体の処理し直し、抑止・明示の閲覧依頼、チャネル直下、同じ依頼の再試行は、従来どおりの全文。
 */
import { describe, expect, it, vi } from "vitest";
import type { JobPayload } from "../../src/jobs/types.js";
import { createFakeLlmProvider, type LlmRequest } from "../../src/llm/index.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { requestJob } from "../../src/worker/jobs/request.js";
import type { JobContext } from "../../src/worker/server.js";
import { createFakeCanvas } from "../shared/fakeCanvas.js";
import { createFakeSlack } from "../shared/fakeSlack.js";

const NOW = new Date("2026-10-25T09:00:00.000Z");
const ROOT = "1792890000.000000";
const LATER = "1792890100.000000";
const payload = (over: Partial<JobPayload> = {}): JobPayload => ({
  taskName: "evt-1",
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

function mid(input: string, snippet: string): string {
  const line = input.split("\n").find((l) => /^\[m\d+\]/.test(l) && l.includes(snippet));
  const id = line === undefined ? undefined : /^\[(m\d+)\]/.exec(line)?.[1];
  if (id === undefined) throw new Error(`メッセージがありません: ${snippet}`);
  return id;
}

const FIRST_TODO = {
  ref: null,
  evidence: ["m1"],
  quote: "資料を共有します",
  text: "資料を共有する",
  assignee: "p1",
  due_iso: null,
  due_text: null,
  certainty: "explicit" as const,
};

/** 2 回目以降の分析（差分または全体）の応答を、テストごとに差し替える。 */
type Second = (req: LlmRequest<unknown>) => unknown;

function setup(second: Second = () => EMPTY) {
  const canvas = createFakeCanvas();
  const slack = createFakeSlack(new Map([["U1", "田中"]]), { canvas });
  const store = createMemoryStore({ now: () => NOW });
  let call = 0;
  const llm = createFakeLlmProvider({
    request_intent: () => ({
      intent: "summary",
      period: null,
      suppressTodo: true,
      suppressCanvas: true,
    }),
    summarize_patch: (req) => {
      call += 1;
      return call === 1 ? { ...EMPTY, todos: [FIRST_TODO] } : second(req);
    },
  });
  slack.setThread(ROOT, [{ ts: ROOT, thread_ts: ROOT, user: "U1", text: "資料を共有します" }]);
  const ctx: JobContext = {
    slack: slack.client,
    store,
    llm,
    now: () => NOW,
    log: vi.fn() as JobContext["log"],
  };
  return { canvas, slack, store, llm, ctx };
}

const addLater = (h: ReturnType<typeof setup>, text: string) =>
  h.slack.setThread(ROOT, [
    { ts: ROOT, thread_ts: ROOT, user: "U1", text: "資料を共有します" },
    { ts: LATER, thread_ts: ROOT, user: "U1", text },
  ]);

describe("まとめに変更がない再実行", () => {
  it("何も変わらなければ「前回から変更はありません。」と canvas のリンクだけを返す", async () => {
    const h = setup();
    await requestJob(payload(), h.ctx);
    const before = h.slack.posts.length;
    await requestJob(payload({ taskName: "evt-2", mentionTs: LATER }), h.ctx);

    const post = h.slack.posts[before];
    expect(post?.text).toContain("📋 前回から変更はありません。");
    expect(post?.text).not.toContain("canvas を開く");
    expect(post?.text).not.toContain("/docs/");
    expect(h.slack.buttons().filter((b) => b.postIndex === before)).toEqual([
      expect.objectContaining({ label: "canvas を開く", actionId: "canvas_open" }),
    ]);
    expect(post?.text).not.toContain("調整のまとめ");
    expect(post?.text).not.toContain("取得範囲");
    expect(post?.text).not.toContain("ToDo");
    expect(post?.text).not.toContain("資料を共有する");
    // ToDo に変化がないので、ToDo 一覧（完了ボタン付き）の別投稿も出さない
    expect(h.slack.posts).toHaveLength(before + 1);
    expect(h.llm.calls.map((c) => c.schemaName)).toEqual(["summarize_patch"]);
  });

  it("ToDo の期限だけが変わったら、短い返信に変化した ToDo の行と canvas のリンクを付ける", async () => {
    const h = setup((req) => ({
      ...EMPTY,
      todos: [
        {
          ...FIRST_TODO,
          ref: "t1",
          evidence: [mid(req.input, "期限は")],
          quote: "期限は 10/30 にします",
          due_iso: "2026-10-30",
          due_text: "10/30",
        },
      ],
    }));
    await requestJob(payload(), h.ctx);
    const before = h.slack.posts.length;
    addLater(h, "期限は 10/30 にします");
    await requestJob(payload({ taskName: "evt-2", mentionTs: LATER }), h.ctx);

    const text = h.slack.posts[before]?.text ?? "";
    expect(text).toContain("📋 まとめに変更はありません。ToDo: 変更 1件 / canvas: 更新");
    expect(text).toContain("資料を共有する — @田中 / 期限 10/30(金)");
    expect(text).toContain("✏️");
    expect(text).not.toContain("/docs/");
    expect(h.slack.buttons().filter((b) => b.postIndex === before)).toHaveLength(1);
    expect(text).not.toContain("調整のまとめ");
    expect(text).not.toContain("取得範囲");
    // ToDo に変化があるので、ToDo 一覧は従来どおり出す
    expect(h.slack.posts).toHaveLength(before + 2);
    expect(h.slack.posts[before + 1]?.text).toContain("ToDo 一覧");
  });

  it("概要が変わったら、全文で返す", async () => {
    const h = setup((req) => ({
      ...EMPTY,
      overview: [
        {
          ref: null,
          evidence: [mid(req.input, "進めましょう")],
          quote: "進めましょう",
          text: "作業の進め方が話し合われた",
        },
      ],
    }));
    await requestJob(payload(), h.ctx);
    const before = h.slack.posts.length;
    addLater(h, "進めましょう");
    await requestJob(payload({ taskName: "evt-2", mentionTs: LATER }), h.ctx);

    const text = h.slack.posts[before]?.text ?? "";
    expect(text).toContain("📋 調整のまとめ（前回から: 概要を更新）");
    expect(text).not.toContain("まとめに変更はありません");
    expect(text).toContain("会話の概要");
    expect(text).toContain("作業の進め方が話し合われた");
    expect(text).toContain("取得範囲");
  });

  it("抑止・明示の閲覧依頼（見るだけ）は、変化がなくても全文で返す", async () => {
    const h = setup();
    await requestJob(payload(), h.ctx);
    const before = h.slack.posts.length;
    await requestJob(
      payload({ taskName: "evt-2", mentionTs: LATER, requestText: "見るだけ" }),
      h.ctx,
    );

    const text = h.slack.posts[before]?.text ?? "";
    expect(text).toContain("調整のまとめ");
    expect(text).toContain("前回から: 変更なし");
    expect(text).toContain("取得範囲");
  });

  it("全体の処理し直し（編集）のときは、全文で返す", async () => {
    const h = setup(() => ({ ...EMPTY, todos: [FIRST_TODO] }));
    await requestJob(payload(), h.ctx);
    const before = h.slack.posts.length;
    h.slack.setThread(ROOT, [
      { ts: ROOT, thread_ts: ROOT, user: "U1", text: "資料を共有します！" },
    ]);
    await requestJob(payload({ taskName: "evt-2", mentionTs: LATER }), h.ctx);

    const text = h.slack.posts[before]?.text ?? "";
    expect(text).toContain("調整のまとめ");
    expect(text).toContain("取得範囲");
  });

  it("チャネル直下は、2 回目でも全文で返す", async () => {
    const h = setup();
    h.slack.setHistory([{ ts: ROOT, user: "U1", text: "資料を共有します" }]);
    await requestJob(payload({ threadTs: null }), h.ctx);
    const before = h.slack.posts.length;
    await requestJob(payload({ threadTs: null, taskName: "evt-2", mentionTs: LATER }), h.ctx);

    const text = h.slack.posts[before]?.text ?? "";
    expect(text).toContain("調整のまとめ");
    expect(text).toContain("チャネル直下のため自動記録なし");
  });

  it("同じ依頼の再試行は、前の試行が保存した状態と比べず、全文で更新する", async () => {
    const h = setup();
    await requestJob(payload(), h.ctx);
    await requestJob(payload(), h.ctx);

    const summary = h.slack.updates.find((u) => u.ts === h.slack.tsOfPost(0));
    expect(summary?.text).toContain("調整のまとめ");
    expect(summary?.text).toContain("取得範囲");
  });

  it("canvas の更新に失敗したときは、失敗を添える", async () => {
    const h = setup();
    h.slack.client.conversations.info = vi.fn().mockRejectedValue(new Error("canvas unavailable"));
    await requestJob(payload(), h.ctx);
    const before = h.slack.posts.length;
    await requestJob(payload({ taskName: "evt-2", mentionTs: LATER }), h.ctx);

    const text = h.slack.posts[before]?.text ?? "";
    expect(text).toContain("📋 前回から変更はありません。");
    expect(text).toContain("canvas: 更新失敗");
    expect(text).not.toContain("概要とToDoは表示しています");
  });
});
