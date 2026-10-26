/**
 * 判定（data-model.md の「判定規則」D1〜D6）。純粋な関数。
 * AI には決定の判断をさせず、抽出した事実（回答と確定の発言）からコードで決める。
 *
 * 安全側に倒す方針（SC-005: 未回答の人がいるのに「決定」と表示しない）:
 * - 必要な参加者が 0 人なら、D3 では決して decided にしない。
 * - 確定の発言が取り消された（または別の option に変えられた）後は、その発言より後の回答だけを D3 に数える。
 *   根拠の時刻が分からない回答は「後」とみなさない。
 * - 同じ人の最新の回答（supersededBy が null）が複数ある壊れた状態では、すべてが同じ option への有効な yes の
 *   ときだけ、その人を合意に数える。
 */
import type { DiffMark, SummaryModel } from "../slack/render.js";
import type {
  AnalysisState,
  Participant,
  ResponseItem,
  StatementItem,
  TopicItem,
} from "../store/types.js";

export type TopicDecision = {
  topicId: string;
  status: "decided" | "open";
  /** decided のときの option。open では null。 */
  decidedOptionId: string | null;
  /** D5。open のとき、必要な参加者のうち有効な回答がない人（p-id）。decided では空。 */
  pendingParticipants: string[];
  /** D6。topic 自身か、決定の根拠（発言・回答・option）が needsReview なら true。 */
  needsReview: boolean;
  /** 決定の根拠になった項目の ID。 */
  basis: string[];
  /** どの規則で決まったか。open では null。 */
  rule: "D2" | "D3" | null;
};

/** ts の比較用のキー（整数部と小数部を桁を揃えて文字列にする）。 */
export function tsKey(ts: string): string {
  const [sec = "", frac = ""] = ts.split(".");
  return `${sec.padStart(12, "0")}.${frac.padEnd(6, "0")}`;
}

/** 根拠のうち最も新しい ts のキー。根拠がなければ null。 */
export function latestEvidenceKey(evidence: readonly string[]): string | null {
  let latest: string | null = null;
  for (const ts of evidence) {
    const k = tsKey(ts);
    if (latest === null || k > latest) latest = k;
  }
  return latest;
}

/**
 * 発言を時刻の順に並べる。根拠の時刻がない発言は、配列の中の直前の発言と同じ時刻とみなす（安定な並べ替え）。
 */
function orderStatements(statements: StatementItem[]): { s: StatementItem; key: string }[] {
  let previous = "";
  const keyed = statements.map((s) => {
    const key = latestEvidenceKey(s.evidence) ?? previous;
    previous = key;
    return { s, key };
  });
  return keyed
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map(({ s, key }) => ({ s, key }));
}

type D2Result =
  | { kind: "decided"; statement: StatementItem }
  /** D2 で決まらない。resetKey があれば、D3 ではその時刻より後の回答だけを数える。 */
  | { kind: "none"; resetKey: string | null };

/** D2 明示的な確定。 */
function explicitDecision(topic: TopicItem, statements: StatementItem[]): D2Result {
  const optionIds = new Set(topic.options.map((o) => o.id));
  const ordered = orderStatements(statements);
  let lastExplicit = -1;
  ordered.forEach(({ s }, i) => {
    if (s.certainty === "explicit" && s.optionId !== null && optionIds.has(s.optionId)) {
      lastExplicit = i;
    }
  });
  if (lastExplicit < 0) {
    // 確定がない。取り消しの発言（optionId が null）があれば、それより前の回答は数えない。
    let resetKey: string | null = null;
    for (const { s, key } of ordered) if (s.optionId === null) resetKey = key;
    return { kind: "none", resetKey };
  }
  const decided = ordered[lastExplicit] as { s: StatementItem; key: string };
  // 確定の後の、取り消しや変更の発言（optionId が別の値か null）。最新の発言に従う。
  const overrides = ordered
    .slice(lastExplicit + 1)
    .filter(({ s }) => s.optionId !== decided.s.optionId);
  const last = overrides[overrides.length - 1];
  if (last === undefined) return { kind: "decided", statement: decided.s };
  // 最新の発言は explicit の確定ではない（explicit なら lastExplicit がそれを指す）ので、D2 では決めない。
  return { kind: "none", resetKey: last.key };
}

/** 必要な参加者（D1）。重複を除く。 */
export function requiredParticipantsOf(topic: TopicItem, speakers: readonly string[]): string[] {
  const list = topic.requiredParticipants.length > 0 ? topic.requiredParticipants : speakers;
  return [...new Set(list)];
}

/** 1 つの topic を判定する。`speakers` はスレッドで発言した人の p-id（ボットを除く）。 */
export function decideTopic(
  state: AnalysisState,
  topic: TopicItem,
  speakers: readonly string[],
): TopicDecision {
  const optionIds = new Set(topic.options.map((o) => o.id));
  const optionOf = (id: string | null) => topic.options.find((o) => o.id === id);
  const statements = state.statements.filter((s) => s.topicId === topic.id);
  const responses = state.responses.filter((r) => r.topicId === topic.id);
  const required = requiredParticipantsOf(topic, speakers);

  const d2 = explicitDecision(topic, statements);
  if (d2.kind === "decided") {
    const option = optionOf(d2.statement.optionId);
    return {
      topicId: topic.id,
      status: "decided",
      decidedOptionId: d2.statement.optionId,
      pendingParticipants: [],
      needsReview: topic.needsReview || d2.statement.needsReview || option?.needsReview === true,
      basis: [d2.statement.id],
      rule: "D2",
    };
  }

  const resetKey = d2.resetKey;
  const afterReset = (r: ResponseItem): boolean => {
    if (resetKey === null) return true;
    const key = latestEvidenceKey(r.evidence);
    return key !== null && key > resetKey;
  };
  const latestOf = (p: string) =>
    responses.filter((r) => r.participant === p && r.supersededBy === null);

  // D3 全員の合意（D4: uncertain の yes は数えない）
  const isValidYes = (r: ResponseItem): boolean =>
    r.answer === "yes" &&
    r.certainty !== "uncertain" &&
    r.optionId !== null &&
    optionIds.has(r.optionId) &&
    afterReset(r);
  let consensus: string | null = null;
  const basis: ResponseItem[] = [];
  let agreed = required.length > 0;
  for (const p of required) {
    const latest = latestOf(p);
    const yesOptions = new Set(latest.map((r) => r.optionId));
    if (latest.length === 0 || !latest.every(isValidYes) || yesOptions.size !== 1) {
      agreed = false;
      break;
    }
    const optionId = latest[0]?.optionId ?? null;
    if (consensus === null) consensus = optionId;
    if (optionId !== consensus) {
      agreed = false;
      break;
    }
    basis.push(...latest);
  }
  if (agreed && consensus !== null) {
    const option = optionOf(consensus);
    return {
      topicId: topic.id,
      status: "decided",
      decidedOptionId: consensus,
      pendingParticipants: [],
      needsReview:
        topic.needsReview || option?.needsReview === true || basis.some((r) => r.needsReview),
      basis: basis.map((r) => r.id),
      rule: "D3",
    };
  }

  // D5 回答が残っている人: 有効な回答（uncertain でも maybe でもない、取り消しより後の回答）がない人
  const isValidAnswer = (r: ResponseItem): boolean =>
    r.certainty !== "uncertain" &&
    r.answer !== "maybe" &&
    (r.optionId === null || optionIds.has(r.optionId)) &&
    afterReset(r);
  const pendingParticipants = required.filter((p) => {
    const latest = latestOf(p);
    return latest.length === 0 || !latest.every(isValidAnswer);
  });
  return {
    topicId: topic.id,
    status: "open",
    decidedOptionId: null,
    pendingParticipants,
    needsReview: topic.needsReview,
    basis: [],
    rule: null,
  };
}

/** すべての topic を判定する。topic ID → 判定。 */
export function decide(
  state: AnalysisState,
  speakers: readonly string[],
): Map<string, TopicDecision> {
  return new Map(state.topics.map((t) => [t.id, decideTopic(state, t, speakers)]));
}

/**
 * 判定の結果を表示用のモデル（render.ts の SummaryModel）に変える。
 * - 参加者は表示名にする（表に無ければ p-id のまま）。
 * - 完了した ToDo・問いは、`marks` が `done` のときだけ含める（完了の印を 1 回だけ出す）。
 * - `speakers` を渡さなければ、参加者の表の全員を発言者とみなす（必要な参加者が増える側＝安全側）。
 */
export function toSummaryModel(
  state: AnalysisState,
  participants: readonly Participant[],
  marks?: ReadonlyMap<string, DiffMark>,
  speakers: readonly string[] = participants.map((p) => p.id),
): SummaryModel {
  const names = new Map(participants.map((p) => [p.id, p.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const decisions = decide(state, speakers);
  const visible = (item: { id: string; closed: boolean }) =>
    !item.closed || marks?.get(item.id) === "done";

  return {
    overview: (state.overview ?? []).map((v) => ({
      id: v.id,
      text: v.text,
      evidence: v.evidence,
      needsReview: v.needsReview,
    })),
    topics: state.topics.map((t) => {
      const d = decisions.get(t.id) as TopicDecision;
      const decided = d.status === "decided";
      return {
        id: t.id,
        evidence: t.evidence,
        needsReview: d.needsReview,
        title: t.title,
        status: d.status,
        decision: decided
          ? (t.options.find((o) => o.id === d.decidedOptionId)?.label ?? null)
          : null,
        options: decided ? [] : t.options.map((o) => o.label),
        pendingParticipants: d.pendingParticipants.map(nameOf),
      };
    }),
    todos: state.todos.filter(visible).map((t) => ({
      id: t.id,
      evidence: t.evidence,
      needsReview: t.needsReview,
      text: t.text,
      assignee: t.assignee === null ? null : nameOf(t.assignee),
      dueIso: t.dueIso,
      dueText: t.dueText,
    })),
    questions: state.questions.filter(visible).map((q) => ({
      id: q.id,
      evidence: q.evidence,
      needsReview: q.needsReview,
      text: q.text,
    })),
  };
}
