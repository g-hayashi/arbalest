/**
 * canvas のジョブ（US3、contracts/http-and-tasks.md#worker、R8、FR-030〜032）。
 * 処理の順: `buildSummary`（取得 → 分析 → 保存）→ 節の markdown を作る → チャネル canvas に書く（なければ作る）
 * → targets に節の目印を保存 → スレッドに canvas へのリンクを返信。
 * チャネルで直接呼ばれたときは、スレッドの中で呼ぶよう案内して終える（AI も canvas も使わない）。
 *
 * 投稿先（channel、thread_ts）は payload だけから決める。AI の出力は投稿先にも書き出し先にも影響しない（FR-051）。
 * 安全フィルタ（content_filter）は summarize と同じく、その旨を返信して終える。それ以外の失敗は投げる
 * （worker が一時的かどうかで 200 か 5xx かを決める）。「処理中」の返信はしない（summarize と同じ）。
 *
 * canvas へのリンクは `files.info` の permalink を使う（canvas は files の一種）。失敗したら
 * `<ワークスペースの URL>/docs/<teamId>/<canvasId>` で作る（files:read が付いていない場合の予備）。
 */

import type { WebClient } from "@slack/web-api";
import type { JobPayload } from "../../jobs/types.js";
import { writeChannelCanvasSection } from "../../slack/canvas.js";
import { canvasMarkerOf, renderCanvasSection, renderCanvasWritten } from "../../slack/render.js";
import { NO_UNFURL } from "../../slack/unfurl.js";
import type { JobContext } from "../server.js";
import {
  type BuildSummaryOptions,
  type BuiltSummary,
  buildSummaryOrReplyFiltered,
} from "./summarize.js";

export const CANVAS_IN_CHANNEL_TEXT =
  "canvas への書き出しは、スレッドの中で `@arbalest canvas` と書いてください（そのスレッドのまとめを、チャネルの canvas に書き出します）。";

/** 見出しの題名の最大長（スレッドの最初の発言から作るとき）。 */
const TITLE_CHARS = 30;

/** 題名: 最初の topic の題名。なければスレッドの最初の発言の先頭。 */
function titleOf(topicTitle: string | undefined, firstText: string | undefined): string {
  if (topicTitle !== undefined && topicTitle.trim() !== "") return topicTitle;
  const text = (firstText ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? "スレッド" : Array.from(text).slice(0, TITLE_CHARS).join("");
}

/** canvas へのリンク。files.info の permalink、だめならワークスペースの URL から組み立てる。 */
async function canvasLink(slack: WebClient, canvasId: string, teamId: string): Promise<string> {
  try {
    const info = await slack.files.info({ file: canvasId });
    const permalink = info.file?.permalink;
    if (permalink !== undefined) return permalink;
  } catch {
    // 予備に進む
  }
  const auth = await slack.auth.test();
  if (auth.url === undefined) throw new Error("auth.test の応答に url がありません");
  return `${auth.url.replace(/\/+$/, "")}/docs/${teamId}/${canvasId}`;
}

/** `POST /jobs/canvas`。 */
export async function canvasJob(
  payload: JobPayload,
  ctx: JobContext,
  options: BuildSummaryOptions = {},
): Promise<void> {
  const { slack } = ctx;
  const { channelId, mentionTs, threadTs } = payload;

  if (threadTs === null) {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: mentionTs,
      text: CANVAS_IN_CHANNEL_TEXT,
      ...NO_UNFURL,
    });
    return;
  }

  const built = await buildSummaryOrReplyFiltered(payload, ctx, options);
  if (built === null) return;

  const { link } = await writeSummaryCanvas(payload, ctx, built);
  // リンクは本文ではなく URL ボタンにする（本文の URL は Slack が canvas のプレビューに展開するため）。
  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: mentionTs,
    ...renderCanvasWritten(link),
    ...NO_UNFURL,
  });
}

/** 分析済みの結果を管理節へ書き出す。返信は呼び出し側でまとめる。 */
export async function writeSummaryCanvas(
  payload: JobPayload,
  ctx: JobContext,
  built: BuiltSummary,
) {
  const { slack, store, now } = ctx;
  const { channelId, threadTs } = payload;
  if (threadTs === null) throw new Error("canvas の対象スレッドがありません");

  // ToDo の担当者は、Slack のユーザー ID でメンションにする。
  const userIdOf = new Map(built.participants.map((p) => [p.id, p.userId]));
  const assigneeUserIds = new Map<string, string>();
  for (const item of built.state.todos) {
    const userId = item.assignee === null ? undefined : userIdOf.get(item.assignee);
    if (userId !== undefined) assigneeUserIds.set(item.id, userId);
  }

  const marker = canvasMarkerOf(threadTs);
  const markdown = renderCanvasSection(built.model, {
    threadTs,
    title: titleOf(
      built.model.topics[0]?.title,
      built.fetched.find((m) => m.text.trim() !== "")?.text,
    ),
    updatedAt: now(),
    requesterUserId: payload.userId,
    threadUrl: built.permalink(threadTs),
    permalink: built.permalink,
    assigneeUserIds,
    reference: now(),
  });

  const { canvasId, action } = await writeChannelCanvasSection(slack, store, {
    channelId,
    marker,
    markdown,
  });

  // targets に節の目印を保存する（buildSummary が保存した状態に、目印だけを足す）。
  const target = await store.targets.get(built.targetId);
  if (target !== null && target.canvasSectionMarker !== marker) {
    const { updatedAt: _updatedAt, expireAt: _expireAt, ...input } = target;
    await store.targets.put({ ...input, canvasSectionMarker: marker });
  }
  ctx.log("INFO", "canvas に書き出しました", { targetId: built.targetId, canvasId, action });

  const link = await canvasLink(slack, canvasId, payload.teamId);
  return { canvasId, action, link };
}
