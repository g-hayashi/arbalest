/** Teams元スレッドの日次通知。通知は結果不明時の重複を許容し、送信済みslotから再開する。 */
import { randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { isBusinessDay, JST, jstDateIso, nextBusinessDay } from "../util/time.js";
import { TeamsApiError } from "./graph.js";
import { isTrustedTeamsServiceUrl } from "./ingress.js";
import { type TeamsRecordWriter, validateTeamsRecordMessage } from "./records.js";
import { escapeTeamsText } from "./render.js";
import { teamsWorkTargetId, validateTeamsSnapshot } from "./store/common.js";
import {
  type JsonValue,
  type TeamsScope,
  type TeamsTodo,
  TeamsWorkError,
  type TeamsWorkStore,
} from "./store/types.js";

export type TeamsReminderDeps = {
  store: TeamsWorkStore;
  writer: Pick<TeamsRecordWriter, "create">;
  now: () => Date;
  /** feature・allowlist・アプリ有効状態を外部送信直前にも検査する。未確認時はfalse。 */
  canSend: (scope: TeamsScope) => Promise<boolean>;
  owner?: string;
  maxAttempts?: number;
};
export type TeamsWorkJobContext = {
  log?: (severity: "WARNING" | "ERROR", message: string, fields?: Record<string, unknown>) => void;
};

export function selectTeamsReminderTodos(todos: TeamsTodo[], now: Date): TeamsTodo[] {
  if (!isBusinessDay(now)) return [];
  const limit = jstDateIso(nextBusinessDay(now));
  const monday = formatInTimeZone(now, JST, "i") === "1";
  return todos.filter((todo) => {
    if (todo.status !== "open" || todo.expireAt.getTime() <= now.getTime()) return false;
    if (todo.dueIso === null) return monday;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(todo.dueIso)
      ? todo.dueIso
      : jstDateIso(new Date(todo.dueIso));
    return due <= limit;
  });
}

function render(todo: TeamsTodo, names: JsonValue | undefined): string {
  const map = names && typeof names === "object" && !Array.isArray(names) ? names : {};
  const name =
    todo.assigneeAadId === null
      ? "未定（登録者が管理）"
      : typeof map[todo.assigneeAadId] === "string"
        ? String(map[todo.assigneeAadId])
        : "担当者（表示名未取得）";
  const text = [
    "期限通知: 次営業日までの未完了ToDo（期限未定は月曜通知）",
    `T${todo.displayNo} ${escapeTeamsText(todo.text)} / 担当: ${escapeTeamsText(name)} / 期限: ${escapeTeamsText(todo.dueIso ?? todo.dueText ?? "未定")}`,
    ...todo.evidence.map((e) => `根拠: ${e.link}`),
    `完了方法: このスレッドでボットに done T${todo.displayNo} を依頼。通知停止・再開: 管理者がToDo一覧の通知ボタンを操作。`,
  ].join("\n");
  validateTeamsRecordMessage({ text });
  return text;
}

export function createTeamsRemindersJob(deps: TeamsReminderDeps) {
  const maxAttempts = deps.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new TypeError("通知再試行回数が不正です");
  return async (_payload: unknown, ctx: TeamsWorkJobContext): Promise<void> => {
    const today = deps.now();
    if (!isBusinessDay(today) || formatInTimeZone(today, JST, "HH:mm") < "09:00") return;
    const date = jstDateIso(today);
    let firstError: unknown;
    threads: for (const settings of await deps.store.listSettings()) {
      const scope = settings.scope;
      if (settings.disabled || !settings.notificationsEnabled) continue;
      try {
        if (!(await deps.canSend(scope))) continue;
        const operationId = JSON.stringify([date, teamsWorkTargetId(scope), "reminder"]);
        let effect = await deps.store.getEffect(operationId);
        if (!effect) {
          const todos = selectTeamsReminderTodos(await deps.store.getTodos(scope), today);
          if (todos.length === 0) continue;
          const record = await deps.store.getRecord(scope);
          const content = record?.snapshot.content;
          const names =
            content && typeof content === "object" && !Array.isArray(content)
              ? content.names
              : undefined;
          const revision = record?.desiredRevision ?? 1;
          effect = (
            await deps.store.reserveEffect({
              scope,
              operationId,
              kind: "reminder",
              revision,
              now: deps.now(),
              expireAt: settings.expireAt,
              snapshot: {
                scope,
                revision,
                todos,
                slots: todos.map((todo) => render(todo, names)),
                ...(names ? { content: { names } } : {}),
              },
            })
          ).effect;
        }
        validateTeamsSnapshot(effect.snapshot, scope, effect.revision);
        if (
          effect.attempts >= maxAttempts ||
          effect.state === "applied" ||
          effect.state === "cancelled"
        )
          continue;
        if (effect.state === "failed" && effect.slots.some((slot) => slot.state === "failed"))
          continue;
        if (effect.nextAttemptAt && effect.nextAttemptAt.getTime() > deps.now().getTime())
          throw new TeamsApiError(429, effect.nextAttemptAt.getTime() - deps.now().getTime());
        const lease = await deps.store.claimEffect(
          operationId,
          deps.owner ?? randomUUID(),
          deps.now(),
        );
        if (!lease) continue;
        const owned = () => ({
          scope,
          operationId,
          owner: lease.leaseOwner,
          fencingToken: lease.fencingToken,
          now: deps.now(),
        });
        try {
          for (const slot of lease.slots) {
            if (slot.state === "applied" || slot.state === "retired") continue;
            const activeLease = await deps.store.extendEffectLease(owned());
            // 予約時の本文は変えず、現在の完了・期限・停止・保持・接続状態だけを再検査する。
            const liveSettings = await deps.store.getSettings(scope);
            if (
              jstDateIso(deps.now()) !== date ||
              !liveSettings ||
              liveSettings.disabled ||
              !liveSettings.notificationsEnabled ||
              !(await deps.canSend(scope))
            )
              continue threads;
            const live = selectTeamsReminderTodos(await deps.store.getTodos(scope), deps.now());
            const snapshotTodo = lease.snapshot.todos[slot.slot];
            if (!snapshotTodo || !live.some((todo) => todo.todoId === snapshotTodo.todoId)) {
              continue;
            }
            if (
              !liveSettings.serviceUrl ||
              !isTrustedTeamsServiceUrl(liveSettings.serviceUrl) ||
              (liveSettings.conversationId !== scope.channelId &&
                liveSettings.conversationId !==
                  `${scope.channelId};messageid=${scope.rootMessageId}`)
            )
              throw new TeamsWorkError("invalid_scope");
            validateTeamsRecordMessage({ text: slot.text });
            if (deps.now().getTime() >= activeLease.leaseUntil.getTime())
              throw new TeamsWorkError("lease_lost");
            const sent = await deps.writer.create(
              scope,
              {
                serviceUrl: liveSettings.serviceUrl,
                conversationId: `${scope.channelId};messageid=${scope.rootMessageId}`,
              },
              { text: slot.text },
            );
            if (!sent.activityId?.trim()) throw new TeamsApiError(0);
            slot.activityId = sent.activityId;
            slot.state = "applied";
            slot.appliedRevision = lease.revision;
            await deps.store.saveEffect({ ...owned(), slots: lease.slots });
          }
          await deps.store.saveEffect({
            ...owned(),
            state: "applied",
            slots: lease.slots,
            nextAttemptAt: null,
          });
        } catch (error) {
          // 保存前にプロセスが停止した場合は同じslotが重複し得る。管理投稿のcreating停止は使用しない。
          if (
            error instanceof TeamsWorkError &&
            ["disabled", "expired", "lease_lost", "not_found"].includes(error.code)
          )
            continue;
          const retryAfterMs =
            error instanceof TeamsApiError && error.status === 429 ? error.retryAfterMs : null;
          if (
            error instanceof TeamsApiError &&
            !error.retryable &&
            ![401, 403, 404].includes(error.status)
          ) {
            for (const slot of lease.slots) if (slot.state !== "applied") slot.state = "failed";
            await deps.store.saveEffect({ ...owned(), state: "failed", slots: lease.slots });
            ctx.log?.("WARNING", "Teams通知を再試行できません", { status: error.status });
            continue;
          }
          await deps.store.saveEffect({
            ...owned(),
            state: "failed",
            nextAttemptAt:
              retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
                ? new Date(deps.now().getTime() + retryAfterMs)
                : null,
          });
          if (error instanceof TeamsApiError && [401, 403, 404].includes(error.status)) {
            if (error.status === 404) await deps.store.disableThread({ scope, now: deps.now() });
            else await deps.store.stopNotifications({ scope, now: deps.now() });
            ctx.log?.("WARNING", "Teams通知停止・再接続確認が必要です", { status: error.status });
          } else throw error;
        }
      } catch (error) {
        if (
          error instanceof TeamsWorkError &&
          ["disabled", "expired", "lease_lost", "not_found"].includes(error.code)
        )
          continue;
        ctx.log?.("ERROR", "Teams通知処理に失敗しました", {
          code: error instanceof TeamsWorkError ? error.code : "send_failed",
        });
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };
}
