/**
 * まとめのジョブ（US1、R5、R11、contracts/http-and-tasks.md#worker）。
 * 処理の順: 対象の決定 → 取得 → 前回の状態の読み込み → 差分か全体か → 前処理 → extract → 検証 → merge
 * → decide → 保存 → 返信。分析の本体は `analysis/pipeline.ts`（評価と共有）。
 * `buildSummary` は返信の手前（保存まで）の共通の関数で、canvas と todo のジョブからも使う。
 *
 * 投稿先（channel、thread_ts）は payload だけから決める。AI の出力は投稿先にも宛先にも影響しない（FR-051）。
 */

import { toSummaryModel } from "../../analysis/decide.js";
import { type AnalysisUsage, analyze, type ReprocessReason } from "../../analysis/pipeline.js";
import { PROMPT_VERSION } from "../../analysis/prompts/summarize.js";
import type { RequestIntent } from "../../commands/intent.js";
import { targetIdOf } from "../../jobs/targetId.js";
import type { JobPayload } from "../../jobs/types.js";
import { LlmError } from "../../llm/index.js";
import {
  fetchChannelMessages,
  fetchThreadMessages,
  type SlackConversationClient,
  type SlackMessage,
} from "../../slack/conversation.js";
import { buildPermalink } from "../../slack/permalink.js";
import {
  type DiffMark,
  renderSummary,
  renderSummaryDelta,
  type SummaryMessage,
  type SummaryModel,
  type SummaryScope,
} from "../../slack/render.js";
import { NO_UNFURL } from "../../slack/unfurl.js";
import { createUserResolver, type SlackUsersClient } from "../../slack/users.js";
import { type AnalysisState, type Participant, todoIdOf } from "../../store/types.js";
import { dateToTs } from "../../util/time.js";
import { FILTERED_TEXT, type JobContext } from "../server.js";
import { writeSummaryCanvas } from "./canvas.js";
import { createRequestPublisher } from "./requestProgress.js";
import {
  postSummaryTodoList,
  prepareSummaryTodos,
  type SummaryTodoRegistration,
  saveSummaryTodo,
} from "./todos.js";

/** チャネルの直近の範囲（日）。 */
export const CHANNEL_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BuildSummaryOptions = {
  /** 分割の上限（テスト用）。 */
  chunkMaxTokens?: number;
};

export type BuiltSummary = {
  targetId: string;
  state: AnalysisState;
  participants: Participant[];
  /** 項目 ID → 前回からの変化の印。初回は undefined。 */
  marks: ReadonlyMap<string, DiffMark> | undefined;
  /** まとめ（概要、決定事項、未決定事項、問い）が前回から変わったか。ToDo の変化は含めない。初回は undefined。 */
  summaryChanged: boolean | undefined;
  /** 表示用のモデル（decide 済み）。 */
  model: SummaryModel;
  /** 根拠の ts → パーマリンク。 */
  permalink: (ts: string) => string;
  /** 投稿する返信（順に投稿する）。 */
  messages: SummaryMessage[];
  /** 今回取得したメッセージ。 */
  fetched: SlackMessage[];
  reprocessed: ReprocessReason | null;
  usage: AnalysisUsage;
  scope: SummaryScope;
};

/** 本文のメンション（`<@U123>`）のユーザー ID。 */
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export function userIdsOf(messages: readonly SlackMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.userId !== null) ids.add(m.userId);
    for (const r of m.reactions) for (const u of r.userIds) ids.add(u);
    for (const found of m.text.matchAll(MENTION)) {
      if (found[1] !== undefined) ids.add(found[1]);
    }
  }
  return [...ids];
}

/** 取得 → 分析 → 保存 → 表示用のモデルと返信の組み立て。投稿はしない。 */
export async function buildSummary(
  payload: JobPayload,
  ctx: JobContext,
  options: BuildSummaryOptions = {},
): Promise<BuiltSummary> {
  const { slack, store, llm, now } = ctx;
  const today = now();
  const { channelId, threadTs } = payload;
  const targetId = targetIdOf(channelId, threadTs);

  const auth = await slack.auth.test();
  const botUserId = auth.user_id;
  const workspaceUrl = auth.url;
  if (workspaceUrl === undefined) throw new Error("auth.test の応答に url がありません");
  const fetchOptions = botUserId !== undefined ? { botUserId } : {};

  // 取得（スレッド、またはチャネルの直近 7 日）
  const oldestTs =
    threadTs === null
      ? dateToTs(new Date(today.getTime() - CHANNEL_WINDOW_DAYS * DAY_MS))
      : undefined;
  const conversations = slack as unknown as SlackConversationClient;
  const fetched =
    threadTs !== null
      ? await fetchThreadMessages(conversations, channelId, threadTs, fetchOptions)
      : await fetchChannelMessages(conversations, channelId, {
          ...fetchOptions,
          oldest: oldestTs as string,
        });

  // 表示名
  const users = createUserResolver(slack as unknown as SlackUsersClient, now);
  const names = new Map<string, string>();
  for (const id of userIdsOf(fetched)) names.set(id, (await users.getUser(id)).name);

  // 前回の状態
  const prior = await store.targets.get(targetId);

  const result = await analyze({
    llm,
    messages: fetched,
    names,
    now: today,
    ...(botUserId !== undefined ? { botUserId } : {}),
    prior,
    ...(oldestTs !== undefined ? { oldestTs } : {}),
    ...(options.chunkMaxTokens !== undefined ? { chunkMaxTokens: options.chunkMaxTokens } : {}),
    logFields: { targetId },
  });

  // AI の利用量（FR-053）。本文は出さない。
  ctx.log("INFO", "AI の利用量", {
    targetId,
    command: payload.command,
    calls: result.usage.calls,
    input: result.usage.input,
    cachedInput: result.usage.cachedInput,
    output: result.usage.output,
    models: result.usage.models,
    reprocessed: result.reprocessed,
  });

  // 保存
  await store.targets.put({
    targetId,
    kind: threadTs !== null ? "thread" : "channel",
    channelId,
    threadTs,
    lastAnalyzedTs: result.lastAnalyzedTs,
    analyzedDigest: result.analyzedDigest,
    promptVersion: PROMPT_VERSION,
    participants: result.participants,
    state: result.state,
    nextSeq: result.nextSeq,
    canvasSectionMarker: prior?.canvasSectionMarker ?? null,
  });

  // 表示
  const threadOf = new Map(fetched.map((m) => [m.ts, m.threadTs]));
  const permalink = (ts: string): string => {
    const parentTs = threadTs !== null ? threadTs : (threadOf.get(ts) ?? null);
    return buildPermalink(workspaceUrl, channelId, ts, parentTs);
  };
  const model = toSummaryModel(result.state, result.participants, result.marks, result.speakers);
  const scope: SummaryScope = {
    kind: threadTs === null ? "channel" : "thread",
    count: fetched.length,
    firstTs: fetched[0]?.ts ?? null,
    lastTs: fetched[fetched.length - 1]?.ts ?? null,
    ...(threadTs === null
      ? {
          days: CHANNEL_WINDOW_DAYS,
          start: new Date(today.getTime() - CHANNEL_WINDOW_DAYS * DAY_MS).toISOString(),
          end: today.toISOString(),
        }
      : {}),
  };
  const messages = renderSummary(model, {
    permalink,
    ...(result.marks !== undefined ? { marks: result.marks } : {}),
    ...(result.summaryChanged !== undefined ? { summaryChanged: result.summaryChanged } : {}),
    reference: today,
    scope,
  });

  return {
    targetId,
    state: result.state,
    participants: result.participants,
    marks: result.marks,
    summaryChanged: result.summaryChanged,
    model,
    permalink,
    messages,
    fetched,
    reprocessed: result.reprocessed,
    usage: result.usage,
    scope,
  };
}

/**
 * `buildSummary` に、安全フィルタの扱いを足したもの（summarize と todo のジョブで共通）。
 * 安全フィルタは再試行しても同じ結果になる。例外にせず、スレッドにその旨を返信して null を返す。
 */
export async function buildSummaryOrReplyFiltered(
  payload: JobPayload,
  ctx: JobContext,
  options: BuildSummaryOptions = {},
): Promise<BuiltSummary | null> {
  try {
    return await buildSummary(payload, ctx, options);
  } catch (error) {
    if (error instanceof LlmError && error.kind === "content_filter") {
      await ctx.slack.chat.postMessage({
        channel: payload.channelId,
        thread_ts: payload.mentionTs,
        text: FILTERED_TEXT,
        ...NO_UNFURL,
      });
      return null;
    }
    throw error;
  }
}

/** `POST /jobs/summarize`。まとめを作り、メンションされたスレッドに返信する。 */
export async function summarizeJob(payload: JobPayload, ctx: JobContext): Promise<void> {
  await runSummaryRequest(payload, ctx, {
    kind: "summary",
    suppressTodo: false,
    suppressCanvas: false,
  });
}

/** 空メンションと旧まとめコマンドの共通入口。後続の自動処理も同じ分析結果を使う。 */
export async function runSummaryRequest(
  payload: JobPayload,
  ctx: JobContext,
  intent: Extract<RequestIntent, { kind: "summary" }>,
): Promise<void> {
  const publisher = await createRequestPublisher(
    payload,
    ctx,
    targetIdOf(payload.channelId, payload.threadTs),
  );
  const built = await buildSummaryOrReplyFiltered(payload, ctx);
  if (built === null) return;
  const visibleTodos = [];
  for (const todo of built.model.todos) {
    if ((await ctx.store.todos.get(todoIdOf(built.targetId, todo.id)))?.status !== "done")
      visibleTodos.push(todo);
  }
  built.model = { ...built.model, todos: visibleTodos };
  const notes: string[] = [];
  const registered: SummaryTodoRegistration[] = [];
  let todoFailed = 0;
  let canvasResult: Parameters<typeof renderSummaryDelta>[1]["canvas"];
  let canvasFailed = false;
  const inThread = payload.threadTs !== null;
  if (!inThread) notes.push("チャネル直下のため自動記録なし");
  if (inThread && !intent.suppressTodo) {
    const candidates = await prepareSummaryTodos(built, ctx, true);
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const existing = await ctx.store.todos.get(candidate.entry.todoId);
        await saveSummaryTodo(payload, ctx, built, candidate, existing?.listMessageTs ?? "");
        registered.push(candidate);
      } catch {
        failed++;
        ctx.log("WARNING", "ToDo の自動登録に失敗しました", {
          targetId: built.targetId,
          itemId: candidate.item.id,
        });
      }
    }
    const excluded = built.state.todos.filter(
      (item) =>
        !item.closed && (item.assignee === null || item.needsReview || item.evidence.length === 0),
    ).length;
    todoFailed = failed;
    notes.push(
      `ToDo: ${registered.length}件登録${excluded > 0 ? ` / 自動登録対象外 ${excluded}件（担当未定・要確認）` : ""}${failed > 0 ? ` / 登録失敗 ${failed}件` : ""}`,
    );
    await publisher.stage("todos", failed > 0 ? "failed" : "done");
  } else {
    await publisher.stage("todos", "skipped");
  }
  if (inThread && !intent.suppressCanvas) {
    const target = await ctx.store.targets.get(built.targetId);
    if (
      built.model.topics.length > 0 ||
      registered.length > 0 ||
      target?.canvasSectionMarker != null
    ) {
      let status: "done" | "failed" = "done";
      try {
        const canvas = await writeSummaryCanvas(payload, ctx, built);
        canvasResult = { action: canvas.action, link: canvas.link };
        // リンクは本文に書かず、返信の最後に URL ボタンとして付ける（本文の URL は Slack が展開するため）。
        notes.push(`canvas: ${canvas.action === "inserted" ? "作成" : "更新"}`);
      } catch {
        status = "failed";
        canvasFailed = true;
        ctx.log("WARNING", "canvas の自動更新に失敗しました", { targetId: built.targetId });
        notes.push("canvas: 更新失敗（概要とToDoは表示しています）");
      }
      await publisher.stage("canvas", status);
    } else {
      notes.push("canvas: 更新対象なし");
      await publisher.stage("canvas", "skipped");
    }
  } else {
    await publisher.stage("canvas", "skipped");
  }
  if (intent.suppressTodo || intent.suppressCanvas) {
    const skipped =
      intent.suppressTodo && intent.suppressCanvas
        ? "ToDo登録・canvas更新"
        : intent.suppressTodo
          ? "ToDo登録"
          : "canvas更新";
    notes.push(`${skipped}は行っていません（依頼で抑止）`);
  }
  // 前回の状態があり、まとめ（概要、決定事項、未決定事項、問い）が変わっていない再実行は、全文を再掲しない。
  // 初回、全体の処理し直し、抑止・明示の閲覧依頼、チャネル直下、同じ依頼の再試行は、従来どおり全文。
  const concise =
    !publisher.resumed &&
    inThread &&
    !intent.suppressTodo &&
    !intent.suppressCanvas &&
    built.marks !== undefined &&
    built.reprocessed === null &&
    built.summaryChanged === false;
  const messages =
    concise && built.marks !== undefined
      ? renderSummaryDelta(built.model, {
          permalink: built.permalink,
          marks: built.marks,
          reference: ctx.now(),
          ...(canvasResult !== undefined ? { canvas: canvasResult } : {}),
          executionNotes: [
            ...(todoFailed > 0 ? [`ToDo: 登録失敗 ${todoFailed}件`] : []),
            ...(canvasFailed ? ["canvas: 更新失敗"] : []),
          ],
        })
      : renderSummary(built.model, {
          permalink: built.permalink,
          marks: built.marks,
          ...(built.summaryChanged !== undefined ? { summaryChanged: built.summaryChanged } : {}),
          reference: ctx.now(),
          scope: built.scope,
          executionNotes: notes,
          ...(canvasResult !== undefined ? { canvasUrl: canvasResult.link } : {}),
        });
  for (const [index, message] of messages.entries())
    await publisher.publish(`summary:${index}`, message);
  // 簡素な返信で ToDo に変化（new / changed / done）がなければ、完了ボタン付きの一覧も出さない。
  const todoChanged = built.model.todos.some((t) => built.marks?.has(t.id));
  if (registered.length > 0 && (!concise || todoChanged))
    await postSummaryTodoList(payload, ctx, built, registered, publisher.publish);
  await publisher.finish();
}
