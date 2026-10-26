/**
 * Slack へのボットの返信（chat.postMessage）には、リンクのプレビューを付けない。
 * canvas と過去の会話（根拠のパーマリンク）のプレビューが展開されて邪魔になるため。
 * chat.update には unfurl の引数がないので対象外。
 */
import { describe, expect, it, vi } from "vitest";
import type { JobPayload } from "../../src/jobs/types.js";
import { createFakeLlmProvider, LlmError } from "../../src/llm/index.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { canvasJob } from "../../src/worker/jobs/canvas.js";
import { remindersJob } from "../../src/worker/jobs/reminders.js";
import { requestJob } from "../../src/worker/jobs/request.js";
import { summarizeJob } from "../../src/worker/jobs/summarize.js";
import { todoJob } from "../../src/worker/jobs/todos.js";
import type { JobContext } from "../../src/worker/server.js";
import { createFakeCanvas } from "../shared/fakeCanvas.js";
import { createFakeSlack, type PostedMessage } from "../shared/fakeSlack.js";

const NOW = new Date("2026-10-25T09:00:00.000Z");
const ROOT = "1792890000.000000";
const payload = (over: Partial<JobPayload> = {}): JobPayload => ({
  taskName: "evt-unfurl",
  command: "summarize",
  teamId: "T1",
  channelId: "C1",
  threadTs: ROOT,
  mentionTs: ROOT,
  userId: "U1",
  requestedAt: NOW.toISOString(),
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
  const canvas = createFakeCanvas();
  const slack = createFakeSlack(new Map([["U1", "田中"]]), { canvas });
  const store = createMemoryStore({ now: () => NOW });
  const llm = createFakeLlmProvider({
    summarize_patch: () => ({
      ...EMPTY,
      todos: [
        {
          ref: null,
          evidence: ["m1"],
          quote: "資料を共有します",
          text: "資料を共有する",
          assignee: "p1",
          due_iso: null,
          due_text: null,
          certainty: "explicit",
        },
      ],
    }),
    ...handlers,
  });
  slack.setThread(ROOT, [{ ts: ROOT, thread_ts: ROOT, user: "U1", text: "資料を共有します" }]);
  const ctx: JobContext = {
    slack: slack.client,
    store,
    llm,
    now: () => NOW,
    log: vi.fn() as JobContext["log"],
  };
  return { canvas, slack, store, ctx };
}

function expectNoUnfurl(posts: readonly PostedMessage[]) {
  expect(posts.length).toBeGreaterThan(0);
  for (const post of posts) {
    expect(post.unfurl_links).toBe(false);
    expect(post.unfurl_media).toBe(false);
  }
}

describe("リンクのプレビューを出さない", () => {
  it("まとめ（本体、ToDo 一覧、canvas のリンク）の全ての投稿に付く", async () => {
    const h = setup();
    await summarizeJob(payload(), h.ctx);
    expect(h.slack.posts.length).toBeGreaterThanOrEqual(2);
    expectNoUnfurl(h.slack.posts);
  });

  it("安全フィルタの返信に付く", async () => {
    const h = setup({
      summarize_patch: () => {
        throw new LlmError("content_filter", "filtered");
      },
    });
    await summarizeJob(payload(), h.ctx);
    expectNoUnfurl(h.slack.posts);
  });

  it("依頼の確認の返信と、依頼解釈の安全フィルタの返信に付く", async () => {
    const clarify = setup({
      request_intent: () => ({
        intent: "clarify",
        period: null,
        suppressTodo: true,
        suppressCanvas: true,
      }),
    });
    await requestJob(payload({ command: "request", requestText: "あれをやって" }), clarify.ctx);
    expectNoUnfurl(clarify.slack.posts);

    const filtered = setup({
      request_intent: () => {
        throw new LlmError("content_filter", "filtered");
      },
    });
    await requestJob(payload({ command: "request", requestText: "あれ" }), filtered.ctx);
    expectNoUnfurl(filtered.slack.posts);
  });

  it("canvas のジョブ（リンクの返信、チャネル直下の案内）に付く", async () => {
    const h = setup();
    await canvasJob(payload({ command: "canvas" }), h.ctx);
    expect(h.slack.allText()).toContain("canvas を開く");
    expectNoUnfurl(h.slack.posts);

    const channel = setup();
    await canvasJob(payload({ command: "canvas", threadTs: null }), channel.ctx);
    expectNoUnfurl(channel.slack.posts);
  });

  it("todo のジョブの一覧に付く", async () => {
    const h = setup();
    await todoJob(payload({ command: "todo" }), h.ctx);
    expectNoUnfurl(h.slack.posts);
  });

  it("リマインドの DM に付く", async () => {
    const h = setup();
    await h.store.todos.upsert({
      targetId: "t_C1_x",
      itemId: "t1",
      channelId: "C1",
      threadTs: ROOT,
      text: "資料を共有する",
      dueIso: "2026-10-25",
      dueText: null,
      assigneeUserId: "U1",
      createdBy: "U1",
      listMessageTs: "",
      sourceTs: [ROOT],
    });
    await remindersJob({}, h.ctx);
    expectNoUnfurl(h.slack.posts);
  });
});
