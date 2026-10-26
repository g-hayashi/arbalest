/**
 * ToDo の登録と完了（US2、data-model.md#todos、contracts/http-and-tasks.md#worker）。
 * - `/jobs/todo`: まとめを作り、未完了の ToDo を `todos` に登録して、完了ボタン付きの一覧を返信する。
 * - `/jobs/todo-done`: ボタンか ✅ で完了にして、一覧のメッセージを更新する。
 *
 * 返信の宛先は payload（channelId、mentionTs）だけから決める。AI の出力は宛先に影響しない（FR-051）。
 * 担当者の宛先（リマインド）は reminders.ts。
 */

import type { JobPayload, TodoDonePayload } from "../../jobs/types.js";
import { buildPermalink } from "../../slack/permalink.js";
import { renderTodoList, type SummaryMessage, type TodoListEntry } from "../../slack/render.js";
import { NO_UNFURL } from "../../slack/unfurl.js";
import { createUserResolver, type SlackUsersClient } from "../../slack/users.js";
import { type TodoDoc, type TodoItem, todoIdOf } from "../../store/types.js";
import type { JobContext } from "../server.js";
import { type BuiltSummary, buildSummaryOrReplyFiltered } from "./summarize.js";

export const NOT_ALLOWED_TEXT = "この ToDo を完了にできるのは、担当者か登録した人だけです。";

/** 担当者か、登録した人か。 */
function canComplete(todo: TodoDoc, userId: string): boolean {
  return todo.assigneeUserId === userId || todo.createdBy === userId;
}

/** `t2` < `t10` になる並び（項目 ID の末尾の番号）。 */
function byItemId(a: TodoDoc, b: TodoDoc): number {
  const na = Number(/\d+$/.exec(a.itemId)?.[0] ?? Number.NaN);
  const nb = Number(/\d+$/.exec(b.itemId)?.[0] ?? Number.NaN);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

export type SummaryTodoRegistration = { item: TodoItem; entry: TodoListEntry };

/** 分析結果から登録候補を選ぶ。自動登録は担当者と根拠を確認できる項目に限る。 */
export async function prepareSummaryTodos(
  built: BuiltSummary,
  ctx: JobContext,
  automatic = false,
): Promise<SummaryTodoRegistration[]> {
  const userIdOf = new Map(built.participants.map((p) => [p.id, p.userId]));
  const nameOf = new Map(built.participants.map((p) => [p.id, p.name]));
  const knownTs = new Set(built.fetched.map((m) => m.ts));
  const registered: SummaryTodoRegistration[] = [];
  for (const item of built.state.todos) {
    if (item.closed) continue;
    if (
      automatic &&
      (item.assignee === null ||
        !userIdOf.has(item.assignee) ||
        item.needsReview ||
        item.evidence.length === 0 ||
        !item.evidence.every((ts) => knownTs.has(ts)))
    )
      continue;
    const todoId = todoIdOf(built.targetId, item.id);
    if ((await ctx.store.todos.get(todoId))?.status === "done") continue;
    registered.push({
      item,
      entry: {
        todoId,
        text: item.text,
        assignee: item.assignee === null ? null : (nameOf.get(item.assignee) ?? null),
        dueIso: item.dueIso,
        dueText: item.dueText,
        evidence: item.evidence,
        needsReview: item.needsReview,
        doneBy: null,
        done: false,
      },
    });
  }
  return registered;
}

/** stable ID で登録し、既存の完了状態・リマインド履歴はストア側で維持する。 */
export async function saveSummaryTodo(
  payload: JobPayload,
  ctx: JobContext,
  built: BuiltSummary,
  registration: SummaryTodoRegistration,
  listMessageTs: string,
): Promise<void> {
  const { item } = registration;
  const assignee = built.participants.find((p) => p.id === item.assignee)?.userId ?? null;
  await ctx.store.todos.upsert({
    targetId: built.targetId,
    itemId: item.id,
    channelId: payload.channelId,
    threadTs: payload.threadTs ?? payload.mentionTs,
    text: item.text,
    dueIso: item.dueIso,
    dueText: item.dueText,
    assigneeUserId: assignee,
    createdBy: payload.userId,
    listMessageTs,
    sourceTs: item.evidence,
  });
}

/** `POST /jobs/todo`。 */
export async function todoJob(payload: JobPayload, ctx: JobContext): Promise<void> {
  const built = await buildSummaryOrReplyFiltered(payload, ctx);
  if (built === null) return;

  const registered = await prepareSummaryTodos(built, ctx);
  await postSummaryTodoList(payload, ctx, built, registered);
}

/** 完了操作で更新する専用一覧を投稿する。概要の返信とは分ける。 */
export async function postSummaryTodoList(
  payload: JobPayload,
  ctx: JobContext,
  built: BuiltSummary,
  registered: readonly SummaryTodoRegistration[],
  publish?: (slot: string, message: SummaryMessage) => Promise<string>,
): Promise<void> {
  const { slack, now } = ctx;
  const messages = renderTodoList(
    registered.map((r) => r.entry),
    { permalink: built.permalink, reference: now() },
  );
  const byTodoId = new Map(registered.map((r) => [r.entry.todoId, r]));

  for (const [index, message] of messages.entries()) {
    const res =
      publish === undefined
        ? await slack.chat.postMessage({
            channel: payload.channelId,
            thread_ts: payload.mentionTs,
            text: message.text,
            blocks: message.blocks,
            ...NO_UNFURL,
          })
        : { ts: await publish(`todos:${index}`, message) };
    if (message.todoIds.length === 0) continue;
    if (res.ts === undefined) throw new Error("chat.postMessage の応答に ts がありません");
    for (const todoId of message.todoIds) {
      const registration = byTodoId.get(todoId);
      if (registration !== undefined)
        await saveSummaryTodo(payload, ctx, built, registration, res.ts);
    }
  }
}

/** 一覧のメッセージを、今の ToDo の状態で作り直して更新する（失敗しても完了は取り消さない）。 */
async function refreshList(todo: TodoDoc, ctx: JobContext): Promise<void> {
  if (todo.listMessageTs === "") return;
  const { slack, store, now } = ctx;
  try {
    const siblings = (await store.todos.findByMessageTs(todo.channelId, todo.listMessageTs))
      .filter((t) => t.listMessageTs === todo.listMessageTs)
      .sort(byItemId);
    const target = await store.targets.get(todo.targetId);
    const auth = await slack.auth.test();
    if (auth.url === undefined) throw new Error("auth.test の応答に url がありません");
    const workspaceUrl = auth.url;
    const parentTs = target !== null ? target.threadTs : todo.threadTs;
    const users = createUserResolver(slack as unknown as SlackUsersClient, now);
    const nameOf = async (userId: string | null): Promise<string | null> =>
      userId === null ? null : (await users.getUser(userId)).name;

    const entries: TodoListEntry[] = [];
    for (const t of siblings) {
      entries.push({
        todoId: t.todoId,
        text: t.text,
        assignee: await nameOf(t.assigneeUserId),
        dueIso: t.dueIso,
        dueText: t.dueText,
        evidence: t.sourceTs,
        needsReview: target?.state.todos.find((i) => i.id === t.itemId)?.needsReview ?? false,
        doneBy: await nameOf(t.doneBy),
        done: t.status === "done",
      });
    }
    const [message] = renderTodoList(entries, {
      permalink: (ts) => buildPermalink(workspaceUrl, todo.channelId, ts, parentTs),
      reference: now(),
    });
    if (message === undefined) return;
    await slack.chat.update({
      channel: todo.channelId,
      ts: todo.listMessageTs,
      text: message.text,
      blocks: message.blocks,
    });
  } catch (error) {
    ctx.log("WARNING", "ToDo の一覧を更新できませんでした", {
      todoId: todo.todoId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `POST /jobs/todo-done`。todoId（ボタン）か messageTs（✅）で ToDo を特定する。
 * - ボタン: 権限のない人には、本人にだけ知らせる。
 * - ✅: 権限のない人の操作は黙って無視する。✅ が一覧や元の発言に付いたとき、権限のある未完了の ToDo が
 *   ちょうど 1 件に決まる場合だけ完了にする（決まらなければ何もしない）。
 */
export async function todoDoneJob(payload: TodoDonePayload, ctx: JobContext): Promise<void> {
  const { slack, store } = ctx;
  const { userId } = payload;

  let target: TodoDoc | undefined;
  if (payload.todoId !== undefined) {
    const todo = await store.todos.get(payload.todoId);
    if (todo === null) {
      ctx.log("INFO", "完了の対象の ToDo がありません", { todoId: payload.todoId });
      return;
    }
    if (!canComplete(todo, userId)) {
      try {
        await slack.chat.postEphemeral({
          channel: payload.channelId,
          user: userId,
          text: NOT_ALLOWED_TEXT,
        });
      } catch (error) {
        ctx.log("WARNING", "権限がない旨を通知できませんでした", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    target = todo;
  } else if (payload.messageTs !== undefined) {
    const found = await store.todos.findByMessageTs(payload.channelId, payload.messageTs);
    const candidates = found.filter((t) => t.status === "open" && canComplete(t, userId));
    if (candidates.length !== 1) {
      ctx.log("INFO", "✅ の対象の ToDo を決められないため、何もしません", {
        candidates: candidates.length,
      });
      return;
    }
    target = candidates[0];
  }
  if (target === undefined) return;

  const result = await store.todos.markDone(target.todoId, userId);
  if (result === null || !result.changed) return;
  await refreshList(result.todo, ctx);
}
