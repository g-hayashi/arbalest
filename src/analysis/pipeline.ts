/**
 * まとめの分析（前処理 → 抽出 → 検証 → merge。R5、data-model.md#差分の適用）。
 * Slack とストアには触れない純粋なパイプラインで、ジョブ（worker/jobs/summarize.ts）と評価（eval/run.ts）が共有する。
 * 差分か全体かの判断、チャンクの分割、項目 ID の引き継ぎ、表示用の差分（marks）までを担当する。
 */
import { createHash } from "node:crypto";
import type { LlmProvider } from "../llm/provider.js";
import { compareTs, type SlackMessage } from "../slack/conversation.js";
import type { DiffMark } from "../slack/render.js";
import {
  type AnalysisState,
  emptyAnalysisState,
  normalizeAnalysisState,
  type Participant,
  type TargetDoc,
} from "../store/types.js";
import { chunkMessages } from "./chunk.js";
import {
  applyPatch,
  carryOverIds,
  diffMarks,
  logDropped,
  summaryChanged,
  verifyOverview,
} from "./merge.js";
import { preprocess, renderPreviousState } from "./preprocess.js";
import { buildSummarizeRequest, PROMPT_VERSION } from "./prompts/summarize.js";
import { countTokens } from "./tokens.js";

/** 前回の状態がこれを超えたら、差分ではなく全体を処理し直す（R5）。 */
export const STATE_MAX_TOKENS = 6000;

/** 前回の分析の結果（`TargetDoc` のうち、分析に使う欄）。 */
export type PriorAnalysis = Pick<
  TargetDoc,
  "lastAnalyzedTs" | "analyzedDigest" | "promptVersion" | "participants" | "state" | "nextSeq"
>;

/** 全体を処理し直す理由。 */
export type ReprocessReason = "prompt_version" | "state_too_large" | "edited" | "deleted";

export type AnalyzeInput = {
  llm: LlmProvider;
  /** 今回の取得結果。ts の昇順（ボットの投稿は除いてある）。 */
  messages: SlackMessage[];
  /** userId → 表示名。 */
  names: ReadonlyMap<string, string>;
  now: Date;
  botUserId?: string;
  /** 前回の結果。初回は null。 */
  prior: PriorAnalysis | null;
  /** 取得の範囲の下限（チャネルの直近）。これより古い ts は、前回の digest にあっても「削除」とみなさない。 */
  oldestTs?: string;
  /** 分割の上限。既定は chunk.ts の 60,000。テストで小さくできる。 */
  chunkMaxTokens?: number;
  /** 捨てた操作のログに付ける欄（targetId など）。 */
  logFields?: Record<string, unknown>;
};

export type AnalysisUsage = {
  calls: number;
  input: number;
  cachedInput: number;
  output: number;
  models: string[];
};

export type AnalyzeResult = {
  state: AnalysisState;
  nextSeq: Record<string, number>;
  participants: Participant[];
  /** 表示用の差分。初回は undefined（見出しに件数を出さない）。 */
  marks: Map<string, DiffMark> | undefined;
  /** まとめ（概要、決定事項、未決定事項、問い）が前回から変わったか。ToDo の変化は含めない。初回は undefined。 */
  summaryChanged: boolean | undefined;
  /** スレッドで発言した人の p-id（ボットを除く）。decide と diffMarks に渡す。 */
  speakers: string[];
  /** 保存する値。 */
  lastAnalyzedTs: string;
  analyzedDigest: Record<string, string>;
  /** 前回の状態を捨てて全体を処理し直したか（初回は false）。 */
  reprocessed: ReprocessReason | null;
  usage: AnalysisUsage;
};

/**
 * 本文（編集後）とリアクション（絵文字の名前と押した人。並べ替えて順序に依らない）の sha1 の先頭 12 文字。
 * 後から付いたリアクションでの合意を拾うため、リアクションの変化も不一致になる。
 * 本文だけで作った旧形式のハッシュとは必ず食い違い、全体の処理し直しになるだけで壊れない。
 */
export function digestOf(message: Pick<SlackMessage, "text" | "reactions">): string {
  const reactions = message.reactions
    .filter((r) => r.userIds.length > 0)
    .map((r) => [r.name, [...r.userIds].sort()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha1")
    .update(JSON.stringify([message.text, reactions]))
    .digest("hex")
    .slice(0, 12);
}

/** 前回の状態を捨てて全体を処理し直すべきか。必要なら理由を返す（data-model.md の 3 条件）。 */
export function reprocessReason(
  prior: PriorAnalysis,
  messages: readonly SlackMessage[],
  oldestTs?: string,
): ReprocessReason | null {
  if (prior.promptVersion !== PROMPT_VERSION) return "prompt_version";
  if (countTokens(renderPreviousState(prior.state).join("\n")) > STATE_MAX_TOKENS) {
    return "state_too_large";
  }
  const byTs = new Map(messages.map((m) => [m.ts, m]));
  for (const [ts, hash] of Object.entries(prior.analyzedDigest)) {
    if (oldestTs !== undefined && compareTs(ts, oldestTs) <= 0) continue;
    const m = byTs.get(ts);
    if (m === undefined) return "deleted";
    if (digestOf(m) !== hash) return "edited";
  }
  return null;
}

/**
 * 本文がボットへのメンション（`<@BOT>`、`<@BOT|name>`、複数可）と空白だけの投稿か。
 * 「@arbalest」だけの呼び出しは会話の内容ではないので、分析の入力に含めない。
 */
export function isBotMentionOnly(text: string, botUserId: string | undefined): boolean {
  if (botUserId === undefined || botUserId === "") return false;
  const id = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:\\s*<@${id}(?:\\|[^>]*)?>)+\\s*$`).test(text);
}

export async function analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
  const { llm, names, now, botUserId, prior } = input;
  // 空のメンションは、初回・差分・チャネルのどの経路でも入力、digest、lastAnalyzedTs から除く。
  // 差分では除いた結果が 0 件になれば、既存の「新しい投稿なし」の経路で AI を呼ばない。
  const messages = input.messages.filter((m) => !isBotMentionOnly(m.text, botUserId));
  const reason = prior === null ? null : reprocessReason(prior, messages, input.oldestTs);
  const full = prior === null || reason !== null;

  let state: AnalysisState = full
    ? emptyAnalysisState()
    : normalizeAnalysisState((prior as PriorAnalysis).state);
  let nextSeq: Record<string, number> = full ? {} : (prior as PriorAnalysis).nextSeq;
  let participants: Participant[] = prior?.participants ?? [];

  const toSend = full
    ? messages
    : messages.filter((m) => compareTs(m.ts, (prior as PriorAnalysis).lastAnalyzedTs) > 0);
  const chunks =
    toSend.length === 0
      ? []
      : chunkMessages(
          toSend,
          input.chunkMaxTokens !== undefined ? { maxTokens: input.chunkMaxTokens } : {},
        );

  const usage: AnalysisUsage = { calls: 0, input: 0, cachedInput: 0, output: 0, models: [] };
  for (const chunk of chunks) {
    const pre = preprocess({
      messages: chunk,
      names,
      today: now,
      previousState: state,
      previousParticipants: participants,
      incremental: !full,
      ...(botUserId !== undefined ? { botUserId } : {}),
    });
    participants = pre.participants;
    const participantIds = participants.map((p) => p.id);
    const res = await llm.generateStructured(buildSummarizeRequest(pre.input, participantIds));
    usage.calls += 1;
    usage.input += res.usage.input;
    usage.cachedInput += res.usage.cachedInput;
    usage.output += res.usage.output;
    if (!usage.models.includes(res.usage.model)) usage.models.push(res.usage.model);

    const applied = applyPatch({
      state,
      nextSeq,
      patch: res.data,
      ctx: {
        texts: pre.texts,
        mIdToTs: pre.mIdToTs,
        participantIds: new Set(participantIds),
        today: now,
      },
    });
    logDropped(applied.dropped, input.logFields);
    state = applied.state;
    nextSeq = applied.nextSeq;
  }

  // 全体を処理し直した結果の項目 ID は、前回の状態から引き継ぐ。
  if (prior !== null && full) {
    const carried = carryOverIds(prior.state, state, prior.nextSeq);
    state = carried.state;
    nextSeq = carried.nextSeq;
  }

  // 差分で引き継いだ概要も現在の取得範囲で検証する。チャンクの外にある有効な根拠は残す。
  if (messages.length === 0) state.overview = [];
  else if ((state.overview ?? []).length > 0) {
    const current = preprocess({
      messages,
      names,
      today: now,
      previousParticipants: participants,
      ...(botUserId !== undefined ? { botUserId } : {}),
    });
    state.overview = verifyOverview(state.overview ?? [], {
      texts: current.texts,
      mIdToTs: current.mIdToTs,
      participantIds: new Set(participants.map((p) => p.id)),
      today: now,
    });
  }

  const pidOf = new Map(participants.map((p) => [p.userId, p.id]));
  const speakers = [
    ...new Set(
      messages.flatMap((m) => {
        const id = m.userId === null ? undefined : pidOf.get(m.userId);
        return id === undefined ? [] : [id];
      }),
    ),
  ];
  const marks = prior === null ? undefined : diffMarks(prior.state, state, speakers);
  const summaryDiffers =
    prior === null || marks === undefined ? undefined : summaryChanged(prior.state, state, marks);

  const last = messages[messages.length - 1];
  return {
    state,
    nextSeq,
    participants,
    marks,
    summaryChanged: summaryDiffers,
    speakers,
    lastAnalyzedTs: last?.ts ?? prior?.lastAnalyzedTs ?? "0",
    analyzedDigest: Object.fromEntries(messages.map((m) => [m.ts, digestOf(m)])),
    reprocessed: reason,
    usage,
  };
}
