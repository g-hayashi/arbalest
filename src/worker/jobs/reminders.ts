/**
 * リマインド（US2、`POST /cron/reminders`、contracts/http-and-tasks.md#リマインドの対象）。
 * 対象は `todos.findDueForReminder(now)`（open、期限が次の営業日まで、期限なしは月曜、今日送った分は除く）。
 * 宛先は `assigneeUserId ?? createdBy`。担当者が退出・削除されていれば（T023）`createdBy` に替え、
 * 本文に「担当者が不在です」と添える。1 人に 1 通の DM（`chat.postMessage(channel = userId)`）にまとめる。
 *
 * 宛先はストアの値だけから決める。AI の出力や会話の内容は関係しない（FR-051）。
 * 送ったら `markReminded` で記録する（同じ日の再実行で二重に送らない）。
 */

import { buildPermalink } from "../../slack/permalink.js";
import { type ReminderEntry, renderReminder } from "../../slack/render.js";
import { NO_UNFURL } from "../../slack/unfurl.js";
import { createUserResolver, type SlackUsersClient } from "../../slack/users.js";
import type { TodoDoc } from "../../store/types.js";
import { jstDateIso } from "../../util/time.js";
import type { JobContext } from "../server.js";

/** 再試行しても送れない宛先（退職・無効化など）。ログだけ残し、他の宛先の処理と再試行を妨げない。 */
const PERMANENT_DM_ERRORS = new Set([
  "user_not_found",
  "account_inactive",
  "user_disabled",
  "cannot_dm_bot",
  "user_not_visible",
]);

function slackErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : null;
}

/** 期限の近い順（期限なしは最後）。 */
function byDue(a: ReminderEntry, b: ReminderEntry): number {
  if (a.dueIso !== b.dueIso) {
    if (a.dueIso === null) return 1;
    if (b.dueIso === null) return -1;
    return a.dueIso < b.dueIso ? -1 : 1;
  }
  return a.todoId < b.todoId ? -1 : a.todoId > b.todoId ? 1 : 0;
}

export async function remindersJob(_payload: unknown, ctx: JobContext): Promise<void> {
  const { slack, store, now } = ctx;
  const today = now();
  const todos = await store.todos.findDueForReminder(today);
  if (todos.length === 0) return;

  const auth = await slack.auth.test();
  if (auth.url === undefined) throw new Error("auth.test の応答に url がありません");
  const workspaceUrl = auth.url;
  const users = createUserResolver(slack as unknown as SlackUsersClient, now);
  const todayIso = jstDateIso(today);

  // 宛先ごとにまとめる
  const groups = new Map<string, ReminderEntry[]>();
  const add = (userId: string, todo: TodoDoc, entry: Omit<ReminderEntry, "todoId">) => {
    const list = groups.get(userId) ?? [];
    list.push({ ...entry, todoId: todo.todoId });
    groups.set(userId, list);
  };
  for (const todo of todos) {
    let recipient = todo.createdBy;
    let assignee: string | null = null;
    let absent = false;
    if (todo.assigneeUserId !== null) {
      const user = await users.getUser(todo.assigneeUserId);
      assignee = user.name;
      if (user.deleted) absent = true;
      else recipient = todo.assigneeUserId;
    }
    add(recipient, todo, {
      text: todo.text,
      dueIso: todo.dueIso,
      dueText: todo.dueText,
      threadUrl: buildPermalink(workspaceUrl, todo.channelId, todo.threadTs, null),
      assignee,
      assigneeAbsent: absent,
      overdue: todo.dueIso !== null && todo.dueIso < todayIso,
    });
  }

  // 送る。1 つの宛先の失敗で他を止めない。一時的な失敗は最後に投げ直す（再試行で、送っていない分だけ送る）。
  let firstError: unknown;
  for (const [userId, entries] of groups) {
    try {
      for (const message of renderReminder([...entries].sort(byDue), { reference: today })) {
        await slack.chat.postMessage({
          channel: userId,
          text: message.text,
          blocks: message.blocks,
          ...NO_UNFURL,
        });
        await store.todos.markReminded(message.todoIds, today);
      }
    } catch (error) {
      const code = slackErrorCode(error);
      if (code !== null && PERMANENT_DM_ERRORS.has(code)) {
        ctx.log("WARNING", "リマインドを送れない宛先です", { code });
        continue;
      }
      ctx.log("ERROR", "リマインドの送信に失敗しました", {
        error: error instanceof Error ? error.message : String(error),
      });
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
