import { describe, expect, it } from "vitest";
import {
  type AppMentionEvent,
  type BlockActionsBody,
  dispatchAppMention,
  dispatchBlockActions,
  dispatchReactionAdded,
  type IngressDeps,
  type IngressSlack,
} from "../../src/ingress/dispatch.js";
import type { JobPayload, TodoDonePayload } from "../../src/jobs/types.js";
import type { EnqueueRequest } from "../../src/tasks/enqueue.js";

const NOW = new Date("2025-10-24T05:03:00.000Z");

function setup(opts: { enqueueFails?: boolean } = {}) {
  const calls: string[] = [];
  const enqueued: EnqueueRequest[] = [];
  const reactions: { channel: string; ts: string; name: string }[] = [];
  const posts: { channel: string; threadTs: string; text: string }[] = [];
  const slack: IngressSlack = {
    async addReaction(channel, ts, name) {
      calls.push("reaction");
      reactions.push({ channel, ts, name });
    },
    async postMessage(channel, threadTs, text) {
      calls.push("post");
      posts.push({ channel, threadTs, text });
    },
  };
  const deps: IngressDeps = {
    botUserId: "UBOT",
    now: () => NOW,
    slack,
    async enqueue(req) {
      calls.push("enqueue");
      if (opts.enqueueFails) throw new Error("tasks down");
      enqueued.push(req);
      return { created: true };
    },
  };
  return { deps, calls, enqueued, reactions, posts };
}

const envelope = { event_id: "Ev1", team_id: "T1" };

const mention = (text: string, over: Partial<AppMentionEvent> = {}): AppMentionEvent => ({
  channel: "C1",
  user: "U1",
  ts: "1729746200.000100",
  text: `<@UBOT> ${text}`,
  ...over,
});

describe("dispatchAppMention", () => {
  it("まとめ（スレッドの中）: /jobs/summarize を積み、👀 を付ける", async () => {
    const { deps, enqueued, reactions, posts } = setup();
    await dispatchAppMention(mention("まとめ", { thread_ts: "1729746180.123456" }), envelope, deps);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.name).toBe("evt-Ev1");
    expect(enqueued[0]?.path).toBe("/jobs/summarize");
    const payload = enqueued[0]?.payload as JobPayload;
    expect(payload).toEqual({
      taskName: "evt-Ev1",
      command: "summarize",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1729746180.123456",
      mentionTs: "1729746200.000100",
      userId: "U1",
      requestedAt: NOW.toISOString(),
    });
    expect(reactions).toEqual([{ channel: "C1", ts: "1729746200.000100", name: "eyes" }]);
    expect(posts).toEqual([]);
  });

  it("チャネルで直接: threadTs は null", async () => {
    const { deps, enqueued } = setup();
    await dispatchAppMention(mention("要約"), envelope, deps);
    const payload = enqueued[0]?.payload as JobPayload;
    expect(payload.threadTs).toBeNull();
    expect(payload.mentionTs).toBe("1729746200.000100");
  });

  it.each([
    ["canvas", "/jobs/canvas", "canvas"],
    ["キャンバス", "/jobs/canvas", "canvas"],
    ["ToDo", "/jobs/todo", "todo"],
    ["ｔｏｄｏ", "/jobs/todo", "todo"],
  ])("%s → %s", async (text, path, command) => {
    const { deps, enqueued } = setup();
    await dispatchAppMention(mention(text), envelope, deps);
    expect(enqueued[0]?.path).toBe(path);
    const payload = enqueued[0]?.payload as JobPayload | undefined;
    expect(payload?.command).toBe(command);
    expect(payload?.days).toBeUndefined();
  });

  it("findings 14日: days = 14", async () => {
    const { deps, enqueued } = setup();
    await dispatchAppMention(mention("振り返り 14日"), envelope, deps);
    expect(enqueued[0]?.path).toBe("/jobs/findings");
    const payload = enqueued[0]?.payload as JobPayload;
    expect(payload.command).toBe("findings");
    expect(payload.days).toBe(14);
    expect(payload.clamped).toBeUndefined();
  });

  it("findings 100: 90 に丸め、clamped を付ける", async () => {
    const { deps, enqueued } = setup();
    await dispatchAppMention(mention("findings 100"), envelope, deps);
    const payload = enqueued[0]?.payload as JobPayload;
    expect(payload.days).toBe(90);
    expect(payload.clamped).toBe(true);
  });

  it("自然文は本文だけを /jobs/request に積み、👀 を付ける", async () => {
    const { deps, enqueued, reactions, posts } = setup();
    await dispatchAppMention(
      mention("先週の動きを振り返って", { thread_ts: "1729746180.123456" }),
      envelope,
      deps,
    );
    expect(enqueued[0]?.path).toBe("/jobs/request");
    expect(enqueued[0]?.payload).toMatchObject({
      command: "request",
      requestText: "先週の動きを振り返って",
      threadTs: "1729746180.123456",
    });
    expect(reactions).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  it("空のメンションも /jobs/request に積み、ingress では返信やAI分析を行わない", async () => {
    const { deps, enqueued, posts } = setup();
    await dispatchAppMention(mention(""), envelope, deps);
    expect(enqueued[0]?.path).toBe("/jobs/request");
    expect(enqueued[0]?.payload).toMatchObject({
      command: "request",
      requestText: "",
      threadTs: null,
    });
    expect(posts).toEqual([]);
  });

  it("ボットの投稿や、user の無いイベントは無視する", async () => {
    const { deps, calls } = setup();
    await dispatchAppMention(mention("まとめ", { bot_id: "B1" }), envelope, deps);
    await dispatchAppMention(mention("まとめ", { user: undefined }), envelope, deps);
    expect(calls).toEqual([]);
  });

  it("タスクを積んでから 👀 を付ける", async () => {
    const { deps, calls } = setup();
    await dispatchAppMention(mention("まとめ"), envelope, deps);
    expect(calls).toEqual(["enqueue", "reaction"]);
  });

  it("積むのに失敗したら投げる（Slack に再送させる）。👀 は付けない", async () => {
    const { deps, calls } = setup({ enqueueFails: true });
    await expect(dispatchAppMention(mention("まとめ"), envelope, deps)).rejects.toThrow(
      "tasks down",
    );
    expect(calls).toEqual(["enqueue"]);
  });

  it("👀 の失敗は握りつぶす（タスクは積み済み）", async () => {
    const { deps, enqueued } = setup();
    deps.slack.addReaction = async () => {
      throw new Error("already_reacted");
    };
    await expect(dispatchAppMention(mention("まとめ"), envelope, deps)).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(1);
  });
});

describe("dispatchReactionAdded", () => {
  const reaction = (name: string, item: Record<string, unknown>) => ({
    user: "U2",
    reaction: name,
    item: item as { type: string; channel?: string; ts?: string },
  });

  it("white_check_mark: /jobs/todo-done に積む（Firestore は読まない）", async () => {
    const { deps, enqueued } = setup();
    await dispatchReactionAdded(
      reaction("white_check_mark", { type: "message", channel: "C1", ts: "1729746180.123456" }),
      { event_id: "Ev9", team_id: "T1" },
      deps,
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.name).toBe("evt-Ev9");
    expect(enqueued[0]?.path).toBe("/jobs/todo-done");
    expect(enqueued[0]?.payload as TodoDonePayload).toEqual({
      taskName: "evt-Ev9",
      messageTs: "1729746180.123456",
      channelId: "C1",
      userId: "U2",
    });
  });

  it("white_check_mark 以外、メッセージ以外への付与は積まない", async () => {
    const { deps, calls } = setup();
    const env = { event_id: "Ev9", team_id: "T1" };
    await dispatchReactionAdded(
      reaction("heavy_check_mark", { type: "message", channel: "C1", ts: "1.1" }),
      env,
      deps,
    );
    await dispatchReactionAdded(
      reaction("white_check_mark", { type: "file", file: "F1" }),
      env,
      deps,
    );
    expect(calls).toEqual([]);
  });

  it("ボット自身の ✅ は積まない", async () => {
    const { deps, calls } = setup();
    await dispatchReactionAdded(
      {
        user: "UBOT",
        reaction: "white_check_mark",
        item: { type: "message", channel: "C1", ts: "1.1" },
      },
      { event_id: "Ev9", team_id: "T1" },
      deps,
    );
    expect(calls).toEqual([]);
  });
});

describe("dispatchBlockActions", () => {
  const body = (over: Partial<BlockActionsBody> = {}): BlockActionsBody => ({
    team: { id: "T1" },
    user: { id: "U3" },
    channel: { id: "D1" },
    actions: [{ action_id: "todo_done", value: "t_C1_1_k1", action_ts: "1729746300.000200" }],
    ...over,
  });

  it("todo_done: act-<action_ts>-<user> で /jobs/todo-done に積む", async () => {
    const { deps, enqueued } = setup();
    await dispatchBlockActions(body(), deps);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.name).toBe("act-1729746300-000200-U3");
    expect(enqueued[0]?.path).toBe("/jobs/todo-done");
    expect(enqueued[0]?.payload as TodoDonePayload).toEqual({
      taskName: "act-1729746300-000200-U3",
      todoId: "t_C1_1_k1",
      channelId: "D1",
      userId: "U3",
    });
  });

  it("channel が無ければ container.channel_id を使う", async () => {
    const { deps, enqueued } = setup();
    await dispatchBlockActions(body({ channel: undefined, container: { channel_id: "C9" } }), deps);
    const payload = enqueued[0]?.payload as TodoDonePayload | undefined;
    expect(payload?.channelId).toBe("C9");
  });

  it("todo_done 以外の action_id は積まない", async () => {
    const { deps, calls } = setup();
    await dispatchBlockActions(
      body({ actions: [{ action_id: "other", value: "x", action_ts: "1.1" }] }),
      deps,
    );
    expect(calls).toEqual([]);
  });

  it("value が無い todo_done は積まない", async () => {
    const { deps, calls } = setup();
    await dispatchBlockActions(
      body({ actions: [{ action_id: "todo_done", action_ts: "1.1" }] }),
      deps,
    );
    expect(calls).toEqual([]);
  });
});
