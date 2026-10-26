/**
 * Slack への表示（contracts/commands-and-output.md#返信、docs/ai-analysis-design.md の「6. 表示」）。
 * 純粋な関数だけ。AI には文章を書かせず、判定済みのモデルから Block Kit をコードで作る。
 *
 * このファイルの `SummaryModel` は、decide.ts / merge.ts（US1 の次の回で作る）が出す形の目安。
 * 表示の都合で、参加者は p-id ではなく表示名、日付は ISO のまま、根拠は Slack の ts で持つ。
 */
import { formatInTimeZone } from "date-fns-tz";
import { CANVAS_OPEN_ACTION_ID, TODO_DONE_ACTION_ID } from "../jobs/types.js";
import { formatJstMonthDayWeekday, JST, type RequestPeriod, tsToDate } from "../util/time.js";

// ---- 表示用のモデル ----

/** 前回からの変化の印。 */
export type DiffMark = "new" | "changed" | "done";

/** 項目に共通の欄。 */
export type SummaryItemBase = {
  /** 項目 ID（k1、t1、q1 …）。差分の印の `marks` を引くキー。 */
  id: string;
  /** 根拠のメッセージの ts。1 つ以上。リンクにする。 */
  evidence: string[];
  /** 根拠を確かめられなかった項目（V1、V2、V4、D6）。⚠️ を付ける。 */
  needsReview: boolean;
};

export type SummaryTopic = SummaryItemBase & {
  title: string;
  /** decide.ts の判定（D1〜D6）。decided は「決定事項」、open は「未決定事項」に出す。 */
  status: "decided" | "open";
  /** decided のとき、決まった内容の表示（選択肢の label か確定の発言）。open では null。 */
  decision: string | null;
  /** open のとき、候補の label の一覧。 */
  options: string[];
  /** open のとき、有効な回答がない人の表示名（D5）。 */
  pendingParticipants: string[];
};

export type SummaryTodo = SummaryItemBase & {
  text: string;
  /** 担当者の表示名。決まっていなければ null。 */
  assignee: string | null;
  /** `YYYY-MM-DD`（JST）。 */
  dueIso: string | null;
  /** 元の表現（「来週火曜」）。dueIso が無いときに表示する。 */
  dueText: string | null;
};

export type SummaryQuestion = SummaryItemBase & {
  text: string;
};

/**
 * 表示する項目。完了した ToDo や解決した問いは、完了の印（`marks` が `done`）を付けて 1 回だけ含めてよい。
 * 以後の返信では含めない。
 */
export type SummaryModel = {
  overview?: (SummaryItemBase & { text: string })[];
  topics: SummaryTopic[];
  todos: SummaryTodo[];
  questions: SummaryQuestion[];
};

export type SummaryScope = {
  kind: "thread" | "channel";
  count: number;
  firstTs: string | null;
  lastTs: string | null;
  days?: number;
  start?: string;
  end?: string;
};

export type RenderSummaryOptions = {
  /** 根拠の ts → パーマリンク。 */
  permalink: (ts: string) => string;
  /**
   * 項目 ID → 前回からの変化の印（merge.ts の表示用の差分）。
   * 渡すと見出しに件数を出す（変化なしでも渡す）。初回は渡さない。表示しない項目の印も件数に数える。
   */
  marks?: ReadonlyMap<string, DiffMark>;
  /**
   * まとめ（概要、決定事項、未決定事項、問い）が前回から変わったか（`summaryChanged`）。
   * 印の件数が 0 でも true なら、見出しを「概要を更新」にする（概要は印を持たないため）。
   */
  summaryChanged?: boolean;
  /** 期限の表示で、年が違うときに年を付けるための基準日。 */
  reference?: Date;
  scope?: SummaryScope;
  executionNotes?: readonly string[];
  /** canvas の URL。渡すと、最後のメッセージに「canvas を開く」の URL ボタンを 1 つ付ける（本文と text には入れない）。 */
  canvasUrl?: string;
};

// ---- Block Kit（使う部分だけ。@slack/types の KnownBlock に代入できる） ----

/** 完了のボタン（section の accessory）。 */
export type ButtonAccessory = {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value: string;
  style?: "primary";
};
export type SectionBlock = {
  type: "section";
  text: { type: "mrkdwn"; text: string };
  accessory?: ButtonAccessory;
};
export type ContextBlock = { type: "context"; elements: { type: "mrkdwn"; text: string }[] };
/** canvas を開く URL ボタン。本文に URL を書くと Slack が canvas のプレビューを展開するため、ボタンにする。 */
export type UrlButton = {
  type: "button";
  text: { type: "plain_text"; text: string };
  url: string;
  action_id: string;
};
export type ActionsBlock = { type: "actions"; elements: UrlButton[] };
export type SummaryBlock = SectionBlock | ContextBlock | ActionsBlock;

/** 1 通の返信（`chat.postMessage` の text と blocks）。 */
export type SummaryMessage = { text: string; blocks: SummaryBlock[] };

export const EMPTY_SUMMARY_TEXT = "まとめる調整事項は見つかりませんでした";
const REVIEW_NOTE = "⚠️ 要確認: 根拠を確かめられなかった項目には ⚠️ を付けています";

/** Block Kit の上限（1 通のブロック数、section の本文の文字数）。 */
export const MAX_BLOCKS = 50;
export const MAX_SECTION_CHARS = 3000;

/** 分類の見出し。 */
const GROUP_TITLES = ["決定事項", "未決定事項", "ToDo", "未解決の問い"] as const;
/** 見出しの最大長（「（続き）」付き）。1 行だけで section を超える項目を切るときの room の計算に使う。 */
const MAX_HEADING_CHARS = Math.max(...GROUP_TITLES.map((t) => `*${t}（続き）*`.length));

const MARK_ICON: Record<DiffMark, string> = { new: "🆕", changed: "✏️", done: "✅" };
/** 根拠のリンクを並べる上限（行が長くなりすぎないように）。 */
const MAX_EVIDENCE_LINKS = 3;

// ---- 部品 ----

/** Slack の mrkdwn で特別な `& < >` を置き換える（`<!channel>` などのメンション・リンクの記法を無効にする）。 */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function evidenceLinks(evidence: string[], permalink: (ts: string) => string): string {
  // V1 で根拠が 0 件のまま ⚠️ で残った項目（SC-004）。リンクの代わりに明示する。
  if (evidence.length === 0) return "根拠なし";
  const shown = evidence.slice(0, MAX_EVIDENCE_LINKS);
  if (shown.length === 1) return `<${permalink(shown[0] as string)}|根拠>`;
  return shown.map((ts, i) => `<${permalink(ts)}|${i + 1}>`).join(" ");
}

function dueLabel(todo: SummaryTodo, reference: Date | undefined): string | null {
  if (todo.dueIso !== null) {
    const date = new Date(`${todo.dueIso}T00:00:00+09:00`);
    if (!Number.isNaN(date.getTime())) return formatJstMonthDayWeekday(date, reference);
  }
  return todo.dueText;
}

type Line = { body: string; item: SummaryItemBase };

/** 1 項目の行。本文が長すぎれば、末尾のリンクと印を残して本文を切る。 */
function finishLine(line: Line, opts: RenderSummaryOptions): string {
  const mark = opts.marks?.get(line.item.id);
  const tail =
    `  ${evidenceLinks(line.item.evidence, opts.permalink)}` +
    (line.item.needsReview ? " ⚠️" : "") +
    (mark ? `  ${MARK_ICON[mark]}` : "");
  const room = MAX_SECTION_CHARS - MAX_HEADING_CHARS - "\n".length - "• ".length - tail.length;
  const body =
    line.body.length > room ? `${line.body.slice(0, Math.max(0, room - 1))}…` : line.body;
  return `• ${body}${tail}`;
}

function topicBody(t: SummaryTopic): string {
  const title = escapeMrkdwn(t.title);
  if (t.status === "decided") return `${title}: ${escapeMrkdwn(t.decision ?? "決定")}`;
  const options =
    t.options.length > 0 ? `: ${t.options.map((o) => escapeMrkdwn(o)).join(" / ")}` : "";
  const pending =
    t.pendingParticipants.length > 0
      ? ` — 回答待ち: ${t.pendingParticipants.map((n) => `@${escapeMrkdwn(n)}`).join(", ")}`
      : "";
  return `${title}${options}${pending}`;
}

function todoBody(t: SummaryTodo, reference: Date | undefined): string {
  const assignee = t.assignee === null ? "担当未定" : `@${escapeMrkdwn(t.assignee)}`;
  const due = dueLabel(t, reference);
  return `${escapeMrkdwn(t.text)} — ${assignee}${due === null ? "" : ` / 期限 ${escapeMrkdwn(due)}`}`;
}

/** 見出し付きの行を、3,000 文字以内の section に詰める。続きの section には「（続き）」付きの見出しを付け直す。 */
function packSections(title: string, lines: string[]): SectionBlock[] {
  const sections: SectionBlock[] = [];
  let heading = `*${title}*`;
  let current: string[] = [];
  let length = heading.length;
  const flush = () => {
    if (current.length === 0) return;
    sections.push({
      type: "section",
      text: { type: "mrkdwn", text: [heading, ...current].join("\n") },
    });
    heading = `*${title}（続き）*`;
    current = [];
    length = heading.length;
  };
  for (const line of lines) {
    if (current.length > 0 && length + 1 + line.length > MAX_SECTION_CHARS) flush();
    current.push(line);
    length += 1 + line.length;
  }
  flush();
  return sections;
}

function countMarks(marks: ReadonlyMap<string, DiffMark>, summaryChanged = false): string {
  let added = 0;
  let changed = 0;
  let done = 0;
  for (const m of marks.values()) {
    if (m === "new") added++;
    else if (m === "changed") changed++;
    else done++;
  }
  if (added + changed + done === 0)
    return summaryChanged ? "前回から: 概要を更新" : "前回から: 変更なし";
  return `前回から: 追加 ${added} / 変更 ${changed} / 完了 ${done}`;
}

const section = (text: string): SectionBlock => ({
  type: "section",
  text: { type: "mrkdwn", text },
});
const context = (text: string): ContextBlock => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});
/** canvas を開く URL ボタンだけの actions ブロック。 */
export const canvasButtonBlock = (url: string): ActionsBlock => ({
  type: "actions",
  elements: [
    {
      type: "button",
      text: { type: "plain_text", text: "canvas を開く" },
      url,
      action_id: CANVAS_OPEN_ACTION_ID,
    },
  ],
});

/** canvas の書き出しを知らせる 1 通。リンクは本文ではなくボタンにする。 */
export function renderCanvasWritten(url: string): SummaryMessage {
  const text = "🗒️ このスレッドのまとめをチャネルの canvas に書き出しました";
  return { text, blocks: [section(text), canvasButtonBlock(url)] };
}

// ---- 本体 ----

/**
 * まとめ（summarize と todo の共通部分）を Block Kit にする。
 * 50 ブロックを超える場合は、続きの返信（`📋 調整のまとめ（続き）`）に分ける。返す配列を順に投稿する。
 */
export function renderSummary(model: SummaryModel, opts: RenderSummaryOptions): SummaryMessage[] {
  const header = `📋 調整のまとめ${opts.marks ? `（${countMarks(opts.marks, opts.summaryChanged)}）` : ""}`;
  const continued = "📋 調整のまとめ（続き）";

  const decided = model.topics.filter((t) => t.status === "decided");
  const open = model.topics.filter((t) => t.status === "open");
  const groups: { title: string; lines: Line[] }[] = [
    { title: GROUP_TITLES[0], lines: decided.map((t) => ({ body: topicBody(t), item: t })) },
    { title: GROUP_TITLES[1], lines: open.map((t) => ({ body: topicBody(t), item: t })) },
    {
      title: GROUP_TITLES[2],
      lines: model.todos.map((t) => ({ body: todoBody(t, opts.reference), item: t })),
    },
    {
      title: GROUP_TITLES[3],
      lines: model.questions.map((q) => ({ body: escapeMrkdwn(q.text), item: q })),
    },
  ];

  const body: SummaryBlock[] = [];
  if (opts.scope !== undefined) {
    const s = opts.scope;
    const target = s.kind === "thread" ? "スレッド" : `チャネル直近${s.days ?? 7}日`;
    const stamp = (value: string) => formatInTimeZone(tsToDate(value), JST, "yyyy/MM/dd HH:mm");
    const times =
      s.count > 0 && s.firstTs !== null && s.lastTs !== null
        ? ` / 最初 ${stamp(s.firstTs)} / 最後 ${stamp(s.lastTs)} JST`
        : "";
    body.push(context(`取得範囲: ${target} / 投稿${s.count}件${times}`));
    if (s.start !== undefined && s.end !== undefined) {
      const date = (value: string) => formatInTimeZone(new Date(value), JST, "yyyy/MM/dd HH:mm");
      body.push(context(`対象期間: ${date(s.start)}〜${date(s.end)} JST`));
    }
    body.push(context("Slackで取得可能な履歴（最大90日）を対象にしています"));
  }
  const overview = opts.scope?.count === 0 ? [] : (model.overview ?? []);
  if (overview.length > 0)
    body.push(
      ...packSections(
        "会話の概要",
        overview.map((item) => finishLine({ body: escapeMrkdwn(item.text), item }, opts)),
      ),
    );
  let anyReview = overview.some((item) => item.needsReview);
  let hasAdjustments = false;
  for (const g of groups) {
    if (g.lines.length === 0) continue;
    hasAdjustments = true;
    anyReview ||= g.lines.some((l) => l.item.needsReview);
    body.push(
      ...packSections(
        g.title,
        g.lines.map((l) => finishLine(l, opts)),
      ),
    );
  }
  const isEmpty = !hasAdjustments;
  if (isEmpty) body.push(section(EMPTY_SUMMARY_TEXT));
  if (anyReview) body.push(context(REVIEW_NOTE));
  for (const note of opts.executionNotes ?? []) body.push(context(note));
  if (opts.canvasUrl !== undefined) body.push(canvasButtonBlock(opts.canvasUrl));

  return splitMessages(header, continued, body);
}

/** 50 ブロックごとに返信を分ける。各返信の先頭に見出しを置く。 */
function splitMessages(header: string, continued: string, body: SummaryBlock[]): SummaryMessage[] {
  const messages: SummaryMessage[] = [];
  let blocks: SummaryBlock[] = [section(header)];
  for (const block of body) {
    if (blocks.length >= MAX_BLOCKS) {
      messages.push({ text: summaryFallback(blocks), blocks });
      blocks = [section(continued)];
    }
    blocks.push(block);
  }
  messages.push({ text: summaryFallback(blocks), blocks });
  return messages;
}

export type SummaryDeltaOptions = {
  permalink: (ts: string) => string;
  /** `diffMarks` の印。ToDo の変化の件数と、載せる行を決める。 */
  marks: ReadonlyMap<string, DiffMark>;
  reference?: Date;
  /** 今回の canvas の書き出し結果。書き出していなければ渡さない。 */
  canvas?: { action: "inserted" | "replaced" | "updated"; link: string };
  /** 末尾に添える補足（canvas の失敗など）。 */
  executionNotes?: readonly string[];
};

/**
 * 前回の状態がある再実行で、まとめ（概要、決定事項、未決定事項、問い）が変わっていないときの簡素な返信。
 * 全文は再掲しない。ToDo の変化（印の付いた ToDo）か canvas の新規作成があれば、その件を示す。
 * どちらもなければ「前回から変更はありません。」と canvas のリンクだけにする。
 */
export function renderSummaryDelta(
  model: SummaryModel,
  opts: SummaryDeltaOptions,
): SummaryMessage[] {
  const changedTodos = model.todos.filter((t) => opts.marks.has(t.id));
  const parts: string[] = [];
  if (changedTodos.length > 0) parts.push(`ToDo: 変更 ${changedTodos.length}件`);
  if (opts.canvas !== undefined && (changedTodos.length > 0 || opts.canvas.action === "inserted"))
    parts.push(`canvas: ${opts.canvas.action === "inserted" ? "作成" : "更新"}`);
  const header =
    parts.length > 0
      ? `📋 まとめに変更はありません。${parts.join(" / ")}`
      : "📋 前回から変更はありません。";

  const body: SummaryBlock[] = [];
  if (changedTodos.length > 0) {
    const lineOpts: RenderSummaryOptions = { permalink: opts.permalink, marks: opts.marks };
    body.push(
      ...packSections(
        "ToDo",
        changedTodos.map((t) =>
          finishLine({ body: todoBody(t, opts.reference), item: t }, lineOpts),
        ),
      ),
    );
  }
  for (const note of opts.executionNotes ?? []) body.push(context(note));
  if (opts.canvas !== undefined) body.push(canvasButtonBlock(opts.canvas.link));
  return splitMessages(header, "📋 まとめに変更はありません（続き）", body);
}

function summaryFallback(blocks: readonly SummaryBlock[]): string {
  return blocks
    .flatMap(
      (b) =>
        b.type === "section"
          ? [b.text.text]
          : b.type === "context"
            ? [b.elements.map((e) => e.text).join(" ")]
            : [], // actions（canvas のボタン）は通知の text に入れない
    )
    .join("\n")
    .slice(0, 4000);
}

// ---- ToDo の一覧とリマインド（US2） ----

export const NO_TODO_TEXT = "登録する ToDo は見つかりませんでした";

function doneButton(todoId: string): ButtonAccessory {
  return {
    type: "button",
    text: { type: "plain_text", text: "完了" },
    action_id: TODO_DONE_ACTION_ID,
    value: todoId,
    style: "primary",
  };
}

/** 一覧の 1 項目（登録された ToDo の表示用の値）。 */
export type TodoListEntry = {
  todoId: string;
  text: string;
  /** 担当者の表示名。担当未定なら null。 */
  assignee: string | null;
  dueIso: string | null;
  dueText: string | null;
  evidence: string[];
  needsReview: boolean;
  /** 完了していれば、完了した人の表示名。 */
  doneBy: string | null;
  done: boolean;
};

/** 一覧・リマインドの 1 通。`todoIds` は、そのメッセージに載せた ToDo（listMessageTs の保存、送信済みの記録に使う）。 */
export type TodoListMessage = SummaryMessage & { todoIds: string[] };

/**
 * ToDo の一覧（`todo` の返信と、完了後の更新）。まとめの ToDo 部分と同じ形で、未完了の項目に完了のボタンを付ける。
 * 1 項目 1 section。見出しを含め 50 ブロックを超える分は、続きの返信に分ける。
 */
export function renderTodoList(
  entries: readonly TodoListEntry[],
  opts: RenderSummaryOptions,
): TodoListMessage[] {
  if (entries.length === 0) {
    return [{ text: NO_TODO_TEXT, blocks: [section(NO_TODO_TEXT)], todoIds: [] }];
  }
  const perMessage = MAX_BLOCKS - 1;
  const messages: TodoListMessage[] = [];
  for (let i = 0; i < entries.length; i += perMessage) {
    const chunk = entries.slice(i, i + perMessage);
    const done = chunk.filter((e) => e.done).length;
    const title = `📋 ToDo 一覧（完了 ${done} / ${chunk.length} 件）`;
    const blocks: SummaryBlock[] = [section(title)];
    for (const e of chunk) {
      const item: SummaryTodo = {
        id: e.todoId,
        evidence: e.evidence,
        needsReview: e.needsReview,
        text: e.text,
        assignee: e.assignee,
        dueIso: e.dueIso,
        dueText: e.dueText,
      };
      const base = todoBody(item, opts.reference);
      const body = e.done ? `~${base}~ ✅ 完了（@${escapeMrkdwn(e.doneBy ?? "不明")}）` : base;
      const block: SectionBlock = section(finishLine({ body, item }, opts));
      if (!e.done) block.accessory = doneButton(e.todoId);
      blocks.push(block);
    }
    messages.push({ text: title, blocks, todoIds: chunk.map((e) => e.todoId) });
  }
  return messages;
}

/** リマインドの 1 項目。 */
export type ReminderEntry = {
  todoId: string;
  text: string;
  dueIso: string | null;
  dueText: string | null;
  /** 元のスレッドへのリンク。 */
  threadUrl: string;
  /** 担当者の表示名。担当未定なら null。 */
  assignee: string | null;
  /** 担当者が退出・削除されている（宛先は登録した人に替えている）。 */
  assigneeAbsent: boolean;
  /** 期限が今日より前。 */
  overdue: boolean;
};

function reminderLine(e: ReminderEntry, reference: Date | undefined): string {
  const assignee =
    e.assignee === null
      ? "担当未定"
      : `@${escapeMrkdwn(e.assignee)}${e.assigneeAbsent ? "（担当者が不在です）" : ""}`;
  const due = dueLabel(
    {
      id: e.todoId,
      evidence: [],
      needsReview: false,
      text: e.text,
      assignee: e.assignee,
      dueIso: e.dueIso,
      dueText: e.dueText,
    },
    reference,
  );
  const dueText = due === null ? "" : ` / 期限 ${escapeMrkdwn(due)}`;
  const tail = `  <${e.threadUrl}|スレッド>`;
  const head = e.overdue ? "⏰ *期限切れ* " : "";
  const room =
    MAX_SECTION_CHARS - tail.length - head.length - assignee.length - dueText.length - 16;
  const text = e.text.length > room ? `${e.text.slice(0, Math.max(0, room - 1))}…` : e.text;
  return `• ${head}${escapeMrkdwn(text)} — ${assignee}${dueText}${tail}`;
}

/**
 * 1 人宛てのリマインド（DM）。各項目に完了のボタンと元のスレッドへのリンクを付ける。
 * 並びは呼び出し側が決める。50 ブロックを超える分は、続きの DM に分ける。
 */
export function renderReminder(
  entries: readonly ReminderEntry[],
  opts: { reference?: Date } = {},
): TodoListMessage[] {
  const perMessage = MAX_BLOCKS - 1;
  const messages: TodoListMessage[] = [];
  for (let i = 0; i < entries.length; i += perMessage) {
    const chunk = entries.slice(i, i + perMessage);
    const title =
      i === 0 ? `⏰ ToDo のリマインド（${entries.length} 件）` : "⏰ ToDo のリマインド（続き）";
    const blocks: SummaryBlock[] = [section(title)];
    for (const e of chunk) {
      const block = section(reminderLine(e, opts.reference));
      block.accessory = doneButton(e.todoId);
      blocks.push(block);
    }
    messages.push({ text: title, blocks, todoIds: chunk.map((e) => e.todoId) });
  }
  return messages;
}

// ---- Findings（US4） ----

export type FindingsFinding = {
  statement: string;
  /** 根拠のメッセージの ts（昇順）。 */
  evidence: string[];
  /** 根拠を確かめられなかった Finding（V1、V2）。⚠️ を付ける。 */
  needsReview: boolean;
};
export type FindingsTheme = { theme: string; findings: FindingsFinding[] };

/** findings の表示用のモデル。 */
export type FindingsModel = {
  channelId: string;
  /** 実際に使った期間（日）。 */
  days: number;
  /** 90 日を超える指定を丸めたか。 */
  clamped: boolean;
  period?: RequestPeriod;
  scope?: Pick<SummaryScope, "count" | "firstTs" | "lastTs">;
  themes: FindingsTheme[];
};

export const EMPTY_FINDINGS_TEXT = "この期間に Findings は見つかりませんでした";
const FINDINGS_CLAMPED_NOTE = "指定の期間が長いため、上限の 90 日に制限しました";
/** テーマ名の最大長（見出しが長くなりすぎないように）。 */
const MAX_THEME_CHARS = 100;

/**
 * findings の返信（contracts/commands-and-output.md#返信）。テーマごとに見出しを付け、Finding を 1 行にする。
 * 50 ブロックを超える場合は、続きの返信（`🔎 Findings（続き）`）に分ける。返す配列を順に投稿する。
 */
export function renderFindings(
  model: FindingsModel,
  opts: Pick<RenderSummaryOptions, "permalink">,
): SummaryMessage[] {
  const title = `🔎 Findings（<#${model.channelId}>、${model.period?.label ?? `直近 ${model.days} 日`}）`;
  const header =
    (model.period?.clamped ?? model.clamped) ? `${title}\n${FINDINGS_CLAMPED_NOTE}` : title;
  const continued = "🔎 Findings（続き）";

  const body: SummaryBlock[] = [];
  let anyReview = false;
  for (const t of model.themes) {
    if (t.findings.length === 0) continue;
    const theme = escapeMrkdwn(
      t.theme.length > MAX_THEME_CHARS ? `${t.theme.slice(0, MAX_THEME_CHARS - 1)}…` : t.theme,
    );
    const heading = `テーマ: ${theme}`;
    // 見出しは「（続き）」付きが最も長い。本文が長すぎる Finding は、末尾のリンクと印を残して切る。
    const headingChars = `*${heading}（続き）*`.length;
    const lines = t.findings.map((f) => {
      anyReview ||= f.needsReview;
      const tail = `  ${evidenceLinks(f.evidence, opts.permalink)}${f.needsReview ? " ⚠️" : ""}`;
      const room = MAX_SECTION_CHARS - headingChars - "\n".length - "• ".length - tail.length;
      const text = escapeMrkdwn(f.statement);
      return `• ${text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text}${tail}`;
    });
    body.push(...packSections(heading, lines));
  }
  const isEmpty = body.length === 0;
  const range: SummaryBlock[] = [];
  if (model.period !== undefined) {
    const stamp = (value: string) => formatInTimeZone(new Date(value), JST, "yyyy/MM/dd HH:mm");
    range.push(
      context(`対象期間: ${stamp(model.period.start)}以上〜${stamp(model.period.end)}未満 JST`),
    );
  }
  if (model.scope !== undefined) {
    const s = model.scope;
    const stamp = (value: string) => formatInTimeZone(tsToDate(value), JST, "yyyy/MM/dd HH:mm");
    const times =
      s.count > 0 && s.firstTs !== null && s.lastTs !== null
        ? ` / 最初 ${stamp(s.firstTs)} / 最後 ${stamp(s.lastTs)} JST`
        : "";
    range.push(context(`取得範囲: 投稿${s.count}件${times}`));
    range.push(context("Slackで取得可能な履歴（最大90日）を対象にしています"));
  }
  if (isEmpty) body.push(section(EMPTY_FINDINGS_TEXT));
  if (anyReview) body.push(context(REVIEW_NOTE));

  const messages: SummaryMessage[] = [];
  let blocks: SummaryBlock[] = [section(header), ...range];
  let text = title;
  for (const block of body) {
    if (blocks.length >= MAX_BLOCKS) {
      messages.push({ text, blocks });
      blocks = [section(continued)];
      text = continued;
    }
    blocks.push(block);
  }
  messages.push({ text: isEmpty ? `${text}\n${EMPTY_FINDINGS_TEXT}` : text, blocks });
  return messages;
}

// ---- canvas の節（US3、contracts/commands-and-output.md#canvas の節、R8） ----

/** canvas の節の目印。見出しと本文の両方に入れ、`canvases.sections.lookup` の `contains_text` で引く。 */
export function canvasMarkerOf(threadTs: string): string {
  return `〔arb:${threadTs}〕`;
}

export type CanvasSectionOptions = {
  threadTs: string;
  /** 見出しの題名（topic の題名か、スレッドの最初の発言の先頭）。 */
  title: string;
  updatedAt: Date;
  /** 呼んだ人。分かれば `![](@U…)` のメンションにする。 */
  requesterUserId: string | null;
  /** スレッドのパーマリンク。 */
  threadUrl: string;
  /** 根拠の ts → パーマリンク。 */
  permalink: (ts: string) => string;
  /** ToDo の項目 ID → 担当者の Slack のユーザー ID（メンションにする）。 */
  assigneeUserIds?: ReadonlyMap<string, string>;
  /** 期限の年の省略に使う基準日。 */
  reference?: Date;
};

/** 会話由来の文字を 1 行にし、他の節の目印になる形を無効にする（lookup と delete の誤爆を防ぐ）。 */
function canvasLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().replaceAll("〔arb:", "〔arb：");
}

function canvasEvidence(evidence: string[], permalink: (ts: string) => string): string {
  if (evidence.length === 0) return "根拠なし";
  const shown = evidence.slice(0, MAX_EVIDENCE_LINKS);
  if (shown.length === 1) return `[根拠](${permalink(shown[0] as string)})`;
  return shown.map((ts, i) => `[${i + 1}](${permalink(ts)})`).join(" ");
}

/**
 * canvas の節の markdown。「目印付きの h2 の見出し」と「本文の 1 ブロック」の 2 ブロックになる。
 * 本文は行末の空白 2 つでつなぎ、空行を入れない。項目は `• ` か `☐ ` で始める（h3、チェックリスト、引用、`<br>` は使わない）。
 */
export function renderCanvasSection(model: SummaryModel, opts: CanvasSectionOptions): string {
  const marker = canvasMarkerOf(opts.threadTs);
  const heading = `## 調整: ${canvasLine(opts.title)} ${marker}`;
  const requester = opts.requesterUserId === null ? "" : `（![](@${opts.requesterUserId})）`;
  const updated = formatInTimeZone(opts.updatedAt, JST, "yyyy-MM-dd HH:mm");

  const tail = (item: SummaryItemBase): string =>
    `  ${canvasEvidence(item.evidence, opts.permalink)}${item.needsReview ? " ⚠️" : ""}`;

  const lines: string[] = [
    `最終更新: ${updated}${requester} · [スレッド](${opts.threadUrl}) ${marker}`,
  ];
  const group = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`**${title}**`, ...items);
  };

  const topicLine = (t: SummaryTopic): string => {
    const title = canvasLine(t.title);
    if (t.status === "decided") return `• ${title}: ${canvasLine(t.decision ?? "決定")}${tail(t)}`;
    const options = t.options.length > 0 ? `: ${t.options.map(canvasLine).join(" / ")}` : "";
    const pending =
      t.pendingParticipants.length > 0
        ? ` — 回答待ち: ${t.pendingParticipants.map((n) => `@${canvasLine(n)}`).join(", ")}`
        : "";
    return `• ${title}${options}${pending}${tail(t)}`;
  };
  const todoLine = (t: SummaryTodo): string => {
    const userId = opts.assigneeUserIds?.get(t.id);
    const assignee =
      t.assignee === null
        ? "担当未定"
        : userId !== undefined
          ? `![](@${userId})`
          : `@${canvasLine(t.assignee)}`;
    const due = dueLabel(t, opts.reference);
    return `☐ ${canvasLine(t.text)} — ${assignee}${due === null ? "" : ` / 期限 ${canvasLine(due)}`}${tail(t)}`;
  };

  group("決定事項", model.topics.filter((t) => t.status === "decided").map(topicLine));
  group("未決定事項", model.topics.filter((t) => t.status === "open").map(topicLine));
  group("ToDo", model.todos.map(todoLine));
  group(
    "未解決の問い",
    model.questions.map((q) => `• ${canvasLine(q.text)}${tail(q)}`),
  );

  const isEmpty = lines.length === 1;
  if (isEmpty) lines.push(EMPTY_SUMMARY_TEXT);
  const anyReview = [...model.topics, ...model.todos, ...model.questions].some(
    (i) => i.needsReview,
  );
  if (anyReview) lines.push(REVIEW_NOTE);

  return `${heading}\n\n${lines.join("  \n")}`;
}
