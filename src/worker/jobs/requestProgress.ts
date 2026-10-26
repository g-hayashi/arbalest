/** 同じ依頼の投稿を復元する。ToDo/canvas の実体確認は各処理で毎回行う。 */
import { createHash } from "node:crypto";
import type { JobPayload } from "../../jobs/types.js";
import type { SummaryMessage } from "../../slack/render.js";
import { NO_UNFURL } from "../../slack/unfurl.js";
import type { RequestProgressInput } from "../../store/types.js";
import type { JobContext } from "../server.js";

export type RequestPublisher = {
  /** 同じ依頼（taskName）の前の試行が始まっていた。再試行では前の試行が保存した状態と比べない。 */
  resumed: boolean;
  publish(slot: string, message: SummaryMessage): Promise<string>;
  stage(
    name: keyof RequestProgressInput["stages"],
    status: "done" | "skipped" | "failed",
  ): Promise<void>;
  finish(): Promise<void>;
};

export async function createRequestPublisher(
  payload: JobPayload,
  ctx: JobContext,
  targetId: string,
): Promise<RequestPublisher> {
  const threadTs = payload.threadTs ?? payload.mentionTs;
  const prior = await ctx.store.events.getRequestProgress(payload.taskName);
  if (
    prior !== null &&
    (prior.targetId !== targetId ||
      prior.channelId !== payload.channelId ||
      prior.threadTs !== threadTs ||
      prior.mentionTs !== payload.mentionTs)
  ) {
    throw new TypeError("同じ taskName の依頼対象が一致しません");
  }
  const state: RequestProgressInput = {
    targetId,
    channelId: payload.channelId,
    threadTs,
    mentionTs: payload.mentionTs,
    stages: { ...prior?.stages },
    messages: { ...prior?.messages },
  };
  const save = () => ctx.store.events.saveRequestProgress(payload.taskName, state);
  await save();
  const prefix = `arbalest:${createHash("sha256").update(payload.taskName).digest("hex").slice(0, 32)}:`;
  const used = new Set<string>();
  let recovered: Map<string, string> | undefined;
  const recover = async () => {
    if (recovered !== undefined) return recovered;
    recovered = new Map();
    const auth = await ctx.slack.auth.test();
    if (auth.user_id === undefined) throw new Error("auth.test の応答に user_id がありません");
    let cursor: string | undefined;
    do {
      const page = await ctx.slack.conversations.replies({
        channel: payload.channelId,
        ts: threadTs,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const message of page.messages ?? []) {
        if (message.user !== auth.user_id || message.ts === undefined) continue;
        for (const block of message.blocks ?? []) {
          const id = (block as { block_id?: string }).block_id;
          if (id?.startsWith(prefix)) recovered.set(id.slice(prefix.length), message.ts);
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return recovered;
  };
  const marked = (slot: string, message: SummaryMessage) => ({
    text: message.text,
    blocks: message.blocks.map((block, index) =>
      index === 0 ? { ...block, block_id: `${prefix}${slot}` } : block,
    ),
  });
  return {
    resumed: prior !== null,
    async publish(slot, message) {
      used.add(slot);
      let ts = state.messages[slot] ?? (await recover()).get(slot);
      const content = marked(slot, message);
      if (ts !== undefined) {
        await ctx.slack.chat.update({ channel: payload.channelId, ts, ...content });
      } else {
        const result = await ctx.slack.chat.postMessage({
          channel: payload.channelId,
          thread_ts: threadTs,
          ...content,
          ...NO_UNFURL,
        });
        if (result.ts === undefined) throw new Error("chat.postMessage の応答に ts がありません");
        ts = result.ts;
      }
      state.messages[slot] = ts;
      await save();
      return ts;
    },
    async stage(name, status) {
      state.stages[name] = status;
      await save();
    },
    async finish() {
      // 完了操作や分割数の減少で使わなくなった一覧を、古いボタンのまま残さない。
      const known = new Map([...(await recover()), ...Object.entries(state.messages)]);
      for (const [slot, ts] of known) {
        if (used.has(slot)) continue;
        const text = slot.startsWith("todos:")
          ? "この依頼の未完了ToDoはありません。"
          : "この依頼の最新の概要は、同じスレッドの更新済み返信を確認してください。";
        await ctx.slack.chat.update({
          channel: payload.channelId,
          ts,
          ...marked(slot, { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }),
        });
        state.messages[slot] = ts;
      }
      state.stages.reply = "done";
      await save();
    },
  };
}
