import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** 表示と判定の時刻帯（R6）。JST は夏時間がないので、1日は常に 24 時間として数えてよい。 */
export const JST = "Asia/Tokyo";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 自然文から抽出する期間の種類。日時そのものは AI に決めさせない。 */
export type RequestPeriodSpec = {
  kind: "default" | "last_week" | "this_week" | "this_month" | "rolling_days" | "rolling_weeks";
  amount: number | null;
};

/** 取得期間は start 以上、end 未満の半開区間（UTC ISO）とする。 */
export type RequestPeriod = {
  start: string;
  end: string;
  label: string;
  clamped: boolean;
};

/** 依頼の期間を JST の規則で確定する。不正な指定は null として確認へ戻す。 */
export function resolveRequestPeriod(spec: RequestPeriodSpec, now: Date): RequestPeriod | null {
  const current = now.getTime();
  if (!Number.isFinite(current)) return null;
  let start: Date;
  let end = now;
  let label: string;
  switch (spec.kind) {
    case "rolling_days":
    case "rolling_weeks": {
      if (spec.amount === null || !Number.isSafeInteger(spec.amount) || spec.amount < 1)
        return null;
      const days = Math.min(spec.amount * (spec.kind === "rolling_weeks" ? 7 : 1), 90);
      start = new Date(current - days * DAY_MS);
      label = `直近${days}日`;
      return {
        start: start.toISOString(),
        end: now.toISOString(),
        label,
        clamped: spec.amount * (spec.kind === "rolling_weeks" ? 7 : 1) > 90,
      };
    }
    case "default":
      if (spec.amount !== null) return null;
      start = new Date(current - 30 * DAY_MS);
      label = "直近30日";
      break;
    case "last_week":
    case "this_week": {
      if (spec.amount !== null) return null;
      const monday = new Date(startOfJstDay(now).getTime() - ((jstWeekday(now) + 6) % 7) * DAY_MS);
      start = spec.kind === "last_week" ? new Date(monday.getTime() - 7 * DAY_MS) : monday;
      if (spec.kind === "last_week") end = monday;
      label = spec.kind === "last_week" ? "先週" : "今週";
      break;
    }
    case "this_month":
      if (spec.amount !== null) return null;
      start = fromZonedTime(`${jstDateIso(now).slice(0, 7)}-01T00:00:00`, JST);
      label = "今月";
      break;
    default:
      return null;
  }
  const lower = current - 90 * DAY_MS;
  const clamped = start.getTime() < lower;
  if (clamped) start = new Date(lower);
  return { start: start.toISOString(), end: end.toISOString(), label, clamped };
}

/** Slack の ts（`"1729746180.123456"`）を Date にする。ミリ秒未満は切り捨てる。 */
export function tsToDate(ts: string): Date {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(ts);
  if (!m) throw new Error(`不正な ts: ${ts}`);
  const sec = Number(m[1]);
  const ms = Number((m[2] ?? "").padEnd(3, "0").slice(0, 3));
  return new Date(sec * 1000 + ms);
}

/** Date を Slack の ts 形式（秒.6桁）にする。精度はミリ秒まで。 */
export function dateToTs(date: Date): string {
  const t = date.getTime();
  const sec = Math.floor(t / 1000);
  const ms = t - sec * 1000;
  return `${sec}.${String(ms).padStart(3, "0")}000`;
}

/** JST の日付を `2025-10-24` の形式で返す。 */
export function jstDateIso(date: Date): string {
  return formatInTimeZone(date, JST, "yyyy-MM-dd");
}

/** JST の曜日（0=日 … 6=土）。 */
function jstWeekday(date: Date): number {
  return Number(formatInTimeZone(date, JST, "i")) % 7;
}

/** JST の曜日の漢字（日〜土）。 */
export function jstWeekdayJa(date: Date): string {
  return WEEKDAYS_JA[jstWeekday(date)] ?? "";
}

/**
 * `10/24(金)` の形式。reference を渡し、JST の年が reference と違えば `2027/1/4(月)` のように年を付ける。
 */
export function formatJstMonthDayWeekday(date: Date, reference?: Date): string {
  const withYear =
    reference !== undefined &&
    formatInTimeZone(date, JST, "yyyy") !== formatInTimeZone(reference, JST, "yyyy");
  const md = formatInTimeZone(date, JST, withYear ? "yyyy/M/d" : "M/d");
  return `${md}(${jstWeekdayJa(date)})`;
}

/** `10/24(金) 14:03` の形式。reference と年が違えば年を付ける（`2027/1/4(月) 14:03`）。 */
export function formatJst(date: Date, reference?: Date): string {
  return `${formatJstMonthDayWeekday(date, reference)} ${formatInTimeZone(date, JST, "HH:mm")}`;
}

/** `2026-10-23(金)` の形式（JST）。 */
export function formatJstDateIsoWeekday(date: Date): string {
  return `${jstDateIso(date)}(${jstWeekdayJa(date)})`;
}

/** JST の日付の 0 時。 */
export function startOfJstDay(date: Date): Date {
  return fromZonedTime(`${jstDateIso(date)}T00:00:00`, JST);
}

/** JST で月〜金なら営業日。祝日は考慮しない。 */
export function isBusinessDay(date: Date): boolean {
  const w = jstWeekday(date);
  return w >= 1 && w <= 5;
}

/** JST で、date の日より後の最初の営業日の 0 時。 */
export function nextBusinessDay(date: Date): Date {
  let d = new Date(startOfJstDay(date).getTime() + DAY_MS);
  while (!isBusinessDay(d)) {
    d = new Date(d.getTime() + DAY_MS);
  }
  return d;
}

/**
 * 今日（JST）から前後 3 週間の日付と曜日の表。`10/3(金) 10/4(土) ...` のように空白で区切る。
 * 土日も含める（「今週土曜」のような表現のため）。AI が相対表現を誤らないようにするための手がかり。
 * 表が年をまたぐときは、年が変わる日（1/1）から `2027/1/4(月)` のように年を付ける。
 * `pastDays` で過去側の日数だけを短くできる（差分の更新で入力を減らすため。先の `weeks` 週間は変えない）。
 */
export function buildCalendarTable(today: Date, weeks = 3, pastDays = weeks * 7): string {
  const base = startOfJstDay(today).getTime();
  const days = weeks * 7;
  const first = new Date(base - pastDays * DAY_MS);
  const items: string[] = [];
  for (let i = -pastDays; i <= days; i++) {
    items.push(formatJstMonthDayWeekday(new Date(base + i * DAY_MS), first));
  }
  return items.join(" ");
}
