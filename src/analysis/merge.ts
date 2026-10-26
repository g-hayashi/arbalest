/**
 * 差分の適用（data-model.md の「差分の適用」「識別子」）。純粋な関数。
 *
 * - AI の出力（SummarizePatch）を 1 項目ずつ verifyItem に通し、根拠の m-id を ts に変えて
 *   needsReview / reviewReasons を付けてから、前回の状態に適用する。
 * - 新しい項目（`ref: null`）の ID はコードが採番する（接頭辞 + 連番。nextSeq と既存の ID の大きい方の続き）。
 * - 新しい topic・option は `new:<添字>` で参照される。解決できない参照と、実在しない ID を参照する操作（V5）は
 *   捨てて `dropped` に記録する（呼び出し側が `logDropped` でログに出す）。
 * - 回答と確定の発言は追加だけ。同じ参加者・同じ topic の新しい回答は、古い回答の supersededBy を設定する。
 * - `close` は todo と question だけに効く（決定は decide.ts の D 規則で決まるため）。
 * - 同じ patch を 2 回適用しても項目が増えない: `ref: null` の項目は、本文が同じで根拠が既存の項目の根拠に
 *   含まれるなら、その既存の項目の更新として扱う。
 *
 * 表示用の差分は `diffMarks`、全体の処理し直しでの ID の引き継ぎは `carryOverIds`。
 */
import type { DiffMark } from "../slack/render.js";
import type {
  AnalysisState,
  OptionItem,
  OverviewItem,
  QuestionItem,
  ResponseItem,
  ReviewFlags,
  StatementItem,
  TodoItem,
  TopicItem,
} from "../store/types.js";
import { log } from "../util/log.js";
import { decide, latestEvidenceKey, type TopicDecision } from "./decide.js";
import type { SummarizePatch } from "./schemas.js";
import {
  normalizeQuote,
  partitionKnownRefs,
  type VerifyContext,
  type VerifyResult,
  verifyItem,
} from "./verify.js";

/** 項目 ID の接頭辞（data-model.md#識別子）。 */
export const ID_PREFIX = {
  overview: "v",
  topic: "k",
  option: "o",
  response: "r",
  statement: "s",
  todo: "t",
  question: "q",
} as const;

/** 操作を捨てた理由。 */
export const DROP_REASON = {
  unknownRef: "参照する ID が実在しないか、解決できない",
  unknownParticipant: "参加者の表にない人の回答",
  noEvidence: "根拠のメッセージが見つからない close",
} as const;

/** 捨てた操作。path は patch の中の位置（`responses[2]`、`topics[0].options[1]`）。本文は入れない。 */
export type DroppedOp = { path: string; ref: string | null; reason: string };

export type ApplyPatchInput = {
  state: AnalysisState;
  /** 接頭辞 → 最後に使った番号。 */
  nextSeq: Record<string, number>;
  patch: SummarizePatch;
  /** 検証の文脈（preprocess の texts、mIdToTs、参加者の ID、今日）。 */
  ctx: VerifyContext;
};

export type ApplyPatchResult = {
  state: AnalysisState;
  nextSeq: Record<string, number>;
  dropped: DroppedOp[];
};

// ---- 採番 ----

/** 状態の中のすべての項目 ID。 */
export function allItemIds(state: AnalysisState): string[] {
  return [
    ...(state.overview ?? []).map((v) => v.id),
    ...state.topics.flatMap((t) => [t.id, ...t.options.map((o) => o.id)]),
    ...state.responses.map((r) => r.id),
    ...state.statements.map((s) => s.id),
    ...state.todos.map((t) => t.id),
    ...state.questions.map((q) => q.id),
  ];
}

/** nextSeq と既存の ID の最大の番号の、大きい方の続きを振る（既存の ID と衝突しない、単調に増える）。 */
class IdAllocator {
  private readonly seq: Record<string, number>;

  /** `skip` は振らない ID（patch が参照する、実在しない ID。後で別の項目を指さないようにする）。 */
  constructor(
    nextSeq: Record<string, number>,
    state: AnalysisState,
    private readonly skip: ReadonlySet<string> = new Set(),
  ) {
    this.seq = { ...nextSeq };
    for (const id of allItemIds(state)) {
      const m = /^([a-z])(\d+)$/.exec(id);
      if (!m) continue;
      const prefix = m[1] as string;
      this.seq[prefix] = Math.max(this.seq[prefix] ?? 0, Number(m[2]));
    }
  }

  next(prefix: string): string {
    let n = (this.seq[prefix] ?? 0) + 1;
    while (this.skip.has(`${prefix}${n}`)) n += 1;
    this.seq[prefix] = n;
    return `${prefix}${n}`;
  }

  snapshot(): Record<string, number> {
    return { ...this.seq };
  }
}

// ---- 部品 ----

const norm = (text: string): string => normalizeQuote(text);
const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
const review = (v: VerifyResult): ReviewFlags => ({
  needsReview: v.needsReview,
  reviewReasons: v.reviewReasons,
});
const NEW_REF = /^new:(\d+)$/;

/**
 * `ref: null` の項目の重複を探す。本文（正規化後）が同じで、根拠が既存の項目の根拠に含まれるもののうち、
 * 最も先に作られたもの。
 *
 * 同じ patch を 2 回適用しても結果が変わらないように、各種類で「ref の更新」を先に、「ref: null」を後に
 * 適用する。ref: null の段では、既存の項目の本文（正規化後）と根拠は変わらない（根拠は部分集合なので
 * 和を取っても同じ）。そのため 2 回目も、1 回目と同じ項目が最も先の候補になる。
 */
function findDuplicate<T extends { evidence: string[] }>(
  items: readonly T[],
  body: (item: T) => string,
  key: string,
  evidence: readonly string[],
): T | undefined {
  return items.find(
    (item) => body(item) === key && evidence.every((e) => item.evidence.includes(e)),
  );
}

/** ref のある操作を先に、ref が null の操作を後に並べる（同じ側の中では元の順）。 */
function updatesFirst<T extends { op: { ref: string | null } }>(ops: readonly T[]): T[] {
  return [...ops.filter((x) => x.op.ref !== null), ...ops.filter((x) => x.op.ref === null)];
}

const responseBody = (
  r: Pick<ResponseItem, "participant" | "topicId" | "optionId" | "answer" | "certainty" | "quote">,
) => [r.participant, r.topicId, r.optionId, r.answer, r.certainty, norm(r.quote)].join("|");
const statementBody = (
  s: Pick<StatementItem, "topicId" | "optionId" | "certainty" | "text" | "quote">,
) => [s.topicId, s.optionId, s.certainty, norm(s.text), norm(s.quote)].join("|");

/**
 * patch が参照する ID のうち、状態に実在しないもの。採番でこれらを避けると、同じ patch をもう一度適用しても
 * その参照は実在しないまま（捨てられる）になり、別の項目を指さない。
 */
function danglingRefs(patch: SummarizePatch, state: AnalysisState): Set<string> {
  const existing = new Set(allItemIds(state));
  const refs = [
    ...patch.overview.map((v) => v.ref),
    ...patch.topics.flatMap((t) => [t.ref, ...t.options.map((o) => o.ref)]),
    ...patch.responses.flatMap((r) => [r.topic_ref, r.option_ref]),
    ...patch.statements.flatMap((s) => [s.topic_ref, s.option_ref]),
    ...patch.todos.map((t) => t.ref),
    ...patch.questions.map((q) => q.ref),
    ...patch.close.map((c) => c.ref),
  ];
  return new Set(
    refs.filter((r): r is string => r !== null && !NEW_REF.test(r) && !existing.has(r)),
  );
}

// ---- 適用 ----

/** 保存済み概要の根拠（ts）を、今回取得した全投稿に対して再検証する。 */
export function verifyOverview(
  overview: readonly OverviewItem[],
  ctx: VerifyContext,
): OverviewItem[] {
  if (ctx.mIdToTs.size === 0) return [];
  const tsToMId = new Map([...ctx.mIdToTs].map(([mId, ts]) => [ts, mId]));
  return overview.slice(0, 3).map((item) => {
    const evidence = item.evidence.flatMap((ts) => {
      const mId = tsToMId.get(ts);
      return mId === undefined ? [] : [mId];
    });
    const verified = verifyItem({ evidence, quote: item.quote }, ctx);
    return { ...item, evidence: verified.evidenceTs, ...review(verified) };
  });
}

export function applyPatch(input: ApplyPatchInput): ApplyPatchResult {
  const { patch, ctx } = input;
  const state: AnalysisState = structuredClone(input.state);
  const alloc = new IdAllocator(input.nextSeq, input.state, danglingRefs(patch, input.state));
  const dropped: DroppedOp[] = [];
  const drop = (path: string, ref: string | null, reason: string) =>
    dropped.push({ path, ref, reason });

  const overview = state.overview ?? [];
  const knownOverview = partitionKnownRefs(
    patch.overview.map((op, i) => ({ op, i })),
    (x) => x.op.ref,
    new Set(overview.map((v) => v.id)),
  );
  for (const { op, i } of knownOverview.dropped)
    drop(`overview[${i}]`, op.ref, DROP_REASON.unknownRef);
  for (const { op } of updatesFirst(knownOverview.kept)) {
    const v = verifyItem({ evidence: op.evidence, quote: op.quote }, ctx);
    const item =
      op.ref !== null
        ? overview.find((x) => x.id === op.ref)
        : findDuplicate(overview, (x) => norm(x.text), norm(op.text), v.evidenceTs);
    if (item === undefined)
      overview.push({
        id: alloc.next(ID_PREFIX.overview),
        text: op.text,
        quote: op.quote,
        evidence: v.evidenceTs,
        ...review(v),
      } satisfies OverviewItem);
    else
      Object.assign(item, {
        text: op.text,
        quote: op.quote,
        evidence: union(item.evidence, v.evidenceTs),
        ...review(v),
      });
  }
  // 新しい話題を優先し、分割して抽出した場合も全体で最大3項目にする。
  state.overview = overview
    .sort((a, b) =>
      (latestEvidenceKey(b.evidence) ?? "").localeCompare(latestEvidenceKey(a.evidence) ?? ""),
    )
    .slice(0, 3);

  // ---- topics と options ----
  /** patch.topics[i] → 適用先の topic ID（捨てた項目は undefined）。 */
  const topicIdAt: (string | undefined)[] = [];
  /** patch.topics[i].options[j] → option ID。 */
  const optionIdAt: (string | undefined)[][] = [];

  const topicOps = patch.topics.map((op, i) => ({ op, i }));
  const knownTopics = partitionKnownRefs(
    topicOps,
    (x) => x.op.ref,
    new Set(input.state.topics.map((t) => t.id)),
  );
  for (const { op, i } of knownTopics.dropped) {
    drop(`topics[${i}]`, op.ref, DROP_REASON.unknownRef);
  }
  const topicOf: TopicItem[] = [];
  for (const { op, i } of updatesFirst(knownTopics.kept)) {
    const v = verifyItem({ evidence: op.evidence, participants: op.required_participants }, ctx);
    const required = [...new Set(op.required_participants)].filter(
      (p) => !v.invalidParticipants.includes(p),
    );
    let topic =
      op.ref !== null
        ? state.topics.find((t) => t.id === op.ref)
        : findDuplicate(state.topics, (t) => norm(t.title), norm(op.title), v.evidenceTs);
    if (topic === undefined) {
      topic = {
        id: alloc.next(ID_PREFIX.topic),
        title: op.title,
        evidence: v.evidenceTs,
        requiredParticipants: required,
        options: [],
        ...review(v),
      };
      state.topics.push(topic);
    } else {
      topic.title = op.title;
      topic.evidence = union(topic.evidence, v.evidenceTs);
      // 必要な参加者は減らさない（減らすと決定が早まる側に倒れるため）
      topic.requiredParticipants = union(topic.requiredParticipants, required);
      Object.assign(topic, review(v));
    }
    topicIdAt[i] = topic.id;
    topicOf[i] = topic;
  }

  // options も、すべての topic の ref の更新を先に、ref: null を後に適用する
  const optionOps = knownTopics.kept.flatMap(({ op, i }) => {
    const topic = topicOf[i] as TopicItem;
    optionIdAt[i] = [];
    const known = partitionKnownRefs(
      op.options.map((o, j) => ({ op: o, i, j, topic })),
      (x) => x.op.ref,
      new Set(topic.options.map((o) => o.id)),
    );
    for (const x of known.dropped) {
      drop(`topics[${i}].options[${x.j}]`, x.op.ref, DROP_REASON.unknownRef);
    }
    return known.kept;
  });
  for (const { op, i, j, topic } of updatesFirst(optionOps)) {
    const v = verifyItem(
      { evidence: op.evidence, dates: [{ dateIso: op.date_iso, sourceText: op.label }] },
      ctx,
    );
    const dateIso = v.dates[0] ?? null;
    let option =
      op.ref !== null
        ? topic.options.find((o) => o.id === op.ref)
        : findDuplicate(topic.options, (o) => norm(o.label), norm(op.label), v.evidenceTs);
    if (option === undefined) {
      option = {
        id: alloc.next(ID_PREFIX.option),
        label: op.label,
        dateIso,
        evidence: v.evidenceTs,
        ...review(v),
      } satisfies OptionItem;
      topic.options.push(option);
    } else {
      option.label = op.label;
      option.dateIso = dateIso;
      option.evidence = union(option.evidence, v.evidenceTs);
      Object.assign(option, review(v));
    }
    (optionIdAt[i] as (string | undefined)[])[j] = option.id;
  }

  // ---- 参照の解決 ----
  /** topic の参照（既存の k-id か `new:<patch.topics の添字>`）。解決できなければ null。 */
  const resolveTopic = (ref: string): string | null => {
    const m = NEW_REF.exec(ref);
    if (m) {
      const i = Number(m[1]);
      return patch.topics[i]?.ref === null ? (topicIdAt[i] ?? null) : null;
    }
    return state.topics.some((t) => t.id === ref) ? ref : null;
  };
  /**
   * option の参照。`new:N` は、新しい topic なら patch.topics[M].options[N]、既存の topic なら
   * patch.topics の中で ref が一致する項目の options[N]。解決できなければ undefined。
   */
  const resolveOption = (
    topicRef: string,
    topicId: string,
    ref: string | null,
  ): string | null | undefined => {
    if (ref === null) return null;
    const m = NEW_REF.exec(ref);
    if (m) {
      const tm = NEW_REF.exec(topicRef);
      const entry = tm
        ? Number(tm[1])
        : patch.topics.findIndex((op, i) => op.ref === topicId && topicIdAt[i] === topicId);
      return entry < 0 ? undefined : optionIdAt[entry]?.[Number(m[1])];
    }
    const topic = state.topics.find((t) => t.id === topicId);
    return topic?.options.some((o) => o.id === ref) ? ref : undefined;
  };
  const resolveTarget = (topicRef: string, optionRef: string | null) => {
    const topicId = resolveTopic(topicRef);
    if (topicId === null) return null;
    const optionId = resolveOption(topicRef, topicId, optionRef);
    return optionId === undefined ? null : { topicId, optionId };
  };

  // ---- responses ----
  patch.responses.forEach((op, i) => {
    const target = resolveTarget(op.topic_ref, op.option_ref);
    if (target === null) {
      drop(`responses[${i}]`, op.option_ref ?? op.topic_ref, DROP_REASON.unknownRef);
      return;
    }
    const v = verifyItem(
      { evidence: op.evidence, quote: op.quote, participants: [op.participant] },
      ctx,
    );
    if (v.invalidParticipants.length > 0) {
      drop(`responses[${i}]`, null, DROP_REASON.unknownParticipant);
      return;
    }
    const fields = {
      topicId: target.topicId,
      optionId: target.optionId,
      participant: op.participant,
      answer: op.answer,
      certainty: op.certainty,
      quote: op.quote,
    };
    if (findDuplicate(state.responses, responseBody, responseBody(fields), v.evidenceTs)) return;
    const response: ResponseItem = {
      id: alloc.next(ID_PREFIX.response),
      ...fields,
      evidence: v.evidenceTs,
      supersededBy: null,
      ...review(v),
    };
    supersede(state.responses, response);
    state.responses.push(response);
  });

  // ---- statements ----
  patch.statements.forEach((op, i) => {
    const target = resolveTarget(op.topic_ref, op.option_ref);
    if (target === null) {
      drop(`statements[${i}]`, op.option_ref ?? op.topic_ref, DROP_REASON.unknownRef);
      return;
    }
    const v = verifyItem({ evidence: op.evidence, quote: op.quote }, ctx);
    const fields = {
      topicId: target.topicId,
      optionId: target.optionId,
      text: op.text,
      certainty: op.certainty,
      quote: op.quote,
    };
    if (findDuplicate(state.statements, statementBody, statementBody(fields), v.evidenceTs)) return;
    state.statements.push({
      id: alloc.next(ID_PREFIX.statement),
      ...fields,
      evidence: v.evidenceTs,
      ...review(v),
    });
  });

  // ---- todos ----
  const knownTodos = partitionKnownRefs(
    patch.todos.map((op, i) => ({ op, i })),
    (x) => x.op.ref,
    new Set(input.state.todos.map((t) => t.id)),
  );
  for (const { op, i } of knownTodos.dropped) drop(`todos[${i}]`, op.ref, DROP_REASON.unknownRef);
  for (const { op } of updatesFirst(knownTodos.kept)) {
    const v = verifyItem(
      {
        evidence: op.evidence,
        quote: op.quote,
        participants: [op.assignee],
        dates: [{ dateIso: op.due_iso, sourceText: op.due_text }],
      },
      ctx,
    );
    const fields = {
      text: op.text,
      assignee:
        op.assignee !== null && !v.invalidParticipants.includes(op.assignee) ? op.assignee : null,
      dueIso: v.dates[0] ?? null,
      dueText: op.due_text,
      certainty: op.certainty,
      quote: op.quote,
      ...review(v),
    };
    const todo =
      op.ref !== null
        ? state.todos.find((t) => t.id === op.ref)
        : findDuplicate(state.todos, (t) => norm(t.text), norm(op.text), v.evidenceTs);
    if (todo === undefined) {
      state.todos.push({
        id: alloc.next(ID_PREFIX.todo),
        ...fields,
        evidence: v.evidenceTs,
        closed: false,
      } satisfies TodoItem);
    } else {
      Object.assign(todo, fields, { evidence: union(todo.evidence, v.evidenceTs) });
    }
  }

  // ---- questions ----
  const knownQuestions = partitionKnownRefs(
    patch.questions.map((op, i) => ({ op, i })),
    (x) => x.op.ref,
    new Set(input.state.questions.map((q) => q.id)),
  );
  for (const { op, i } of knownQuestions.dropped) {
    drop(`questions[${i}]`, op.ref, DROP_REASON.unknownRef);
  }
  for (const { op } of updatesFirst(knownQuestions.kept)) {
    const v = verifyItem({ evidence: op.evidence, quote: op.quote }, ctx);
    const fields = { text: op.text, quote: op.quote, ...review(v) };
    const question =
      op.ref !== null
        ? state.questions.find((q) => q.id === op.ref)
        : findDuplicate(state.questions, (q) => norm(q.text), norm(op.text), v.evidenceTs);
    if (question === undefined) {
      state.questions.push({
        id: alloc.next(ID_PREFIX.question),
        ...fields,
        evidence: v.evidenceTs,
        closed: false,
      } satisfies QuestionItem);
    } else {
      Object.assign(question, fields, { evidence: union(question.evidence, v.evidenceTs) });
    }
  }

  // ---- close（todo と question だけ。根拠が 1 つもない close は捨てる） ----
  const closable = new Map<string, { closed: boolean }>([
    ...state.todos.map((t) => [t.id, t] as const),
    ...state.questions.map((q) => [q.id, q] as const),
  ]);
  const knownClose = partitionKnownRefs(
    patch.close.map((op, i) => ({ op, i })),
    (x) => x.op.ref,
    new Set(closable.keys()),
  );
  const closeOrder = [...knownClose.dropped, ...knownClose.kept].sort((a, b) => a.i - b.i);
  const keptClose = new Set(knownClose.kept);
  for (const x of closeOrder) {
    if (!keptClose.has(x)) {
      drop(`close[${x.i}]`, x.op.ref, DROP_REASON.unknownRef);
      continue;
    }
    const v = verifyItem({ evidence: x.op.evidence }, ctx);
    if (v.evidence.length === 0) {
      drop(`close[${x.i}]`, x.op.ref, DROP_REASON.noEvidence);
      continue;
    }
    (closable.get(x.op.ref) as { closed: boolean }).closed = true;
  }

  return { state, nextSeq: alloc.snapshot(), dropped };
}

/**
 * 新しい回答 `response` を、同じ参加者・同じ topic の最新の回答の後に置く。
 * 最新の回答より前の発言を根拠にする回答は、最新を置き換えずに、最新に置き換えられた回答として入れる。
 * どちらの場合も、同じ参加者・同じ topic の supersededBy が null の回答は 1 つだけになる。
 */
function supersede(responses: ResponseItem[], response: ResponseItem): void {
  const latest = responses.filter(
    (r) =>
      r.participant === response.participant &&
      r.topicId === response.topicId &&
      r.supersededBy === null,
  );
  if (latest.length === 0) return;
  const key = latestEvidenceKey(response.evidence);
  const older =
    key !== null &&
    latest.every((r) => {
      const k = latestEvidenceKey(r.evidence);
      return k !== null && key < k;
    });
  if (older) {
    response.supersededBy = (latest[latest.length - 1] as ResponseItem).id;
    return;
  }
  for (const r of latest) r.supersededBy = response.id;
}

/** 捨てた操作をログに出す（本文は出さない）。 */
export function logDropped(dropped: readonly DroppedOp[], fields: Record<string, unknown> = {}) {
  for (const d of dropped) {
    log("WARNING", "差分の操作を捨てた", { ...fields, path: d.path, ref: d.ref, reason: d.reason });
  }
}

// ---- 表示用の差分 ----

function topicView(t: TopicItem, d: TopicDecision | undefined): string {
  return JSON.stringify([
    t.title,
    t.requiredParticipants,
    t.options.map((o) => [o.id, o.label, o.dateIso, o.needsReview]),
    t.needsReview,
    d?.status,
    d?.decidedOptionId,
    d?.pendingParticipants,
    d?.needsReview,
  ]);
}

const todoView = (t: TodoItem) =>
  JSON.stringify([t.text, t.assignee, t.dueIso, t.dueText, t.needsReview]);
const questionView = (q: QuestionItem) => JSON.stringify([q.text, q.needsReview]);

/** 項目 → 印。前に無ければ new（閉じていれば done）、閉じたら done、内容が変われば changed。 */
function markClosable<T extends { id: string; closed: boolean }>(
  marks: Map<string, DiffMark>,
  before: readonly T[],
  after: readonly T[],
  view: (item: T) => string,
): void {
  const prev = new Map(before.map((x) => [x.id, x]));
  for (const x of after) {
    const b = prev.get(x.id);
    if (b === undefined) marks.set(x.id, x.closed ? "done" : "new");
    else if (!b.closed && x.closed) marks.set(x.id, "done");
    else if (b.closed !== x.closed || (!x.closed && view(b) !== view(x)))
      marks.set(x.id, "changed");
  }
}

/**
 * 適用の前後を比べて、表示用の差分（項目 ID → new / changed / done）を作る。
 * topic は内容（題、必要な参加者、候補）と判定（状態、決まった option、回答待ち、要確認）の変化を見る。
 * `speakers` は decide に渡す発言者の p-id。消えた項目には印を付けない。
 */
export function diffMarks(
  before: AnalysisState,
  after: AnalysisState,
  speakers: readonly string[],
): Map<string, DiffMark> {
  const marks = new Map<string, DiffMark>();
  const db = decide(before, speakers);
  const da = decide(after, speakers);
  const prevTopics = new Map(before.topics.map((t) => [t.id, t]));
  for (const t of after.topics) {
    const b = prevTopics.get(t.id);
    if (b === undefined) marks.set(t.id, "new");
    else if (topicView(b, db.get(b.id)) !== topicView(t, da.get(t.id))) marks.set(t.id, "changed");
  }
  markClosable(marks, before.todos, after.todos, todoView);
  markClosable(marks, before.questions, after.questions, questionView);
  return marks;
}

const overviewView = (v: OverviewItem) => JSON.stringify([v.id, v.text, v.needsReview]);

/**
 * 「まとめ」（会話の概要、決定事項、未決定事項、問い）が前回から変わったか。ToDo の変化は含めない。
 * `marks` は同じ前後の `diffMarks`。概要は印を持たないので、項目の追加・text の変化・削除をここで見る。
 * 印を付けない「消えた項目」（topic、問い）も変化に数える。
 */
export function summaryChanged(
  before: AnalysisState,
  after: AnalysisState,
  marks: ReadonlyMap<string, DiffMark>,
): boolean {
  const ids = (items: readonly { id: string }[]) => items.map((x) => x.id);
  if ([...ids(after.topics), ...ids(after.questions)].some((id) => marks.has(id))) return true;
  const gone = (b: readonly { id: string }[], a: readonly { id: string }[]) =>
    b.some((x) => !a.some((y) => y.id === x.id));
  if (gone(before.topics, after.topics) || gone(before.questions, after.questions)) return true;
  const prev = new Map((before.overview ?? []).map((v) => [v.id, overviewView(v)]));
  const next = after.overview ?? [];
  return prev.size !== next.length || next.some((v) => prev.get(v.id) !== overviewView(v));
}

// ---- 全体の処理し直し ----

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));
const overlaps = (a: readonly string[], b: readonly string[]) =>
  (a.length === 0 && b.length === 0) || a.some((x) => b.includes(x));

/**
 * 本文が同じ項目の対応を作る。先に根拠が完全に一致するものを、次に根拠が重なるものを対応させる。
 * 前回の項目は 1 回だけ使う。戻り値は next の添字 → 前回の項目。
 */
function matchPairs<P extends { evidence: string[] }, N extends { evidence: string[] }>(
  prev: readonly P[],
  next: readonly N[],
  bodyPrev: (p: P) => string,
  bodyNext: (n: N) => string,
): Map<number, P> {
  const pairs = new Map<number, P>();
  const used = new Set<number>();
  for (const same of [sameSet, overlaps]) {
    next.forEach((n, i) => {
      if (pairs.has(i)) return;
      const key = bodyNext(n);
      const j = prev.findIndex(
        (p, k) => !used.has(k) && bodyPrev(p) === key && same(p.evidence, n.evidence),
      );
      if (j < 0) return;
      used.add(j);
      pairs.set(i, prev[j] as P);
    });
  }
  return pairs;
}

/**
 * 全体を処理し直した結果 `next` の項目 ID を、前回の状態 `prev` から引き継ぐ。
 * 本文と根拠が一致する（根拠は完全な一致を優先し、なければ重なり）項目は前回の ID を使い、それ以外には
 * 前回の番号（`prevSeq` と前回の ID の大きい方）の続きを振る。消えた項目の ID は使い回さない。
 * 回答・確定の発言の topicId / optionId / supersededBy も付け替える。
 */
export function carryOverIds(
  prev: AnalysisState,
  next: AnalysisState,
  prevSeq: Record<string, number> = {},
): { state: AnalysisState; nextSeq: Record<string, number> } {
  const alloc = new IdAllocator(prevSeq, prev);
  const map = new Map<string, string>();
  const to = (id: string) => map.get(id) ?? id;
  const assign = <T extends { id: string; evidence: string[] }>(
    prevItems: readonly T[],
    nextItems: readonly T[],
    prefix: string,
    bodyPrev: (x: T) => string,
    bodyNext: (x: T) => string = bodyPrev,
  ): Map<number, T> => {
    const pairs = matchPairs(prevItems, nextItems, bodyPrev, bodyNext);
    nextItems.forEach((x, i) => {
      map.set(x.id, pairs.get(i)?.id ?? alloc.next(prefix));
    });
    return pairs;
  };

  const topicPairs = assign(prev.topics, next.topics, ID_PREFIX.topic, (t) => norm(t.title));
  next.topics.forEach((t, i) => {
    assign(topicPairs.get(i)?.options ?? [], t.options, ID_PREFIX.option, (o) => norm(o.label));
  });
  // 回答と発言は、付け替えた topic / option の ID で比べる
  const mapped = <T extends { topicId: string; optionId: string | null }>(x: T): T => ({
    ...x,
    topicId: to(x.topicId),
    optionId: x.optionId === null ? null : to(x.optionId),
  });
  assign(prev.responses, next.responses, ID_PREFIX.response, responseBody, (r) =>
    responseBody(mapped(r)),
  );
  assign(prev.statements, next.statements, ID_PREFIX.statement, statementBody, (s) =>
    statementBody(mapped(s)),
  );
  assign(prev.todos, next.todos, ID_PREFIX.todo, (t) => norm(t.text));
  assign(prev.questions, next.questions, ID_PREFIX.question, (q) => norm(q.text));
  assign(prev.overview ?? [], next.overview ?? [], ID_PREFIX.overview, (v) => norm(v.text));

  const state: AnalysisState = {
    overview: (next.overview ?? []).map((v) => ({ ...v, id: to(v.id) })),
    topics: next.topics.map((t) => ({
      ...t,
      id: to(t.id),
      options: t.options.map((o) => ({ ...o, id: to(o.id) })),
    })),
    responses: next.responses.map((r) => ({
      ...mapped(r),
      id: to(r.id),
      supersededBy: r.supersededBy === null ? null : to(r.supersededBy),
    })),
    statements: next.statements.map((s) => ({ ...mapped(s), id: to(s.id) })),
    todos: next.todos.map((t) => ({ ...t, id: to(t.id) })),
    questions: next.questions.map((q) => ({ ...q, id: to(q.id) })),
  };
  return { state: structuredClone(state), nextSeq: alloc.snapshot() };
}
