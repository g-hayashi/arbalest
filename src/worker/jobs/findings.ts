/**
 * findings のジョブ（US4、contracts/http-and-tasks.md#worker、R5・R11）。
 * 処理の順: すぐに「処理中」と返信 → 期間（上限 90 日）の履歴とスレッドを取得 → 前処理 → 分割 →
 * chunk ごとに chunk_cache を確かめ、なければ extract_chunk → 候補に c<n> を振る → synthesize →
 * 根拠をコードで作る → 検証（V1・V2）→ 表示。分析の本体は `analysis/findings.ts`（評価と共有）。
 * findings は保存しない（chunk_cache だけを使う）。ロックは worker/server.ts の既定（`f_<channelId>`）。
 *
 * 投稿先（channel、thread_ts）は payload だけから決める。AI の出力は投稿先にも宛先にも影響しない（FR-051）。
 * 安全フィルタ（content_filter）は summarize と同じく、その旨を返信して終える。schema・config の失敗は
 * 例外のまま投げる（worker が再試行せず失敗の返信をする）。一時的な失敗は、成功した chunk を保存してあるので、
 * 再試行は未保存の分だけ AI を呼ぶ。
 */

import {
  analyzeFindings,
  FINDINGS_DEFAULT_DAYS,
  FINDINGS_MAX_DAYS,
} from "../../analysis/findings.js";
import type { JobPayload } from "../../jobs/types.js";
import { LlmError } from "../../llm/index.js";
import { fetchChannelMessages, type SlackConversationClient } from "../../slack/conversation.js";
import { buildPermalink } from "../../slack/permalink.js";
import { type FindingsModel, renderFindings } from "../../slack/render.js";
import { createUserResolver, type SlackUsersClient } from "../../slack/users.js";
import { dateToTs } from "../../util/time.js";
import { FILTERED_TEXT, type JobContext } from "../server.js";
import { userIdsOf } from "./summarize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FindingsJobOptions = {
  /** 分割の上限（テスト用）。 */
  chunkMaxTokens?: number;
};

/** 期間（日）。未指定は 30、1〜90 に収める（ingress が丸めているが、worker でも守る）。 */
function daysOf(payload: JobPayload): { days: number; clamped: boolean } {
  const requested = payload.days ?? FINDINGS_DEFAULT_DAYS;
  const days = Math.min(
    Math.max(Math.trunc(requested) || FINDINGS_DEFAULT_DAYS, 1),
    FINDINGS_MAX_DAYS,
  );
  return { days, clamped: payload.clamped === true || requested > FINDINGS_MAX_DAYS };
}

/** `POST /jobs/findings`。 */
export async function findingsJob(
  payload: JobPayload,
  ctx: JobContext,
  options: FindingsJobOptions = {},
): Promise<void> {
  const { slack, store, llm, now } = ctx;
  const { channelId, mentionTs } = payload;
  const { days, clamped } = daysOf(payload);
  const today = now();
  const period = payload.period ?? {
    start: new Date(today.getTime() - days * DAY_MS).toISOString(),
    end: today.toISOString(),
    label: `直近 ${days} 日`,
    clamped,
  };
  const post = (text: string, blocks?: unknown[]) =>
    slack.chat.postMessage({
      channel: channelId,
      thread_ts: mentionTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
      ...(blocks !== undefined ? { blocks: blocks as never } : {}),
    });

  // 1. すぐに「処理中」と返信する（US4 のシナリオ 4）。
  await post(
    `🔎 Findings を処理中です（${period.label}）。${
      period.clamped ? "指定の期間が長いため、上限の 90 日に制限しました。" : ""
    }完了したら、このスレッドに結果を返信します。`,
  );

  try {
    const auth = await slack.auth.test();
    const botUserId = auth.user_id;
    const workspaceUrl = auth.url;
    if (workspaceUrl === undefined) throw new Error("auth.test の応答に url がありません");

    // 2. 期間の履歴（返信のあるスレッドは展開済み）。
    const oldest = dateToTs(new Date(period.start));
    const fetched = await fetchChannelMessages(
      slack as unknown as SlackConversationClient,
      channelId,
      {
        ...(botUserId !== undefined ? { botUserId } : {}),
        oldest,
        latest: dateToTs(new Date(period.end)),
      },
    );

    const users = createUserResolver(slack as unknown as SlackUsersClient, now);
    const names = new Map<string, string>();
    for (const id of userIdsOf(fetched)) names.set(id, (await users.getUser(id)).name);

    // 3. 分析（前処理 → 分割 → map（キャッシュ）→ reduce）。
    const result = await analyzeFindings({
      llm,
      messages: fetched,
      names,
      now: today,
      ...(botUserId !== undefined ? { botUserId } : {}),
      channelId,
      cache: store.chunkCache,
      ...(options.chunkMaxTokens !== undefined ? { chunkMaxTokens: options.chunkMaxTokens } : {}),
      log: ctx.log,
    });

    // AI の利用量（FR-053）。本文は出さない。
    ctx.log("INFO", "AI の利用量", {
      channelId,
      command: payload.command,
      days,
      messages: fetched.length,
      chunks: result.chunks,
      cacheHits: result.cacheHits,
      candidates: result.candidates,
      calls: result.usage.calls,
      input: result.usage.input,
      cachedInput: result.usage.cachedInput,
      output: result.usage.output,
      models: result.usage.models,
    });

    // 4. 表示
    const threadOf = new Map(fetched.map((m) => [m.ts, m.threadTs]));
    const permalink = (ts: string): string =>
      buildPermalink(workspaceUrl, channelId, ts, threadOf.get(ts) ?? null);
    const model: FindingsModel = {
      channelId,
      days,
      clamped: period.clamped,
      period,
      scope: {
        count: fetched.length,
        firstTs: fetched[0]?.ts ?? null,
        lastTs: fetched.at(-1)?.ts ?? null,
      },
      themes: result.themes.map((t) => ({
        theme: t.theme,
        findings: t.findings.map((f) => ({
          statement: f.statement,
          evidence: f.evidence,
          needsReview: f.needsReview,
        })),
      })),
    };
    for (const message of renderFindings(model, { permalink })) {
      await post(message.text, message.blocks);
    }
  } catch (error) {
    if (error instanceof LlmError && error.kind === "content_filter") {
      await post(FILTERED_TEXT);
      return;
    }
    throw error;
  }
}
