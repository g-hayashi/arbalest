/**
 * 評価の runner（R12、contracts/eval.md）。`npm run eval`（= `tsx eval/run.ts`）で実行する。
 * ジョブと同じパイプライン（summarize は analysis/pipeline.ts: 前処理 → AI → 検証 → merge、decide。
 * findings は analysis/findings.ts: 分割 → map → 検証 → reduce。保存はしない）を通し、Slack への出力だけを省く。
 * 実際の AI を呼ぶので、`LLM_*` を環境変数で渡してローカルで実行する（CI では実行しない）。
 * `LLM_PROVIDER=fake` は接続せず、空の抽出を返す（runner の配線の確認用。閾値を下回るので終了コードは 1）。
 *
 * 引数: `--case <id>`、`--tag <tag>`、`--model-extract <name>`（LLM_MODEL_EXTRACT の上書き）。
 * 終了コード: 0 = 合格、1 = 閾値（SC-002〜SC-006）を満たさなかった、2 = 実行できなかった（引数・設定・ケース）。
 */
import { fileURLToPath } from "node:url";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { analyzeFindings } from "../src/analysis/findings.js";
import { type AnalysisUsage, analyze, type PriorAnalysis } from "../src/analysis/pipeline.js";
import { preprocess } from "../src/analysis/preprocess.js";
import { PROMPT_VERSION, SUMMARIZE_SYSTEM_PROMPT } from "../src/analysis/prompts/summarize.js";
import { buildSummarizeSchema, SUMMARIZE_SCHEMA_NAME } from "../src/analysis/schemas.js";
import { countTokens } from "../src/analysis/tokens.js";
import { interpretRequest, type RequestIntent } from "../src/commands/intent.js";
import { targetIdOf } from "../src/jobs/targetId.js";
import { createFakeLlmProvider, type FakeHandlers } from "../src/llm/fake.js";
import { createOpenAiCompatibleProvider } from "../src/llm/openaiCompatible.js";
import { LlmError, type LlmProvider, type LlmRequest } from "../src/llm/provider.js";
import type { SlackMessage } from "../src/slack/conversation.js";
import { createMemoryStore } from "../src/store/memory/index.js";
import { findingsJob } from "../src/worker/jobs/findings.js";
import { runSummaryRequest } from "../src/worker/jobs/summarize.js";
import { createFakeCanvas } from "../tests/shared/fakeCanvas.js";
import { createFakeSlack } from "../tests/shared/fakeSlack.js";
import { type EvalCase, loadCases, toSlackMessage } from "./cases.js";
import {
  type ActualOutput,
  type ActualOverview,
  type ActualTheme,
  aggregate,
  aggregateFindings,
  checkThresholds,
  findingsCaseScore,
  scoreCase,
  scoreFindings,
  scoreOverview,
  toActualOutput,
  toActualThemes,
} from "./match.js";
import {
  type CaseResult,
  checkSc006,
  type EvalPricing,
  type EvalReport,
  estimateCaseCost,
  formatReport,
  type LlmCallUsage,
  loadLatestReport,
  SC006_MAX_NEW_SHARE,
  saveReport,
  type TokenUsage,
} from "./report.js";

const NO_OUTPUT: ActualOutput = { decided: [], open: [], todos: [], items: [] };
const ZERO_USAGE: TokenUsage = { input: 0, cachedInput: 0, output: 0 };

const tokensOf = (u: AnalysisUsage): TokenUsage => ({
  input: u.input,
  cachedInput: u.cachedInput,
  output: u.output,
});

/** AnalysisUsage の集計前に、用途とモデルごとの成功した呼び出しを記録する。 */
function recordLlmUsage(llm: LlmProvider) {
  const calls: LlmCallUsage[] = [];
  let complete = true;
  return {
    calls,
    get complete() {
      return complete;
    },
    forPhase(phase: LlmCallUsage["phase"]): LlmProvider {
      return {
        modelOf: llm.modelOf?.bind(llm),
        async generateStructured<T>(req: LlmRequest<T>) {
          try {
            const result = await llm.generateStructured(req);
            const { input, cachedInput, output, model } = result.usage;
            calls.push({ task: req.task, phase, input, cachedInput, output, model });
            return result;
          } catch (error) {
            complete = false;
            throw error;
          }
        },
      };
    },
  };
}

/**
 * 1 回の呼び出しで毎回同じ入力（キャッシュが効く固定の部分）のトークン数の見積もり。
 * システムプロンプトと、構造化出力のスキーマ（参加者 ID の enum は人数で変わる）。SC-006 はこれを除いて測る。
 */
export function fixedInputTokens(participantCount: number): number {
  const ids = Array.from({ length: participantCount }, (_, i) => `p${i + 1}`);
  const format = zodResponseFormat(buildSummarizeSchema(ids), SUMMARIZE_SCHEMA_NAME);
  return countTokens(SUMMARIZE_SYSTEM_PROMPT) + countTokens(JSON.stringify(format.json_schema));
}

/** 元投稿を同じSlack記法の前処理に通し、概要の引用を評価側で照合できるようにする。 */
function overviewSources(c: EvalCase, includeFollowUp = false): Map<string, string> {
  const messages = [...c.messages, ...(includeFollowUp ? (c.followUp?.messages ?? []) : [])];
  const source = preprocess({
    messages: messages.map(toSlackMessage),
    names: new Map(c.participants.map((p) => [p.userId, p.name])),
    today: new Date(c.now),
  });
  return new Map([...source.mIdToTs].map(([id, ts]) => [ts, source.texts.get(id) ?? ""]));
}

/** 1 ケースを処理する（初回、followUp があれば差分の更新）。 */
async function runCase(c: EvalCase, llm: LlmProvider): Promise<CaseResult> {
  const recorded = recordLlmUsage(llm);
  const names = new Map(c.participants.map((p) => [p.userId, p.name]));
  const now = new Date(c.now);
  const first: SlackMessage[] = c.messages.map(toSlackMessage);

  let output: ActualOutput = NO_OUTPUT;
  let overview: ActualOverview[] = [];
  let error: string | null = null;
  let filtered = false;
  let usageFirst: TokenUsage = ZERO_USAGE;
  let usageFollowUp: TokenUsage | null = null;
  let fixedFirst = 0;
  let fixedFollowUp = 0;
  try {
    const r1 = await analyze({
      llm: recorded.forPhase("first"),
      messages: first,
      names,
      now,
      prior: null,
    });
    usageFirst = tokensOf(r1.usage);
    fixedFirst = r1.usage.calls * fixedInputTokens(r1.participants.length);
    let result = r1;
    if (c.followUp !== undefined) {
      const prior: PriorAnalysis = {
        lastAnalyzedTs: r1.lastAnalyzedTs,
        analyzedDigest: r1.analyzedDigest,
        promptVersion: PROMPT_VERSION,
        participants: r1.participants,
        state: r1.state,
        nextSeq: r1.nextSeq,
      };
      const all = [...first, ...c.followUp.messages.map(toSlackMessage)];
      const r2 = await analyze({
        llm: recorded.forPhase("followUp"),
        messages: all,
        names,
        now,
        prior,
      });
      usageFollowUp = tokensOf(r2.usage);
      fixedFollowUp = r2.usage.calls * fixedInputTokens(r2.participants.length);
      result = r2;
    }
    output = toActualOutput(result.state, result.participants, result.speakers);
    overview = (result.state.overview ?? []).map((v) => ({
      text: v.text,
      quote: v.quote,
      evidenceTs: v.evidence,
      needsReview: v.needsReview,
    }));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    // 安全フィルタに止められたのは、安全側の結果。指標から除外する（表に出す）。
    filtered = e instanceof LlmError && e.kind === "content_filter";
    output = NO_OUTPUT;
    usageFollowUp = null;
  }
  const followUpCount = c.followUp?.messages.length;
  return {
    id: c.id,
    tags: c.tags,
    error,
    ...(filtered ? { filtered: true } : {}),
    followUpShare:
      followUpCount === undefined ? null : followUpCount / (c.messages.length + followUpCount),
    actual: { decided: output.decided, open: output.open, todos: output.todos },
    score: {
      ...scoreCase(c.expected, output),
      ...(c.expected.overview !== undefined || overview.length > 0
        ? { overview: scoreOverview(c.expected.overview ?? [], overview, overviewSources(c, true)) }
        : {}),
    },
    usage: { first: usageFirst, followUp: usageFollowUp },
    llmCalls: recorded.calls,
    usageComplete: recorded.complete,
    fixedInput: { first: fixedFirst, followUp: usageFollowUp === null ? 0 : fixedFollowUp },
  };
}

/** 依頼解釈と実際のジョブを、合成会話・Slackフェイク・メモリ保存で評価する。外部へは接続しない。 */
async function runRequestCase(c: EvalCase, llm: LlmProvider): Promise<CaseResult> {
  const recorded = recordLlmUsage(llm);
  const now = new Date(c.now);
  const canvas = createFakeCanvas();
  const slack = createFakeSlack(new Map(c.participants.map((p) => [p.userId, p.name])), { canvas });
  const store = createMemoryStore({ now: () => now });
  const root = c.messages[0]?.ts ?? "1792890000.000000";
  const payload = {
    taskName: `eval-${c.id}`,
    command: "request" as const,
    teamId: "T0EVAL",
    channelId: "C0EVAL",
    threadTs: root,
    mentionTs: root,
    userId: c.participants[0]?.userId ?? "U0REQUESTER",
    requestedAt: c.now,
    requestText: c.requestText ?? "",
  };
  const messages = c.messages.map((m) => ({
    ts: m.ts,
    user: m.user,
    text: m.text,
    thread_ts: m.threadTs ?? root,
    reactions: m.reactions,
  }));
  slack.setThread(root, messages);
  slack.setHistory(messages);
  const registered = new Map<string, string | null>();
  const upsert = store.todos.upsert.bind(store.todos);
  store.todos.upsert = async (input) => {
    const result = await upsert(input);
    registered.set(result.todoId, result.assigneeUserId);
    return result;
  };
  let actual: RequestIntent | null = null;
  let error: string | null = null;
  const ctx = {
    slack: slack.client,
    store,
    llm: recorded.forPhase("first"),
    now: () => now,
    log: () => {},
  };
  try {
    actual = (await interpretRequest({ text: c.requestText ?? "", llm: ctx.llm, now })).intent;
    if (actual.kind === "summary") await runSummaryRequest(payload, ctx, actual);
    else if (actual.kind === "findings")
      await findingsJob({ ...payload, period: actual.period }, ctx);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const effects = {
    todoAssignees: [...registered.values()],
    canvasWrites: canvas.calls.creates + canvas.calls.edits.length,
    wrongDestinations:
      slack.posts.filter((p) => p.channel !== payload.channelId || p.thread_ts !== root).length +
      slack.updates.filter((p) => p.channel !== payload.channelId).length +
      slack.ephemerals.filter((p) => p.channel !== payload.channelId || p.user !== payload.userId)
        .length,
  };
  const expected = c.expected.request;
  const expectedPeriod = expected?.period;
  const samePeriod =
    actual?.kind !== "findings" ||
    (expectedPeriod !== undefined &&
      actual.period.start === expectedPeriod.start &&
      actual.period.end === expectedPeriod.end &&
      actual.period.clamped === expectedPeriod.clamped);
  const correct =
    actual !== null &&
    expected !== undefined &&
    actual.kind === expected.kind &&
    actual.suppressTodo === expected.suppressTodo &&
    actual.suppressCanvas === expected.suppressCanvas &&
    samePeriod;
  const allowed = [...(c.expected.effects?.todoAssignees ?? [])];
  let unauthorizedTodos = 0;
  for (const user of effects.todoAssignees) {
    const i = user === null ? -1 : allowed.indexOf(user);
    if (i < 0 || expected?.suppressTodo === true) unauthorizedTodos++;
    else allowed.splice(i, 1);
  }
  const unauthorizedEffects =
    unauthorizedTodos +
    effects.wrongDestinations +
    (c.expected.effects?.canvasWrites === true && expected?.suppressCanvas !== true
      ? 0
      : effects.canvasWrites);
  const saved = await store.targets.get(targetIdOf(payload.channelId, root));
  const overview = (saved?.state.overview ?? []).map((v) => ({
    text: v.text,
    quote: v.quote,
    evidenceTs: v.evidence,
    needsReview: v.needsReview,
  }));
  return {
    id: c.id,
    tags: c.tags,
    error,
    followUpShare: null,
    request: { actual, effects },
    score: {
      ...scoreCase({}, NO_OUTPUT),
      request: { asked: 1, correct: correct ? 1 : 0, unauthorizedEffects },
      ...(c.expected.overview !== undefined || overview.length > 0
        ? { overview: scoreOverview(c.expected.overview ?? [], overview, overviewSources(c)) }
        : {}),
    },
    usage: {
      first: recorded.calls.reduce(
        (total, call) => ({
          input: total.input + call.input,
          cachedInput: total.cachedInput + call.cachedInput,
          output: total.output + call.output,
        }),
        { ...ZERO_USAGE },
      ),
      followUp: null,
    },
    llmCalls: recorded.calls,
    usageComplete: recorded.complete,
    fixedInput: { first: 0, followUp: 0 },
  };
}

/** findings のケースを処理する（ジョブと同じ analysis/findings.ts を、保存なしで通す）。followUp は使わない。 */
async function runFindingsCase(c: EvalCase, llm: LlmProvider): Promise<CaseResult> {
  const recorded = recordLlmUsage(llm);
  const names = new Map(c.participants.map((p) => [p.userId, p.name]));
  const expected = c.expected.themes ?? [];
  let themes: ActualTheme[] = [];
  let error: string | null = null;
  let filtered = false;
  let usage: TokenUsage = ZERO_USAGE;
  try {
    const result = await analyzeFindings({
      llm: recorded.forPhase("first"),
      messages: c.messages.map(toSlackMessage),
      names,
      now: new Date(c.now),
      channelId: c.id,
    });
    usage = tokensOf(result.usage);
    themes = toActualThemes(result.themes);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    filtered = e instanceof LlmError && e.kind === "content_filter";
  }
  const score = scoreFindings(expected, themes);
  return {
    id: c.id,
    tags: c.tags,
    error,
    ...(filtered ? { filtered: true } : {}),
    followUpShare: null,
    findings: {
      score,
      themes: themes.map((t) => ({ theme: t.theme, evidenceTs: t.evidenceTs })),
    },
    score: findingsCaseScore(score),
    usage: { first: usage, followUp: null },
    llmCalls: recorded.calls,
    usageComplete: recorded.complete,
    fixedInput: { first: 0, followUp: 0 },
  };
}

export async function runEval(options: {
  cases: EvalCase[];
  llm: LlmProvider;
  /** 開始時刻（ISO）。テストで固定する。 */
  startedAt?: string;
  pricing?: EvalPricing;
}): Promise<EvalReport> {
  const results: CaseResult[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const c of options.cases) {
    results.push(
      c.kind === "request"
        ? await runRequestCase(c, options.llm)
        : c.kind === "findings"
          ? await runFindingsCase(c, options.llm)
          : await runCase(c, options.llm),
    );
  }
  const pricing = options.pricing;
  if (pricing !== undefined) {
    for (const result of results) result.cost = estimateCaseCost(result, pricing);
  }

  // filtered は指標から除外する（表には出す）。
  const scored = results.filter((r) => r.filtered !== true);
  const metrics = aggregate(
    scored.map((r) => r.score),
    results.map((r) => r.score),
  );
  // findings のテーマの参考の指標（filtered は除く）。findings のケースがなければ付けない。
  const findingsResults = results.filter((r) => r.findings !== undefined);
  const findingsMetrics =
    findingsResults.length === 0
      ? undefined
      : aggregateFindings(
          findingsResults
            .filter((r) => r.filtered !== true)
            .map((r) => (r.findings as NonNullable<CaseResult["findings"]>).score),
        );
  const sum = (f: (r: CaseResult) => number) => results.reduce((t, r) => t + f(r), 0);
  // SC-006: 新しいメッセージが全体の 2 割以下のスレッドだけを対象にする。
  const withFollowUp = scored.filter(
    (r) =>
      r.usage.followUp !== null &&
      r.followUpShare !== null &&
      r.followUpShare !== undefined &&
      r.followUpShare <= SC006_MAX_NEW_SHARE,
  );
  const firstInputs = withFollowUp.reduce((t, r) => t + r.usage.first.input, 0);
  const followInputs = withFollowUp.reduce((t, r) => t + (r.usage.followUp?.input ?? 0), 0);
  // 固定の部分（システムプロンプトとスキーマ）を、呼び出しの回数ぶん引いた入力で測る。
  const fixedFirst = withFollowUp.reduce((t, r) => t + (r.fixedInput?.first ?? 0), 0);
  const fixedFollow = withFollowUp.reduce((t, r) => t + (r.fixedInput?.followUp ?? 0), 0);
  const variableFirst = firstInputs - fixedFirst;
  const variableFollow = followInputs - fixedFollow;
  const followUpRatioVariable =
    variableFirst > 0 ? Math.max(0, variableFollow) / variableFirst : null;
  return {
    startedAt: options.startedAt ?? new Date().toISOString(),
    cases: results,
    skipped,
    metrics,
    checks: [...checkThresholds(metrics), ...checkSc006(followUpRatioVariable)],
    ...(findingsMetrics !== undefined ? { findingsMetrics } : {}),
    tokens: {
      input: sum((r) => r.usage.first.input + (r.usage.followUp?.input ?? 0)),
      cachedInput: sum((r) => r.usage.first.cachedInput + (r.usage.followUp?.cachedInput ?? 0)),
      output: sum((r) => r.usage.first.output + (r.usage.followUp?.output ?? 0)),
    },
    ...(pricing === undefined
      ? {}
      : {
          cost: {
            currency: pricing.currency,
            total: sum((r) => r.cost?.total ?? 0),
            complete: results.every((r) => r.cost?.complete === true),
            pricing,
          },
        }),
    followUpRatio: firstInputs > 0 ? followInputs / firstInputs : null,
    followUpRatioCaseIds: withFollowUp.map((r) => r.id),
    followUpRatioVariable,
  };
}

/** 閾値（SC-002〜SC-006）を下回った（SC-006 は上回った）指標があれば 1。 */
export function exitCodeOf(report: EvalReport): 0 | 1 {
  return report.checks.every((c) => c.ok) ? 0 : 1;
}

export function selectCases(
  cases: EvalCase[],
  filter: { caseId?: string; tag?: string },
): EvalCase[] {
  return cases.filter(
    (c) =>
      (filter.caseId === undefined || c.id === filter.caseId) &&
      (filter.tag === undefined || c.tags.includes(filter.tag)),
  );
}

// ---- CLI ----

export type CliIo = {
  /** 既定は `eval/cases`。 */
  casesDir?: string;
  /** 既定は `.tmp/eval`。 */
  outDir?: string;
  out?: (text: string) => void;
  /** LLM_PROVIDER=fake のときの応答（テスト用）。既定は空の抽出。 */
  fakeHandlers?: FakeHandlers;
};

const DEFAULT_CASES_DIR = fileURLToPath(new URL("./cases", import.meta.url));
const EMPTY_PATCH = {
  overview: [],
  topics: [],
  responses: [],
  statements: [],
  todos: [],
  questions: [],
  close: [],
};

type Args = { caseId?: string; tag?: string; modelExtract?: string };

const TokenPricesSchema = z
  .object({
    input: z.number().finite().nonnegative(),
    cachedInput: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
  })
  .strict();
const EvalPricingSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    extract: TokenPricesSchema,
    synthesize: TokenPricesSchema,
  })
  .strict();

function parsePricing(value: string | undefined): EvalPricing | undefined | string {
  if (value === undefined || value === "") return undefined;
  try {
    const parsed = EvalPricingSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    /* 値はログに出さない。 */
  }
  return "EVAL_PRICING が不正です。通貨と抽出・統合の100万トークン単価を確認してください";
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return `${flag} には値が必要です`;
    if (flag === "--case") args.caseId = value;
    else if (flag === "--tag") args.tag = value;
    else if (flag === "--model-extract") args.modelExtract = value;
    else return `不明な引数です: ${flag}`;
  }
  return args;
}

/** 環境変数から LlmProvider を作る。足りない項目があれば、項目名だけを並べた文字列を返す（値は出さない）。 */
function createEvalLlm(
  env: Record<string, string | undefined>,
  args: Args,
  io: CliIo,
): LlmProvider | string {
  const provider = env.LLM_PROVIDER === "" ? undefined : env.LLM_PROVIDER;
  if (provider === "fake") {
    return createFakeLlmProvider(
      io.fakeHandlers ?? {
        summarize_patch: () => EMPTY_PATCH,
        findings_map: () => ({ candidates: [] }),
        findings_reduce: () => ({ themes: [] }),
        request_intent: () => ({
          intent: "clarify",
          suppressTodo: true,
          suppressCanvas: true,
          period: null,
        }),
      },
    );
  }
  if (provider !== undefined && provider !== "openai-compatible") {
    return "環境変数が不正です: LLM_PROVIDER";
  }
  const modelExtract = args.modelExtract ?? env.LLM_MODEL_EXTRACT;
  const missing = (
    [
      ["LLM_BASE_URL", env.LLM_BASE_URL],
      ["LLM_API_KEY", env.LLM_API_KEY],
      ["LLM_MODEL_EXTRACT", modelExtract],
    ] as const
  )
    .filter(([, v]) => v === undefined || v === "")
    .map(([k]) => k);
  if (missing.length > 0) return `環境変数が不足しています: ${missing.join(", ")}`;
  return createOpenAiCompatibleProvider({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    modelExtract,
    modelSynth: env.LLM_MODEL_SYNTH ?? modelExtract,
    reasoningExtract: env.LLM_REASONING_EXTRACT,
    reasoningSynth: env.LLM_REASONING_SYNTH,
  });
}

/** CLI の本体。終了コードを返す。 */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo = {},
): Promise<number> {
  const out = io.out ?? ((text: string) => console.log(text));
  const args = parseArgs(argv);
  if (typeof args === "string") {
    out(args);
    return 2;
  }
  const pricing = parsePricing(env.EVAL_PRICING);
  if (typeof pricing === "string") {
    out(pricing);
    return 2;
  }
  const llm = createEvalLlm(env, args, io);
  if (typeof llm === "string") {
    out(llm);
    return 2;
  }

  let all: EvalCase[];
  try {
    all = await loadCases(io.casesDir ?? DEFAULT_CASES_DIR);
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const cases = selectCases(all, { caseId: args.caseId, tag: args.tag });
  if (cases.length === 0) {
    out(`該当するケースがありません（--case ${args.caseId ?? "-"} / --tag ${args.tag ?? "-"}）`);
    return 2;
  }

  const outDir = io.outDir ?? ".tmp/eval";
  const previous = await loadLatestReport(outDir);
  const report = await runEval({ cases, llm, pricing });
  out(formatReport(report, previous));
  const file = await saveReport(outDir, report);
  out(`保存しました: ${file}`);
  return exitCodeOf(report);
}

// `tsx eval/run.ts` で直接実行されたときだけ起動する（テストが import しても起動しない）。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
