/**
 * ingress: Slack のイベントを JobPayload に変えて Cloud Tasks に積む（contracts/http-and-tasks.md#ingress）。
 * Firestore は読まない。タスクを積み終えてから戻る（R2: 呼び出し側がその後に ack する）。
 */
import { parseCommand } from "../commands/parse.js";
import {
  JOB_PATHS,
  type JobPayload,
  TODO_DONE_ACTION_ID,
  type TodoDonePayload,
} from "../jobs/types.js";
import { actionTaskName, eventTaskName, type TaskEnqueuer } from "../tasks/enqueue.js";
import { log } from "../util/log.js";

/** ingress が Slack に送る軽い操作。テストではフェイクに差し替える。 */
export interface IngressSlack {
  addReaction(channel: string, timestamp: string, name: string): Promise<void>;
  postMessage(channel: string, threadTs: string, text: string): Promise<void>;
}

export type IngressDeps = {
  botUserId: string;
  now: () => Date;
  slack: IngressSlack;
  enqueue: TaskEnqueuer;
};

/** Events API の外側の封筒のうち、使う欄。 */
export type EventEnvelope = { event_id: string; team_id: string };

export type AppMentionEvent = {
  channel: string;
  user?: string;
  bot_id?: string;
  ts: string;
  thread_ts?: string;
  text?: string;
};

export type ReactionAddedEvent = {
  user: string;
  reaction: string;
  item: { type: string; channel?: string; ts?: string };
};

export type BlockActionsBody = {
  team?: { id?: string };
  user: { id: string };
  channel?: { id?: string };
  container?: { channel_id?: string };
  actions: { action_id: string; value?: string; action_ts: string }[];
};

export const RECEIVED_REACTION = "eyes";
export const DONE_REACTION = "white_check_mark";
export { TODO_DONE_ACTION_ID };

export const USAGE_TEXT = [
  "使い方: スレッドでメンションだけ、または自然文で依頼できます。",
  "• 根拠付きの概要、決定・未決定・ToDo、取得件数・時刻範囲を返信します",
  "• スレッド内では未完了で担当者と根拠を確認できた ToDo を自動登録し、調整事項があれば canvas の管理節を更新します。既存節は空になっても更新します",
  "• 返信で登録件数・要確認・canvas の結果を確認できます。完了は ToDo 一覧のボタンか ✅ で操作します",
  "• `見るだけ`、`登録しないでまとめて`: ToDo 登録と canvas 更新を抑止し、返信のみ",
  "• チャネル直下: 直近7日を対象に返信のみ（自動記録なし）",
  "• `先週の動きを振り返って`、`この2週間の学びは？`: 対象期間を示して Findings を返信します",
  "• 期間は JST。先週は前週月曜0時〜今週月曜0時未満、今週は月曜0時〜現在、今月は月初0時〜現在。直近N日・このN週間は現在から遡ります（既定30日・最大90日）",
  "• 意図や期間が曖昧な場合は、操作せず確認を返信します",
  "従来のコマンドも使えます:",
  "• `まとめ`（`summary`、`要約`）: メンションだけの場合と同じ一括処理",
  "• `canvas`（`キャンバス`）: まとめをチャネルの canvas に書き出します（スレッドの中で）",
  "• `todo`（`タスク`）: ToDo を登録して一覧を返信します",
  "• `findings 30日`（`振り返り 14日`）: 指定日数の振り返り（既定30日・最大90日）",
].join("\n");

/** メンション本文から、ボット自身のメンションを除く。 */
function stripBotMention(text: string, botUserId: string): string {
  return text.replaceAll(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "");
}

/** app_mention: 既知コマンドか依頼文をタスクに積み、👀 を付ける。自然文は worker で解釈する。 */
export async function dispatchAppMention(
  event: AppMentionEvent,
  envelope: EventEnvelope,
  deps: IngressDeps,
): Promise<void> {
  if (event.bot_id !== undefined || event.user === undefined) return;

  const command = parseCommand(stripBotMention(event.text ?? "", deps.botUserId));
  const taskName = eventTaskName(envelope.event_id);
  const payload: JobPayload = {
    taskName,
    command: command.kind,
    teamId: envelope.team_id,
    channelId: event.channel,
    threadTs: event.thread_ts ?? null,
    mentionTs: event.ts,
    userId: event.user,
    requestedAt: deps.now().toISOString(),
  };
  if (command.kind === "findings") {
    payload.days = command.days;
    if (command.clamped) payload.clamped = true;
  }
  if (command.kind === "request") payload.requestText = command.text;

  await deps.enqueue({ name: taskName, path: JOB_PATHS[command.kind], payload });

  // 受付の印。積み済みなので、失敗してもジョブは止めない。
  try {
    await deps.slack.addReaction(event.channel, event.ts, RECEIVED_REACTION);
  } catch (error) {
    log("WARNING", "受付のリアクションを付けられませんでした", {
      channelId: event.channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** reaction_added: ✅ だけを /jobs/todo-done に積む。対象かどうかは worker が判断する。 */
export async function dispatchReactionAdded(
  event: ReactionAddedEvent,
  envelope: EventEnvelope,
  deps: IngressDeps,
): Promise<void> {
  if (event.reaction !== DONE_REACTION) return;
  if (event.user === deps.botUserId) return;
  const { item } = event;
  if (item.type !== "message" || item.channel === undefined || item.ts === undefined) return;

  const taskName = eventTaskName(envelope.event_id);
  const payload: TodoDonePayload = {
    taskName,
    messageTs: item.ts,
    channelId: item.channel,
    userId: event.user,
  };
  await deps.enqueue({ name: taskName, path: JOB_PATHS.todoDone, payload });
}

/** block_actions: `todo_done` のボタンを /jobs/todo-done に積む。 */
export async function dispatchBlockActions(
  body: BlockActionsBody,
  deps: IngressDeps,
): Promise<void> {
  const action = body.actions.find((a) => a.action_id === TODO_DONE_ACTION_ID);
  if (action === undefined || action.value === undefined || action.value === "") return;
  const channelId = body.channel?.id ?? body.container?.channel_id;
  if (channelId === undefined) return;

  const taskName = actionTaskName(action.action_ts, body.user.id);
  const payload: TodoDonePayload = {
    taskName,
    todoId: action.value,
    channelId,
    userId: body.user.id,
  };
  await deps.enqueue({ name: taskName, path: JOB_PATHS.todoDone, payload });
}
