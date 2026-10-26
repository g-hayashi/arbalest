/**
 * 評価の一致の判定と指標（contracts/eval.md#一致の判定、#指標）。AI に採点させず、コードで決める。
 * - 項目が一致するのは、根拠の ts が 1 つ以上重なり、かつ種類ごとの欄が合う場合。
 * - 1 つの正解には、出力の 1 項目だけを対応させる。
 * 出力の取り出し（toActualOutput）は、ジョブと同じ decide.ts の判定を通す。
 */
import { decide } from "../src/analysis/decide.js";
import type { FindingTheme } from "../src/analysis/findings.js";
import { normalizeQuote } from "../src/analysis/verify.js";
import type { AnalysisState, Participant } from "../src/store/types.js";

// ---- 正解（eval/cases/*.json の expected の summarize の部分） ----

export type ExpectedDecided = {
  /** 参考。一致の判定には使わない（mustNotDecide の判定には使わない）。 */
  topic?: string;
  optionLabelIncludes: string;
  evidenceTs: string[];
};
export type ExpectedOpen = { topic: string; pending?: string[] };
export type ExpectedTodo = {
  textIncludes: string;
  /** undefined なら問わない。null は「担当者なし」が正解。 */
  assignee?: string | null;
  /** `YYYY-MM-DD`。undefined なら問わない。null は「期限なし」が正解。 */
  due?: string | null;
  evidenceTs: string[];
};
export type Expected = {
  decided?: ExpectedDecided[];
  open?: ExpectedOpen[];
  todos?: ExpectedTodo[];
  mustNotDecide?: string[];
};

// ---- 出力（ジョブの結果から取り出したもの） ----

export type ActualDecided = { title: string; optionLabel: string; evidenceTs: string[] };
/** pending は Slack のユーザー ID。 */
export type ActualOpen = { title: string; pending: string[] };
export type ActualTodo = {
  text: string;
  assignee: string | null;
  due: string | null;
  evidenceTs: string[];
};
export type ActualItem = { evidenceTs: string[]; needsReview: boolean };
export type ActualOutput = {
  decided: ActualDecided[];
  open: ActualOpen[];
  todos: ActualTodo[];
  /** 表示される項目（topic、閉じていない ToDo と問い）。根拠の有無と要確認の数に使う。 */
  items: ActualItem[];
};

const union = (...lists: string[][]): string[] => [...new Set(lists.flat())];

/** 状態を、評価の出力（決定・未決定・ToDo・項目）にする。 */
export function toActualOutput(
  state: AnalysisState,
  participants: readonly Participant[],
  speakers: readonly string[],
): ActualOutput {
  const userOf = new Map(participants.map((p) => [p.id, p.userId]));
  const user = (pid: string) => userOf.get(pid) ?? pid;
  const decisions = decide(state, speakers);
  const evidenceOf = (id: string): string[] =>
    [...state.responses, ...state.statements].find((x) => x.id === id)?.evidence ?? [];

  const out: ActualOutput = { decided: [], open: [], todos: [], items: [] };
  for (const t of state.topics) {
    const d = decisions.get(t.id);
    if (d === undefined) continue;
    const option =
      d.status === "decided" ? t.options.find((o) => o.id === d.decidedOptionId) : undefined;
    const evidenceTs = union(t.evidence, option?.evidence ?? [], ...d.basis.map(evidenceOf));
    if (d.status === "decided") {
      out.decided.push({ title: t.title, optionLabel: option?.label ?? "", evidenceTs });
    } else {
      out.open.push({ title: t.title, pending: d.pendingParticipants.map(user) });
    }
    out.items.push({ evidenceTs, needsReview: d.needsReview });
  }
  for (const t of state.todos) {
    if (t.closed) continue;
    out.todos.push({
      text: t.text,
      assignee: t.assignee === null ? null : user(t.assignee),
      due: t.dueIso,
      evidenceTs: t.evidence,
    });
    out.items.push({ evidenceTs: t.evidence, needsReview: t.needsReview });
  }
  for (const q of state.questions) {
    if (q.closed) continue;
    out.items.push({ evidenceTs: q.evidence, needsReview: q.needsReview });
  }
  return out;
}

// ---- 一致 ----

/** 全角半角（NFKC）、空白、大文字小文字の違いを除く。 */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

const includesNorm = (haystack: string, needle: string) =>
  normalizeForMatch(haystack).includes(normalizeForMatch(needle));

export function evidenceOverlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.includes(x));
}

/**
 * 正解と出力を 1 対 1 に対応させる。`score` が null の組は対応させない。
 * 正解の順に、まだ使われていない出力の中で最も score の高いものを選ぶ。
 */
function pair<E, A>(
  expected: readonly E[],
  actual: readonly A[],
  score: (e: E, a: A) => number | null,
): Map<number, { actualIndex: number; score: number }> {
  const used = new Set<number>();
  const pairs = new Map<number, { actualIndex: number; score: number }>();
  expected.forEach((e, i) => {
    let best: { actualIndex: number; score: number } | undefined;
    actual.forEach((a, j) => {
      if (used.has(j)) return;
      const s = score(e, a);
      if (s !== null && (best === undefined || s > best.score)) best = { actualIndex: j, score: s };
    });
    if (best !== undefined) {
      used.add(best.actualIndex);
      pairs.set(i, best);
    }
  });
  return pairs;
}

export type Count = { expected: number; actual: number; matched: number };
export type Accuracy = { asked: number; correct: number };

export type CaseScore = {
  overview?: OverviewScore;
  request?: Accuracy & { unauthorizedEffects: number };
  decided: Count;
  todos: Count;
  assignee: Accuracy;
  due: Accuracy;
  /** 回答待ちの人の一致（参考値。閾値なし）。 */
  pending: Accuracy;
  /** 決定にしてはいけない topic が決定になっているもの（title）。 */
  violations: string[];
  /** 根拠のある項目の数（SC-004）。 */
  evidence: { items: number; withEvidence: number };
  /** 検証に通った（要確認でない）項目の数。 */
  verify: { items: number; passed: number };
};

const todoKeyMatch = (e: ExpectedTodo, a: ActualTodo) =>
  evidenceOverlaps(e.evidenceTs, a.evidenceTs) && includesNorm(a.text, e.textIncludes);
const assigneeOk = (e: ExpectedTodo, a: ActualTodo) =>
  e.assignee === undefined || e.assignee === a.assignee;
const dueOk = (e: ExpectedTodo, a: ActualTodo) => e.due === undefined || e.due === a.due;

export function scoreCase(expected: Expected, output: ActualOutput): CaseScore {
  const exDecided = expected.decided ?? [];
  const exTodos = expected.todos ?? [];
  const exOpen = expected.open ?? [];

  const decidedPairs = pair(exDecided, output.decided, (e, a) =>
    evidenceOverlaps(e.evidenceTs, a.evidenceTs) &&
    includesNorm(a.optionLabel, e.optionLabelIncludes)
      ? 1
      : null,
  );

  // 担当者・期限の正解率は、根拠と text で対応させた組で見る（全項目が合う組を優先する）。
  const todoPairs = pair(exTodos, output.todos, (e, a) => {
    if (!todoKeyMatch(e, a)) return null;
    return assigneeOk(e, a) && dueOk(e, a) ? 2 : 1;
  });
  let todoMatched = 0;
  const assignee: Accuracy = { asked: 0, correct: 0 };
  const due: Accuracy = { asked: 0, correct: 0 };
  exTodos.forEach((e, i) => {
    const p = todoPairs.get(i);
    const a = p === undefined ? undefined : output.todos[p.actualIndex];
    if (a !== undefined && p?.score === 2) todoMatched += 1;
    if (e.assignee !== undefined) {
      assignee.asked += 1;
      if (a !== undefined && assigneeOk(e, a)) assignee.correct += 1;
    }
    if (e.due !== undefined) {
      due.asked += 1;
      if (a !== undefined && dueOk(e, a)) due.correct += 1;
    }
  });

  const pending: Accuracy = { asked: 0, correct: 0 };
  for (const e of exOpen) {
    if (e.pending === undefined) continue;
    pending.asked += 1;
    const a = output.open.find((o) => includesNorm(o.title, e.topic));
    const same =
      a !== undefined &&
      a.pending.length === e.pending.length &&
      e.pending.every((u) => a.pending.includes(u));
    if (same) pending.correct += 1;
  }

  const forbidden = [...(expected.mustNotDecide ?? []), ...exOpen.map((o) => o.topic)];
  const violations = output.decided
    .filter((d) => forbidden.some((f) => includesNorm(d.title, f)))
    .map((d) => d.title);

  return {
    decided: {
      expected: exDecided.length,
      actual: output.decided.length,
      matched: decidedPairs.size,
    },
    todos: { expected: exTodos.length, actual: output.todos.length, matched: todoMatched },
    assignee,
    due,
    pending,
    violations,
    evidence: {
      items: output.items.length,
      withEvidence: output.items.filter((i) => i.evidenceTs.length > 0).length,
    },
    verify: {
      items: output.items.length,
      passed: output.items.filter((i) => !i.needsReview).length,
    },
  };
}

// ---- 指標と閾値 ----

export type Metrics = {
  /** 002 SC-006/007。対象ケースが無い場合は判定しない。 */
  overviewEvidenceAccuracy?: number;
  overviewRecall?: number;
  requestAccuracy?: number;
  unauthorizedEffects?: number;
  decidedPrecision: number;
  decidedRecall: number;
  todoPrecision: number;
  todoRecall: number;
  assigneeAccuracy: number;
  dueAccuracy: number;
  mustNotDecideViolations: number;
  /** 表示される項目のうち、根拠のあるものの割合（SC-004）。 */
  evidenceCoverage: number;
  /** 検証に通った（要確認でない）項目の割合。参考値。 */
  verifyPassRate: number;
  /** 回答待ちの人の一致率。参考値。 */
  pendingAccuracy: number;
};

/** 分母が 0 なら 1（出力も正解も無いのは、正しい）。 */
const ratio = (num: number, den: number) => (den === 0 ? 1 : num / den);
const sum = <T>(items: readonly T[], f: (item: T) => number) =>
  items.reduce((total, item) => total + f(item), 0);

/** 全ケースを合算する。naturalScoresは、安全フィルタのケースも期待要点・依頼の分母に残すために使う。 */
export function aggregate(
  scores: readonly CaseScore[],
  naturalScores: readonly CaseScore[] = scores,
): Metrics {
  const overviews = naturalScores.flatMap((s) => (s.overview === undefined ? [] : [s.overview]));
  const requests = naturalScores.flatMap((s) => (s.request === undefined ? [] : [s.request]));
  return {
    ...(overviews.length === 0
      ? {}
      : {
          overviewEvidenceAccuracy: ratio(
            sum(overviews, (s) => s.evidence.passed),
            sum(overviews, (s) => s.evidence.items),
          ),
          overviewRecall: ratio(
            sum(overviews, (s) => s.points.matched),
            sum(overviews, (s) => s.points.expected),
          ),
        }),
    ...(requests.length === 0
      ? {}
      : {
          requestAccuracy: ratio(
            sum(requests, (s) => s.correct),
            sum(requests, (s) => s.asked),
          ),
          unauthorizedEffects: sum(requests, (s) => s.unauthorizedEffects),
        }),
    decidedPrecision: ratio(
      sum(scores, (s) => s.decided.matched),
      sum(scores, (s) => s.decided.actual),
    ),
    decidedRecall: ratio(
      sum(scores, (s) => s.decided.matched),
      sum(scores, (s) => s.decided.expected),
    ),
    todoPrecision: ratio(
      sum(scores, (s) => s.todos.matched),
      sum(scores, (s) => s.todos.actual),
    ),
    todoRecall: ratio(
      sum(scores, (s) => s.todos.matched),
      sum(scores, (s) => s.todos.expected),
    ),
    assigneeAccuracy: ratio(
      sum(scores, (s) => s.assignee.correct),
      sum(scores, (s) => s.assignee.asked),
    ),
    dueAccuracy: ratio(
      sum(scores, (s) => s.due.correct),
      sum(scores, (s) => s.due.asked),
    ),
    mustNotDecideViolations: sum(scores, (s) => s.violations.length),
    evidenceCoverage: ratio(
      sum(scores, (s) => s.evidence.withEvidence),
      sum(scores, (s) => s.evidence.items),
    ),
    verifyPassRate: ratio(
      sum(scores, (s) => s.verify.passed),
      sum(scores, (s) => s.verify.items),
    ),
    pendingAccuracy: ratio(
      sum(scores, (s) => s.pending.correct),
      sum(scores, (s) => s.pending.asked),
    ),
  };
}

/** 既存SC-002〜SC-005と002 SC-006/007。mustNotDecideViolationsとunauthorizedEffectsは上限0。 */
export const THRESHOLDS = {
  decidedPrecision: 0.9,
  decidedRecall: 0.8,
  todoPrecision: 0.85,
  todoRecall: 0.8,
  assigneeAccuracy: 0.8,
  dueAccuracy: 0.8,
  mustNotDecideViolations: 0,
  evidenceCoverage: 1,
  overviewEvidenceAccuracy: 1,
  overviewRecall: 0.8,
  requestAccuracy: 19 / 20,
  unauthorizedEffects: 0,
} as const;

export type ThresholdCheck = {
  /** THRESHOLDS の指標と、SC-006 の followUpRatioVariable（上限。report.ts の checkSc006 が足す）。 */
  name: keyof typeof THRESHOLDS | "followUpRatioVariable";
  value: number;
  threshold: number;
  ok: boolean;
};

export function checkThresholds(metrics: Metrics): ThresholdCheck[] {
  return (Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]).flatMap((name) => {
    const threshold = THRESHOLDS[name];
    const value = metrics[name];
    if (value === undefined) return [];
    // 浮動小数点の誤差で「ちょうど」が落ちないよう、わずかな許容を持たせる。
    const ok =
      name === "mustNotDecideViolations" || name === "unauthorizedEffects"
        ? value <= threshold
        : value >= threshold - 1e-9;
    return [{ name, value, threshold, ok }];
  });
}

export type ActualOverview = {
  text: string;
  quote: string;
  evidenceTs: string[];
  needsReview: boolean;
};
export type OverviewScore = { points: Count; evidence: { items: number; passed: number } };

/** 要確認フラグだけに依存せず、全根拠の実在と引用一致を元投稿から再照合する。 */
export function scoreOverview(
  expected: readonly { evidenceTs: string[]; textIncludesAny: string[] }[],
  actual: readonly ActualOverview[],
  sources: ReadonlyMap<string, string>,
): OverviewScore {
  const valid = (a: ActualOverview) => {
    const quote = normalizeQuote(a.quote);
    return (
      !a.needsReview &&
      a.evidenceTs.length > 0 &&
      quote !== "" &&
      a.evidenceTs.every((ts) => sources.has(ts)) &&
      a.evidenceTs.some((ts) => normalizeQuote(sources.get(ts) ?? "").includes(quote))
    );
  };
  const pairs = pair(expected, actual, (e, a) =>
    valid(a) &&
    evidenceOverlaps(e.evidenceTs, a.evidenceTs) &&
    e.textIncludesAny.some((text) => includesNorm(a.text, text))
      ? 1
      : null,
  );
  return {
    points: { expected: expected.length, actual: actual.length, matched: pairs.size },
    evidence: { items: actual.length, passed: actual.filter(valid).length },
  };
}

// ---- findings（contracts/eval.md、expected.themes） ----

/** 正解のテーマ。`evidenceTs` は、そのテーマに含まれるべき根拠の ts。`theme` は参考で、一致の判定には使わない。 */
export type ExpectedTheme = { theme?: string; evidenceTs: string[] };

/** 出力のテーマ。`evidenceTs` は Finding の根拠の和集合。 */
export type ActualTheme = {
  theme: string;
  evidenceTs: string[];
  findings: { evidenceTs: string[]; needsReview: boolean }[];
};

export type FindingsScore = {
  /** テーマの一致。正解と出力を、根拠の重なりで 1 対 1 に対応させる。 */
  themes: Count;
  /** 根拠のある Finding の数（SC-004）。 */
  evidence: { items: number; withEvidence: number };
  /** 検証に通った（要確認でない）Finding の数。 */
  verify: { items: number; passed: number };
};

/** ジョブの結果（`FindingTheme[]`）を、評価の出力にする。 */
export function toActualThemes(themes: readonly FindingTheme[]): ActualTheme[] {
  return themes.map((t) => ({
    theme: t.theme,
    evidenceTs: union(...t.findings.map((f) => f.evidence)),
    findings: t.findings.map((f) => ({ evidenceTs: f.evidence, needsReview: f.needsReview })),
  }));
}

/**
 * findings の採点。テーマは、根拠の ts が 1 つ以上重なれば一致し、1 つの正解には 1 つのテーマだけを
 * 対応させる（全部をまとめた 1 テーマは 1 件にしか一致せず、1 つの正解を分けたテーマは余りが適合率を下げる）。
 */
export function scoreFindings(
  expected: readonly ExpectedTheme[],
  actual: readonly ActualTheme[],
): FindingsScore {
  const pairs = pair(expected, actual, (e, a) =>
    evidenceOverlaps(e.evidenceTs, a.evidenceTs)
      ? e.evidenceTs.filter((ts) => a.evidenceTs.includes(ts)).length
      : null,
  );
  const findings = actual.flatMap((t) => t.findings);
  return {
    themes: { expected: expected.length, actual: actual.length, matched: pairs.size },
    evidence: {
      items: findings.length,
      withEvidence: findings.filter((f) => f.evidenceTs.length > 0).length,
    },
    verify: { items: findings.length, passed: findings.filter((f) => !f.needsReview).length },
  };
}

/** findings のケースの `CaseScore`。決定・ToDo は持たず、根拠と検証の数だけを SC-004 の指標に足す。 */
export function findingsCaseScore(score: FindingsScore): CaseScore {
  const none: Count = { expected: 0, actual: 0, matched: 0 };
  const noAccuracy: Accuracy = { asked: 0, correct: 0 };
  return {
    decided: { ...none },
    todos: { ...none },
    assignee: { ...noAccuracy },
    due: { ...noAccuracy },
    pending: { ...noAccuracy },
    violations: [],
    evidence: score.evidence,
    verify: score.verify,
  };
}

/** findings の参考の指標（閾値なし）。分母が 0 なら 1。 */
export type FindingsMetrics = { themePrecision: number; themeRecall: number };

export function aggregateFindings(scores: readonly FindingsScore[]): FindingsMetrics {
  return {
    themePrecision: ratio(
      sum(scores, (s) => s.themes.matched),
      sum(scores, (s) => s.themes.actual),
    ),
    themeRecall: ratio(
      sum(scores, (s) => s.themes.matched),
      sum(scores, (s) => s.themes.expected),
    ),
  };
}
