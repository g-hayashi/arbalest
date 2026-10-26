/** ingress が積み、worker が受けるジョブの本文（contracts/http-and-tasks.md#worker）。 */
import type { RequestPeriod } from "../util/time.js";

export type JobCommand = "summarize" | "canvas" | "todo" | "findings" | "request";

export type JobPayload = {
  /** 重複の除去（processed_events）。Cloud Tasks のタスク名と同じ。 */
  taskName: string;
  command: JobCommand;
  teamId: string;
  channelId: string;
  /** null ならチャネルの直近（まとめ: 7 日）。 */
  threadTs: string | null;
  /** 返信の先（threadTs ?? mentionTs）。 */
  mentionTs: string;
  /** 呼んだ人。 */
  userId: string;
  /** 自然文の依頼だけ。worker へ一時的に渡し、ストアやログには保存しない。 */
  requestText?: string;
  /** findings のみ。1〜90。 */
  days?: number;
  /** 自然文の Findings で確定した開始以上・終了未満の期間。旧 days より優先する。 */
  period?: RequestPeriod;
  /** findings のみ。90 日を超える指定を丸めたとき true（worker が返信にその旨を添える）。 */
  clamped?: boolean;
  /** ISO。 */
  requestedAt: string;
};

/** `/jobs/todo-done` の本文。todoId（ボタン）か messageTs（✅ のリアクション）のどちらかが入る。 */
export type TodoDonePayload = {
  taskName: string;
  todoId?: string;
  messageTs?: string;
  channelId: string;
  userId: string;
};

/** 完了のボタンの action_id（一覧とリマインドのボタン、ingress の block_actions で共通）。 */
export const TODO_DONE_ACTION_ID = "todo_done";

/**
 * canvas を開く URL ボタンの action_id。URL ボタンは押すと block_actions も届くので、ingress は ack だけして何も積まない。
 * canvas のリンクを本文に書くと Slack がプレビューを展開するため、ボタンにしている。
 */
export const CANVAS_OPEN_ACTION_ID = "canvas_open";

/** Cloud Scheduler が呼ぶパス（JST の平日 9:00）。タスクではないので JOB_PATHS には入れない。 */
export const REMINDERS_PATH = "/cron/reminders";

/** worker のパス。ジョブの登録（registerJob）と ingress のタスクで同じ値を使う。 */
export const JOB_PATHS = {
  request: "/jobs/request",
  summarize: "/jobs/summarize",
  canvas: "/jobs/canvas",
  todo: "/jobs/todo",
  findings: "/jobs/findings",
  todoDone: "/jobs/todo-done",
} as const;
