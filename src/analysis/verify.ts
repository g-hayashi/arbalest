/**
 * AI の出力の検証（data-model.md の V1〜V5）。純粋な関数。
 * 問題があっても項目は捨てずに `needsReview` と理由を付ける（V1 で残った根拠が 0 件のときも同じ）。
 * 例外は V5 だけで、実在しない ID を参照する操作は捨てる。
 *
 * - V1 evidence: 入力に存在する m-id だけを残す。1 つも残らなければ needsReview。
 * - V2 quote: NFKC にして空白・句読点・記号を除いたものが、根拠のメッセージに含まれること。
 * - V3 participant / assignee: 参加者の表にあること。
 * - V4 dueIso / dateIso: 日付として正しい、元の表現の曜日と一致する、発言の日より 30 日以上前でない。
 * - V5 ref: 差分の `close` と `upsert` が参照する既存の ID が実在すること。
 */
import { jstDateIso, tsToDate } from "../util/time.js";

/** 要確認の理由（`reviewReasons` に入れる文言）。 */
export const REASON = {
  noEvidence: "根拠のメッセージが見つからない",
  quoteNotFound: "引用が根拠のメッセージに含まれない",
  unknownParticipant: "参加者の表にない人",
  invalidDate: "日付として不正",
  weekdayMismatch: "日付と曜日が一致しない",
  oldDate: "発言の日より 30 日以上前の日付",
} as const;

/** 発言の日より何日以上前なら要確認にするか（V4）。 */
export const OLD_DATE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** V2 の正規化: NFKC にして、空白・句読点・記号・制御文字を除く。 */
export function normalizeQuote(text: string): string {
  return text.normalize("NFKC").replace(/[\p{White_Space}\p{P}\p{S}\p{Cc}\p{Cf}]/gu, "");
}

/** 元の表現に含まれる曜日（`(火)`、`（火）`、`(火曜)`、`火曜日`）。`10月28日` の「月」は曜日ではない。 */
export function detectWeekdays(text: string): string[] {
  const found = new Set<string>();
  const re = /[(（]\s*([日月火水木金土])\s*(?:曜日?)?\s*[)）]|([日月火水木金土])曜日?/g;
  for (const m of text.matchAll(re)) {
    const w = m[1] ?? m[2];
    if (w !== undefined) found.add(w);
  }
  return [...found];
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** `YYYY-MM-DD` が実在する日付なら、UTC の 0 時のミリ秒。 */
function parseIsoDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

export type DateVerification = {
  /** 不正な日付は null。 */
  dateIso: string | null;
  needsReview: boolean;
  reasons: string[];
};

/**
 * V4。`messageTs` は発言（根拠）の ts。`sourceText` は日付の元の表現（`due_text` やオプションのラベル）。
 */
export function verifyDate(
  dateIso: string | null,
  options: { messageTs: string; sourceText?: string | null },
): DateVerification {
  if (dateIso === null) return { dateIso: null, needsReview: false, reasons: [] };
  const ms = parseIsoDate(dateIso);
  if (ms === null) {
    return { dateIso: null, needsReview: true, reasons: [`${REASON.invalidDate}: ${dateIso}`] };
  }
  const reasons: string[] = [];
  const weekdays = detectWeekdays(options.sourceText ?? "");
  const actual = WEEKDAYS[new Date(ms).getUTCDay()];
  if (weekdays.length > 0 && actual !== undefined && !weekdays.includes(actual)) {
    reasons.push(REASON.weekdayMismatch);
  }
  const messageDay = parseIsoDate(jstDateIso(tsToDate(options.messageTs)));
  if (messageDay !== null && (messageDay - ms) / DAY_MS >= OLD_DATE_DAYS) {
    reasons.push(REASON.oldDate);
  }
  return { dateIso, needsReview: reasons.length > 0, reasons };
}

export type VerifyContext = {
  /** m-id → 変換後の本文（preprocess の `texts`）。 */
  texts: ReadonlyMap<string, string>;
  /** m-id → ts（preprocess の `mIdToTs`）。 */
  mIdToTs: ReadonlyMap<string, string>;
  /** 参加者の表の ID（`p1` など）。 */
  participantIds: ReadonlySet<string>;
  /** 根拠が 1 つもないときの、日付の基準。 */
  today: Date;
};

export type VerifyItemInput = {
  /** AI が返した m-id。 */
  evidence: string[];
  /** 引用。渡さなければ V2 は行わない。 */
  quote?: string | null;
  /** participant / assignee / required_participants の ID。null と undefined は未指定。 */
  participants?: (string | null | undefined)[];
  /** dueIso / dateIso と、その元の表現。 */
  dates?: { dateIso: string | null; sourceText?: string | null }[];
};

export type VerifyResult = {
  /** 入力に存在した m-id（重複を除く。AI が返した順）。 */
  evidence: string[];
  /** evidence に対応する ts。 */
  evidenceTs: string[];
  /** `input.dates` に対応する日付。不正なものは null。 */
  dates: (string | null)[];
  /** 参加者の表にない ID。呼び出し側が項目から外してよい。 */
  invalidParticipants: string[];
  needsReview: boolean;
  reviewReasons: string[];
};

/** V1〜V4 を 1 つの項目に対して行う。 */
export function verifyItem(item: VerifyItemInput, ctx: VerifyContext): VerifyResult {
  const reasons: string[] = [];

  // V1
  const evidence = [...new Set(item.evidence)].filter((id) => ctx.mIdToTs.has(id));
  const evidenceTs = evidence.map((id) => ctx.mIdToTs.get(id) as string);
  if (evidence.length === 0) reasons.push(REASON.noEvidence);

  // V2
  if (item.quote !== undefined && item.quote !== null) {
    const q = normalizeQuote(item.quote);
    const found =
      q !== "" && evidence.some((id) => normalizeQuote(ctx.texts.get(id) ?? "").includes(q));
    if (!found) reasons.push(REASON.quoteNotFound);
  }

  // V3
  const invalidParticipants = [
    ...new Set(
      (item.participants ?? []).filter(
        (p): p is string => typeof p === "string" && !ctx.participantIds.has(p),
      ),
    ),
  ];
  for (const p of invalidParticipants) reasons.push(`${REASON.unknownParticipant}: ${p}`);

  // V4: 基準は、根拠のうち最も新しい発言
  const latestTs = evidenceTs.reduce<string | null>(
    (latest, ts) => (latest === null || tsToDate(ts) > tsToDate(latest) ? ts : latest),
    null,
  );
  const baseTs = latestTs ?? `${Math.floor(ctx.today.getTime() / 1000)}.000000`;
  const dates = (item.dates ?? []).map((d) => {
    const v = verifyDate(d.dateIso, { messageTs: baseTs, sourceText: d.sourceText });
    reasons.push(...v.reasons);
    return v.dateIso;
  });

  const reviewReasons = [...new Set(reasons)];
  return {
    evidence,
    evidenceTs,
    dates,
    invalidParticipants,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}

/**
 * V5。`ref` が null（新規）か、既存の ID に実在する操作だけ残す。実在しない ID を参照する操作は
 * `dropped` に入れる（呼び出し側がログに記録する）。
 */
export function partitionKnownRefs<T>(
  ops: T[],
  getRef: (op: T) => string | null,
  existingIds: ReadonlySet<string>,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const op of ops) {
    const ref = getRef(op);
    (ref === null || existingIds.has(ref) ? kept : dropped).push(op);
  }
  return { kept, dropped };
}
