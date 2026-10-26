/**
 * 評価の結果の型と、表の整形・保存・前回との比較（contracts/eval.md#出力）。
 * 保存先は `.tmp/eval/<日時>.json`（コミットしない）。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RequestIntent } from "../src/commands/intent.js";
import type { LlmTask } from "../src/llm/provider.js";
import type {
  ActualOutput,
  CaseScore,
  FindingsMetrics,
  FindingsScore,
  Metrics,
  ThresholdCheck,
} from "./match.js";

export type TokenUsage = { input: number; cachedInput: number; output: number };
/** 同じ通貨による100万トークンあたりの単価。input はキャッシュされない入力の単価。 */
export type EvalPricing = {
  currency: string;
  extract: TokenUsage;
  synthesize: TokenUsage;
};
export type LlmCallUsage = TokenUsage & {
  task: LlmTask;
  model: string;
  phase: "first" | "followUp";
};
export type CaseCost = {
  first: number;
  followUp: number | null;
  total: number;
  /** 失敗した呼び出しの利用量が不明なら false（total は取得できた分だけ）。 */
  complete: boolean;
};

/** 取得した呼び出しごとの利用量から、抽出・統合の単価を使って推定する。 */
export function estimateCaseCost(result: CaseResult, pricing: EvalPricing): CaseCost {
  const costOf = (phase: LlmCallUsage["phase"]) =>
    (result.llmCalls ?? []).reduce((total, call) => {
      if (call.phase !== phase) return total;
      const rates = call.task === "synthesize" ? pricing.synthesize : pricing.extract;
      return (
        total +
        ((call.input - call.cachedInput) * rates.input +
          call.cachedInput * rates.cachedInput +
          call.output * rates.output) /
          1_000_000
      );
    }, 0);
  const first = costOf("first");
  const followUp = result.followUpShare == null ? null : costOf("followUp");
  return {
    first,
    followUp,
    total: first + (followUp ?? 0),
    complete: result.usageComplete === true,
  };
}

export type CaseResult = {
  request?: {
    actual: RequestIntent | null;
    effects: { todoAssignees: (string | null)[]; canvasWrites: number; wrongDestinations: number };
  };
  id: string;
  tags: string[];
  /** AI の呼び出しが失敗したときのメッセージ。成功なら null。filtered のときも入る。 */
  error: string | null;
  /**
   * AI の安全フィルタ（content_filter）に止められたケース。安全側の結果なので、指標（適合率・再現率・
   * 担当者・期限・pending・違反・根拠）と SC-006 の比から除外し、表に filtered と出す。
   */
  filtered?: boolean;
  /** followUp のメッセージ数 /（初回 + followUp）。followUp がなければ null。SC-006 の対象は 0.2 以下。 */
  followUpShare?: number | null;
  /** 出力（原因の切り分け用）。合成の会話から得たものだけで、実データは入らない。 */
  actual?: Pick<ActualOutput, "decided" | "open" | "todos">;
  /** kind が findings のケースだけ。テーマの採点と、出力のテーマ（原因の切り分け用）。 */
  findings?: { score: FindingsScore; themes: { theme: string; evidenceTs: string[] }[] };
  score: CaseScore;
  usage: { first: TokenUsage; followUp: TokenUsage | null };
  /** 用途・実際のモデルごとの利用量。失敗した呼び出しの利用量は提供元から取得できない。 */
  llmCalls?: LlmCallUsage[];
  usageComplete?: boolean;
  cost?: CaseCost;
  /**
   * 毎回同じ入力（システムプロンプトとスキーマ）のトークンの見積もり。呼び出しの回数ぶんの合計。
   * SC-006 の比は、usage の入力からこれを引いて求める。古い保存結果にはない。
   */
  fixedInput?: { first: number; followUp: number };
};

export type EvalReport = {
  /** ISO（UTC）。 */
  startedAt: string;
  cases: CaseResult[];
  skipped: { id: string; reason: string }[];
  metrics: Metrics;
  checks: ThresholdCheck[];
  /**
   * findings のテーマの適合率・再現率（参考値。閾値なし）。filtered は除く。findings のケースがなければ付けない。
   * 根拠のある Finding の割合は、SC-004 の evidenceCoverage に含める。
   */
  findingsMetrics?: FindingsMetrics;
  /** 全ケースの合計。 */
  tokens: TokenUsage;
  /** 設定した単価による推定AI費用。単価未設定の場合は付けない。 */
  cost?: { currency: string; total: number; complete: boolean; pricing: EvalPricing };
  /**
   * 差分の更新の入力 / 初回の入力（固定の部分を含む。参考値）。
   * 対象は followUpShare が SC006_MAX_NEW_SHARE 以下のケース（filtered は除く）の合計。対象がなければ null。
   */
  followUpRatio: number | null;
  /** followUpRatio と followUpRatioVariable の対象にしたケースの id。 */
  followUpRatioCaseIds: string[];
  /**
   * 固定のシステムプロンプトとスキーマのトークンを、初回と差分の入力からそれぞれ引いた比。
   * SC-006（新しいメッセージが全体の 2 割以下のスレッドで 0.5 以下）の判定の指標。対象がなければ null（判定しない）。
   */
  followUpRatioVariable: number | null;
};

/** SC-006 の対象にする、新しいメッセージの割合の上限（全体の 2 割）。 */
export const SC006_MAX_NEW_SHARE = 0.2;

/** SC-006 の上限（固定を除いた入力の、差分 / 初回）。 */
export const SC006_MAX_RATIO = 0.5;

/** SC-006 の判定。比が null（対象のケースがない）なら判定せず、空を返す。 */
export function checkSc006(ratio: number | null): ThresholdCheck[] {
  if (ratio === null) return [];
  return [
    {
      name: "followUpRatioVariable",
      value: ratio,
      threshold: SC006_MAX_RATIO,
      // 浮動小数点の誤差で「ちょうど」が落ちないよう、わずかな許容を持たせる。
      ok: ratio <= SC006_MAX_RATIO + 1e-9,
    },
  ];
}

const fmt = (n: number) => n.toFixed(2);

function metricLine(c: ThresholdCheck): string {
  const op =
    c.name === "mustNotDecideViolations" ||
    c.name === "unauthorizedEffects" ||
    c.name === "followUpRatioVariable"
      ? "<="
      : ">=";
  const value =
    c.name === "mustNotDecideViolations" || c.name === "unauthorizedEffects"
      ? String(c.value)
      : fmt(c.value);
  return `${c.ok ? "✔" : "✘"} ${c.name.padEnd(24)} ${value.padStart(6)}  (${op} ${c.threshold})`;
}

/** 標準出力に出す表。`previous` があれば、指標の差を添える。 */
export function formatReport(report: EvalReport, previous?: EvalReport | null): string {
  const lines: string[] = [];
  lines.push(`評価: ${report.cases.length} ケース（${report.startedAt}）`);
  lines.push("");
  lines.push(
    "ケース                          決定 一致/正解/出力   ToDo 一致/正解/出力  違反  入力トークン",
  );
  for (const c of report.cases) {
    const s = c.score;
    const tokens = c.usage.first.input + (c.usage.followUp?.input ?? 0);
    const themes =
      c.findings === undefined
        ? ""
        : `  テーマ ${c.findings.score.themes.matched}/${c.findings.score.themes.expected}/${c.findings.score.themes.actual}`;
    lines.push(
      `${c.id.padEnd(30)}  ${`${s.decided.matched}/${s.decided.expected}/${s.decided.actual}`.padEnd(18)} ${`${s.todos.matched}/${s.todos.expected}/${s.todos.actual}`.padEnd(18)} ${String(s.violations.length).padEnd(4)} ${tokens}${themes}${c.filtered === true ? "  filtered（AI の安全フィルタ。指標から除外）" : c.error !== null ? `  ERROR: ${c.error}` : ""}`,
    );
    if (c.cost !== undefined && report.cost !== undefined) {
      lines.push(
        `  推定AI費用: ${report.cost.currency} ${c.cost.total.toFixed(6)}（初回 ${c.cost.first.toFixed(6)}${c.cost.followUp === null ? "" : ` / 差分 ${c.cost.followUp.toFixed(6)}`}）${c.cost.complete ? "" : " ※失敗した呼出の利用量は不明"}`,
      );
    }
    if (c.score.overview !== undefined) {
      const overview = c.score.overview;
      lines.push(
        `  概要: 要点 ${overview.points.matched}/${overview.points.expected} / 根拠検証 ${overview.evidence.passed}/${overview.evidence.items}`,
      );
    }
    if (c.request !== undefined) {
      const effects = c.request.effects;
      lines.push(
        `  依頼: ${c.request.actual?.kind ?? "失敗"} / 正解 ${c.score.request?.correct ?? 0}/1 / 誤実行 ${c.score.request?.unauthorizedEffects ?? 0}（ToDo ${effects.todoAssignees.length}、canvas書込 ${effects.canvasWrites}、宛先違い ${effects.wrongDestinations}）`,
      );
    }
  }
  if (report.skipped.length > 0) {
    lines.push(
      "",
      `飛ばしたケース: ${report.skipped.map((s) => `${s.id}（${s.reason}）`).join(", ")}`,
    );
  }
  lines.push("", "指標（既存 SC-002〜SC-006、002 SC-006/007）");
  for (const c of report.checks) lines.push(metricLine(c));
  if (!report.checks.some((c) => c.name === "followUpRatioVariable")) {
    lines.push(
      `- ${"followUpRatioVariable".padEnd(24)} ${"-".padStart(6)}  (対象のケースがないので SC-006 は判定しない)`,
    );
  }
  lines.push(
    `  参考: verifyPassRate ${fmt(report.metrics.verifyPassRate)} / pendingAccuracy ${fmt(report.metrics.pendingAccuracy)}`,
  );
  if (report.findingsMetrics !== undefined) {
    lines.push(
      `  参考: findings themePrecision ${fmt(report.findingsMetrics.themePrecision)} / themeRecall ${fmt(report.findingsMetrics.themeRecall)}（閾値なし。テーマの数は表の「テーマ 一致/正解/出力」）`,
    );
  }
  lines.push(
    `  トークン: 入力 ${report.tokens.input}（キャッシュ ${report.tokens.cachedInput}）/ 出力 ${report.tokens.output}`,
  );
  lines.push(
    report.cost === undefined
      ? "  推定AI費用: 未算出（EVAL_PRICING 未設定）"
      : `  推定AI費用: ${report.cost.currency} ${report.cost.total.toFixed(6)}（評価全体、AIのトークン料金のみ）${report.cost.complete ? "" : " ※失敗した呼出の利用量は不明。取得できた分のみ"}`,
  );
  const ids = report.followUpRatioCaseIds ?? [];
  lines.push(
    `  差分の更新の入力 / 初回の入力（SC-006。固定のシステムプロンプトとスキーマを除く。0.50 以下。新しいメッセージが全体の 2 割以下のケースだけ: ${ids.length} 件${ids.length > 0 ? `（${ids.join(", ")}）` : ""}）: ${report.followUpRatioVariable === null || report.followUpRatioVariable === undefined ? "-" : fmt(report.followUpRatioVariable)}`,
  );
  lines.push(
    `  参考: 固定を含む比 ${report.followUpRatio === null ? "-" : fmt(report.followUpRatio)}`,
  );
  const filteredIds = report.cases.filter((c) => c.filtered === true).map((c) => c.id);
  if (filteredIds.length > 0) {
    lines.push(`  filtered（指標から除外）: ${filteredIds.join(", ")}`);
  }
  if (previous) {
    lines.push("", `前回（${previous.startedAt}）との差`);
    const keys = Object.keys(report.metrics) as (keyof Metrics)[];
    for (const k of keys) {
      const before = previous.metrics[k];
      const now = report.metrics[k];
      if (before === undefined || now === undefined || before === now) continue;
      lines.push(`  ${k}: 前回 ${fmt(before)} → 今回 ${fmt(now)}`);
    }
  }
  const failed = report.checks.filter((c) => !c.ok);
  lines.push(
    "",
    failed.length === 0 ? "結果: 合格" : `結果: 不合格（${failed.map((c) => c.name).join(", ")}）`,
  );
  return lines.join("\n");
}

/** `<dir>/<日時>.json` に保存する。ファイル名は startedAt の `:` と `.` を `-` にしたもの。 */
export async function saveReport(dir: string, report: EvalReport): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${report.startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return file;
}

/** 保存済みの結果のうち、最も新しいもの。なければ null。 */
export async function loadLatestReport(dir: string): Promise<EvalReport | null> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
  const latest = files[files.length - 1];
  if (latest === undefined) return null;
  try {
    return JSON.parse(await readFile(path.join(dir, latest), "utf8")) as EvalReport;
  } catch {
    return null;
  }
}
