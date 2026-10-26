import { formatInTimeZone } from "date-fns-tz";
import { JST, jstDateIso, nextBusinessDay } from "../util/time.js";
import type { TodoDoc } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** targets、todos、chunk_cache の保存期間（R13）。 */
export const DOC_TTL_MS = 90 * DAY_MS;
/** processed_events の保存期間（R3、R13）。 */
export const EVENT_TTL_MS = 7 * DAY_MS;
/** job_locks のリースの既定（R3）。 */
export const LOCK_LEASE_MS = 15 * 60 * 1000;

export function expireAfter(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

/**
 * リマインドの対象か（contracts/http-and-tasks.md#リマインドの対象）。メモリと Firestore で共有する。
 * - open で、dueIso ≤ 次の営業日（金曜には月曜の分も含む）。
 * - 期限のない ToDo は、月曜だけ対象にする。
 * - lastRemindedOn = 今日 のものは除く。
 */
export function isDueForReminder(todo: TodoDoc, today: Date): boolean {
  if (todo.status !== "open") return false;
  const todayIso = jstDateIso(today);
  if (todo.lastRemindedOn === todayIso) return false;
  if (todo.dueIso === null) {
    return jstWeekdayIsMonday(today);
  }
  return todo.dueIso <= jstDateIso(nextBusinessDay(today));
}

function jstWeekdayIsMonday(date: Date): boolean {
  // ISO の曜日（1=月 … 7=日）
  return formatInTimeZone(date, JST, "i") === "1";
}
