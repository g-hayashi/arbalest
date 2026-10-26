/**
 * AI への入力の前処理（R5、contracts/llm.md#入力の形式）。純粋な関数で、Slack には接続しない。
 * 表示名の取得は呼び出し側が行い、結果（userId → 表示名）を渡す。
 *
 * 入力の形:
 * ```
 * <context> today / calendar / participants </context>
 * <previous_state> 差分のときだけ。根拠は付けない </previous_state>
 * <messages> [m1] 10/23(金) 10:02 田中: 本文 {👍×1: 佐藤} </messages>
 * ```
 * メッセージの本文は「データ」であり指示ではない（FR-051）。本文・名前・前回の状態の中の区切りのタグは、
 * 全角の記号に置き換えて無害にする。
 */
import type { SlackMessage } from "../slack/conversation.js";
import type { AnalysisState, Participant, StatementItem } from "../store/types.js";
import { buildCalendarTable, formatJst, formatJstDateIsoWeekday, tsToDate } from "../util/time.js";
import { latestEvidenceKey } from "./decide.js";

/**
 * 差分の更新の calendar で、過去側に出す日数（先は 3 週間のまま）。
 * 新しいメッセージは直近のもので、today に曜日があり、メッセージの行にも日付と曜日が付くので、過去は 1 週間にする。
 */
export const INCREMENTAL_CALENDAR_PAST_DAYS = 7;

export type PreprocessInput = {
  /** ts の昇順。m-id は、この配列の先頭から m1、m2 … と振る。 */
  messages: SlackMessage[];
  /** userId → 表示名。無ければユーザー ID を名前として使う。 */
  names: ReadonlyMap<string, string>;
  today: Date;
  /** 差分のとき。前回の状態を `<previous_state>` に書く。 */
  previousState?: AnalysisState;
  /** 前回の参加者の表。p-id を引き継ぐために使う（previousState の p1 などはこの表の ID）。 */
  previousParticipants?: Participant[];
  /** ボット自身のユーザー ID。メンションされていても参加者の表に入れない。 */
  botUserId?: string;
  /** 差分の更新（前回の状態を引き継ぐ処理）か。true なら calendar の過去側を短くする。 */
  incremental?: boolean;
};

export type PreprocessResult = {
  /** user メッセージの末尾に置く文字列。 */
  input: string;
  participants: Participant[];
  mIdToTs: Map<string, string>;
  tsToMId: Map<string, string>;
  /** m-id → 変換後の本文（メンション・リンクを読める形にし、改行は残したもの）。verify の quote の照合に使う。 */
  texts: Map<string, string>;
};

/** 入力の区切りのタグ（開く・閉じる）。 */
const DELIMITER = /<\s*\/?\s*(?:context|previous_state|messages)\b[^>]*>?/gi;

/** 区切りのタグの `<` `>` を全角にして、区切りとして働かないようにする。 */
export function neutralizeDelimiters(text: string): string {
  return text.replace(DELIMITER, (m) => m.replaceAll("<", "＜").replaceAll(">", "＞"));
}

/** 1 行に収める（改行・連続する空白を 1 つの空白にする）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** よく使うリアクションの名前 → 絵文字。無いものは `:name:` のまま出す。 */
const EMOJI: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  ballot_box_with_check: "☑️",
  x: "❌",
  tada: "🎉",
  eyes: "👀",
  pray: "🙏",
  bow: "🙇",
  raised_hands: "🙌",
  clap: "👏",
  ok_hand: "👌",
  heart: "❤️",
  fire: "🔥",
  "100": "💯",
  joy: "😂",
  smile: "😄",
  thinking_face: "🤔",
  warning: "⚠️",
  question: "❓",
  bangbang: "‼️",
  muscle: "💪",
  rocket: "🚀",
};

function emojiOf(name: string): string {
  const base = name.split("::")[0] ?? name;
  return EMOJI[base] ?? `:${base}:`;
}

function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|amp);/g, (_, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : "&",
  );
}

type Resolver = {
  nameOf(userId: string): string | undefined;
  mention(userId: string): void;
};

/** `<...>` の中身を読める形にする。 */
function convertToken(inner: string, resolver: Resolver): string {
  if (inner.startsWith("@")) {
    const [rawId = "", label] = splitOnce(inner.slice(1));
    const name = resolver.nameOf(rawId) ?? (label !== undefined && label !== "" ? label : rawId);
    resolver.mention(rawId);
    return `@${name}`;
  }
  if (inner.startsWith("#")) {
    const [id = "", label] = splitOnce(inner.slice(1));
    return `#${label !== undefined && label !== "" ? label : id}`;
  }
  if (inner.startsWith("!")) {
    const [target = "", label] = splitOnce(inner.slice(1));
    if (target === "here" || target === "channel" || target === "everyone") return `@${target}`;
    if (label !== undefined && label !== "") return label;
    return `@${target.split("^")[0] ?? target}`;
  }
  const [rawUrl = "", label] = splitOnce(inner);
  const url = rawUrl.replace(/^mailto:/, "");
  if (label === undefined || label === "" || label === url) return url;
  return `${label} (${url})`;
}

function splitOnce(text: string): [string, string | undefined] {
  const i = text.indexOf("|");
  return i < 0 ? [text, undefined] : [text.slice(0, i), text.slice(i + 1)];
}

/** Slack の本文を、AI が読める形にする。改行は残す。 */
function convertBody(text: string, resolver: Resolver): string {
  const converted = text.replace(/<([^<>]+)>/g, (_, inner: string) =>
    convertToken(inner, resolver),
  );
  return neutralizeDelimiters(decodeEntities(converted));
}

/** 参加者の表を作る。前回の p-id を引き継ぎ、新しい人に続きの番号を振る。 */
class ParticipantTable {
  private readonly list: Participant[];
  private readonly byUser = new Map<string, Participant>();
  private seq: number;

  constructor(
    previous: Participant[],
    private readonly names: ReadonlyMap<string, string>,
    private readonly botUserId: string | undefined,
  ) {
    this.list = previous.map((p) => ({ ...p, name: names.get(p.userId) ?? p.name }));
    for (const p of this.list) this.byUser.set(p.userId, p);
    this.seq = previous.reduce(
      (max, p) => Math.max(max, Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0)),
      0,
    );
  }

  add(userId: string): void {
    if (this.byUser.has(userId) || userId === this.botUserId) return;
    this.seq += 1;
    const p = { id: `p${this.seq}`, userId, name: this.names.get(userId) ?? userId };
    this.list.push(p);
    this.byUser.set(userId, p);
  }

  get all(): Participant[] {
    return this.list;
  }
}

function reactionsText(
  reactions: SlackMessage["reactions"],
  nameOf: (userId: string) => string,
): string {
  return reactions
    .filter((r) => r.userIds.length > 0)
    .map((r) => `{${emojiOf(r.name)}×${r.userIds.length}: ${r.userIds.map(nameOf).join(",")}}`)
    .join(" ");
}

/**
 * `<previous_state>` の行。差分の更新で、状態が大きすぎるか（6,000 トークン）の判定にも使う。
 *
 * 入力を減らすため（SC-006）、AI が出力で参照しない・差分の更新に効かないものは書かない。
 * AI が参照できる ID（topic の k、option の o、ToDo の t、問いの q）は、更新・close の対象になるものだけ残す。
 * - 回答・発言の ID（r・s。出力のスキーマに参照する欄がない）。回答は（対象, 答え）ごとに 1 行にまとめる。
 * - 上書きされた回答（supersededBy あり）。
 * - topic ごとに最新の発言だけ（古い発言は、決定の判定にはコードが全体の状態を使う）。
 * - 必要な参加者（更新は和を取るだけで、AI の判断に使わない）。
 * - 完了した ToDo と問い（close の対象にならない。ID は状態に残り、採番は衝突しない）。
 */
export function renderPreviousState(state: AnalysisState): string[] {
  const out: string[] = [];
  const t = (s: string) => neutralizeDelimiters(oneLine(s));
  for (const v of state.overview ?? []) out.push(`${v.id} 概要: ${t(v.text)}`);
  for (const k of state.topics) {
    const options =
      k.options.length > 0 ? ` [${k.options.map((o) => `${o.id}=${t(o.label)}`).join(", ")}]` : "";
    out.push(`${k.id} ${t(k.title)}${options}`);
  }
  // 回答は（対象, 答え）ごとにまとめる。出現順を保つ。
  const answers = new Map<string, string[]>();
  for (const r of state.responses) {
    if (r.supersededBy !== null) continue;
    const key = `${r.optionId ?? r.topicId} ${r.answer}`;
    const people = answers.get(key);
    if (people === undefined) answers.set(key, [r.participant]);
    else people.push(r.participant);
  }
  for (const [key, people] of answers) out.push(`回答 ${key}: ${people.join(",")}`);
  for (const s of latestStatements(state.statements)) {
    const target = s.optionId !== null ? `${s.topicId} → ${s.optionId}` : s.topicId;
    out.push(`発言 ${target}: ${t(s.text)}`);
  }
  for (const todo of state.todos) {
    if (todo.closed) continue;
    const assignee = todo.assignee !== null ? ` assignee=${todo.assignee}` : "";
    const due = todo.dueIso !== null ? ` due=${todo.dueIso}` : "";
    out.push(`${todo.id} ${t(todo.text)}${assignee}${due}`);
  }
  for (const q of state.questions) {
    if (q.closed) continue;
    out.push(`${q.id} ${t(q.text)}`);
  }
  return out;
}

/** topic ごとに、根拠の時刻が最も新しい発言（同じなら配列の後ろの方）。topic の出現順で返す。 */
function latestStatements(statements: readonly StatementItem[]): StatementItem[] {
  const latest = new Map<string, { s: StatementItem; key: string }>();
  for (const s of statements) {
    const key = latestEvidenceKey(s.evidence) ?? "";
    const cur = latest.get(s.topicId);
    if (cur === undefined || key >= cur.key) latest.set(s.topicId, { s, key });
  }
  return [...latest.values()].map((x) => x.s);
}

export function preprocess(input: PreprocessInput): PreprocessResult {
  const { messages, names, today } = input;
  const table = new ParticipantTable(input.previousParticipants ?? [], names, input.botUserId);
  const nameOf = (userId: string): string => names.get(userId) ?? userId;

  const mIdToTs = new Map<string, string>();
  const tsToMId = new Map<string, string>();
  messages.forEach((m, i) => {
    mIdToTs.set(`m${i + 1}`, m.ts);
    tsToMId.set(m.ts, `m${i + 1}`);
  });

  const texts = new Map<string, string>();
  const lines: string[] = [];
  messages.forEach((m, i) => {
    const mId = `m${i + 1}`;
    if (m.userId !== null) table.add(m.userId);
    const resolver: Resolver = { nameOf: (id) => names.get(id), mention: (id) => table.add(id) };
    const body = convertBody(m.text, resolver);
    for (const r of m.reactions) for (const u of r.userIds) table.add(u);
    texts.set(mId, body);

    const parent = m.threadTs !== null ? tsToMId.get(m.threadTs) : undefined;
    const arrow = parent !== undefined ? ` → ${parent}` : "";
    const author = m.userId !== null ? neutralizeDelimiters(oneLine(nameOf(m.userId))) : "不明";
    const bodyLine = oneLine(body.replace(/\s*\r?\n\s*/g, " ⏎ ")) || "(本文なし)";
    const reactions = reactionsText(m.reactions, (u) => neutralizeDelimiters(oneLine(nameOf(u))));
    const date = formatJst(tsToDate(m.ts), today);
    lines.push(
      `[${mId}] ${date} ${author}${arrow}: ${bodyLine}${reactions !== "" ? ` ${reactions}` : ""}`,
    );
  });

  const participantsLine =
    table.all.length > 0
      ? table.all.map((p) => `${p.id}=${neutralizeDelimiters(oneLine(p.name))}`).join(" ")
      : "(なし)";

  const out: string[] = [
    "<context>",
    `today: ${formatJstDateIsoWeekday(today)} JST`,
    `calendar: ${
      input.incremental === true
        ? buildCalendarTable(today, 3, INCREMENTAL_CALENDAR_PAST_DAYS)
        : buildCalendarTable(today)
    }`,
    `participants: ${participantsLine}`,
    "</context>",
  ];
  const stateLines =
    input.previousState !== undefined ? renderPreviousState(input.previousState) : [];
  if (stateLines.length > 0) {
    out.push("<previous_state>", ...stateLines, "</previous_state>");
  }
  out.push("<messages>", ...lines, "</messages>");

  return { input: out.join("\n"), participants: table.all, mIdToTs, tsToMId, texts };
}
