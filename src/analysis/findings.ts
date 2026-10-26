/**
 * findings の分析（US4、R5、data-model.md#chunk_cache、contracts/llm.md#findings のスキーマ）。
 * 前処理 → 分割 → chunk ごとに map（`extract_chunk`。保存した結果があれば AI を呼ばない）→ 検証（V1・V2）
 * → 候補に `c<n>` を振る → reduce（`synthesize`。入力は候補だけ）→ 根拠をコードで作る。
 * Slack には触れない。ジョブ（worker/jobs/findings.ts）と評価（eval/run.ts）が共有する。
 *
 * chunk_cache の値は、map の結果を検証した後の候補（根拠は m-id ではなく ts）。m-id は chunk ごとの
 * 一時的な ID なので、保存するときに ts に直す。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { compareTs, type SlackMessage } from "../slack/conversation.js";
import type { ChunkCacheRepo } from "../store/types.js";
import { log as defaultLog } from "../util/log.js";
import { chunkMessages } from "./chunk.js";
import type { AnalysisUsage } from "./pipeline.js";
import { neutralizeDelimiters, preprocess } from "./preprocess.js";
import {
  buildFindingsMapRequest,
  PROMPT_VERSION as FINDINGS_MAP_VERSION,
} from "./prompts/findingsMap.js";
import { buildFindingsReduceRequest } from "./prompts/findingsReduce.js";
import { FINDING_KINDS } from "./schemas.js";
import { verifyItem } from "./verify.js";

/** 期間の既定と上限（日）。上限は無償プランで取れる履歴の長さ（R11）。 */
export const FINDINGS_DEFAULT_DAYS = 30;
export const FINDINGS_MAX_DAYS = 90;

/** map の候補を検証した後の値（chunk_cache に保存する）。根拠は ts。 */
const StoredCandidateSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  themeHint: z.string(),
  statement: z.string(),
  evidenceTs: z.array(z.string()),
  needsReview: z.boolean(),
  reviewReasons: z.array(z.string()),
});
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;
const StoredCandidatesSchema = z.array(StoredCandidateSchema);

/** 前回の chunk の範囲と内容。候補本体は従来のキーで保存する。 */
const CachedChunksSchema = z.array(
  z.object({
    key: z.string(),
    messages: z.array(z.object({ ts: z.string(), root: z.string(), hash: z.string() })),
  }),
);
type CachedChunk = z.infer<typeof CachedChunksSchema>[number];
type ReusableChunk = { messages: SlackMessage[]; candidates: StoredCandidate[] };
/** Firestore のドキュメント上限に余裕を残す。大きい索引では通常の chunk 単位のキャッシュに戻す。 */
const CHUNKS_INDEX_MAX_BYTES = 256 * 1024;

/** reduce に渡す候補（`c<n>` の ID 付き）。 */
export type FindingsCandidate = StoredCandidate & { id: string };

export type FindingItem = {
  statement: string;
  /** 根拠の ts（昇順）。candidate_ids に対応する候補の evidence の和集合。 */
  evidence: string[];
  needsReview: boolean;
  reviewReasons: string[];
};
export type FindingTheme = { theme: string; findings: FindingItem[] };

export type AnalyzeFindingsInput = {
  llm: LlmProvider;
  /** 期間の会話。ts の昇順（ボットの投稿は除いてある）。スレッドの返信を含む。 */
  messages: SlackMessage[];
  /** userId → 表示名。 */
  names: ReadonlyMap<string, string>;
  now: Date;
  botUserId?: string;
  channelId: string;
  /** 指定がなければ保存・再利用しない（評価）。 */
  cache?: ChunkCacheRepo;
  /** 分割の上限。既定は chunk.ts の 60,000。テストで小さくできる。 */
  chunkMaxTokens?: number;
  log?: typeof defaultLog;
  /** ログに付ける欄（channelId など）。 */
  logFields?: Record<string, unknown>;
};

export type FindingsAnalysis = {
  themes: FindingTheme[];
  chunks: number;
  /** map で AI を呼ばずに済んだ chunk の数（FR-042）。 */
  cacheHits: number;
  candidates: number;
  usage: AnalysisUsage;
};

/** chunk の本文のハッシュ（ts、投稿者、本文、リアクション）。表示名の変更では変わらない。 */
function bodyHash(chunk: readonly SlackMessage[]): string {
  const rows = chunk.map((m) => [
    m.ts,
    m.threadTs,
    m.userId,
    m.text,
    m.reactions
      .filter((r) => r.userIds.length > 0)
      .map((r) => [r.name, [...r.userIds].sort()])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/**
 * chunk_cache のキー（data-model.md）。channelId、期間の区切り（chunk の先頭と末尾の ts）、
 * 本文のハッシュ、map のプロンプトの版、モデルの sha256。
 */
export function chunkCacheKey(
  channelId: string,
  chunk: readonly SlackMessage[],
  model: string,
): string {
  const first = chunk[0]?.ts ?? "";
  const last = chunk[chunk.length - 1]?.ts ?? "";
  return createHash("sha256")
    .update(
      JSON.stringify([
        "findings_map",
        channelId,
        first,
        last,
        bodyHash(chunk),
        FINDINGS_MAP_VERSION,
        model,
      ]),
    )
    .digest("hex");
}

function threadHashes(messages: readonly SlackMessage[]): Map<string, string> {
  const threads = new Map<string, SlackMessage[]>();
  for (const m of [...messages].sort((a, b) => compareTs(a.ts, b.ts))) {
    const root = m.threadTs ?? m.ts;
    const group = threads.get(root) ?? [];
    group.push(m);
    threads.set(root, group);
  }
  return new Map([...threads].map(([root, group]) => [root, bodyHash(group)]));
}

function cachedChunk(
  key: string,
  messages: readonly SlackMessage[],
  hashes: ReadonlyMap<string, string>,
): CachedChunk {
  return {
    key,
    messages: messages.map((m) => ({
      ts: m.ts,
      root: m.threadTs ?? m.ts,
      // 上限を超えたスレッドが複数 chunk に分かれても、成功済みの chunk を再試行で使える。
      hash: hashes.get(m.threadTs ?? m.ts) as string,
    })),
  };
}

/** モデル・プロンプトをまたがず、前回の分割範囲を引くためのキー。 */
function chunksIndexKey(channelId: string, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["findings_chunks@1", channelId, FINDINGS_MAP_VERSION, model]))
    .digest("hex");
}

/**
 * 分割の境界が動いても、内容が同じスレッドの候補を再利用する。
 * 返信の追加・編集・削除・リアクションの変更はスレッド全体を無効にする。
 * 候補が複数のスレッドを根拠にする場合は、関連するスレッドも一緒に再抽出する。
 */
async function reusableChunks(
  cache: ChunkCacheRepo,
  indexKey: string,
  messages: SlackMessage[],
  hashes: ReadonlyMap<string, string>,
): Promise<ReusableChunk[]> {
  const index = CachedChunksSchema.safeParse(await cache.get(indexKey));
  if (!index.success) return [];
  const records = await Promise.all(
    index.data.map(async (entry) => ({
      entry,
      candidates: StoredCandidatesSchema.safeParse(await cache.get(entry.key)),
    })),
  );
  const currentByTs = new Map(messages.map((m) => [m.ts, m]));
  const reusable = new Set(hashes.keys());
  for (const entry of index.data) {
    for (const m of entry.messages) {
      if (!currentByTs.has(m.ts) || hashes.get(m.root) !== m.hash) reusable.delete(m.root);
    }
  }
  // 候補が欠けたキャッシュは、同じスレッドの別の chunk も含めて取り直す。
  for (const { entry, candidates } of records) {
    if (!candidates.success) for (const m of entry.messages) reusable.delete(m.root);
  }
  let invalidated: boolean;
  do {
    invalidated = false;
    for (const { entry, candidates } of records) {
      if (!candidates.success) continue;
      const rootsByTs = new Map(entry.messages.map((m) => [m.ts, m.root]));
      for (const candidate of candidates.data) {
        // 根拠を特定できない要確認の候補は chunk 全体に依存するものとして扱う。
        const roots =
          candidate.evidenceTs.length === 0
            ? entry.messages.map((m) => m.root)
            : candidate.evidenceTs.map((ts) => rootsByTs.get(ts));
        if (roots.every((root) => root !== undefined && reusable.has(root))) continue;
        for (const root of roots) {
          if (root !== undefined && reusable.delete(root)) invalidated = true;
        }
      }
    }
  } while (invalidated);

  return records.flatMap(({ entry, candidates }) => {
    if (!candidates.success) return [];
    const kept = entry.messages.filter((m) => reusable.has(m.root));
    if (kept.length === 0) return [];
    const keptTs = new Set(kept.map((m) => m.ts));
    return [
      {
        messages: kept.map((m) => currentByTs.get(m.ts) as SlackMessage),
        candidates: candidates.data.filter((c) =>
          c.evidenceTs.length === 0
            ? kept.length === entry.messages.length
            : c.evidenceTs.every((ts) => keptTs.has(ts)),
        ),
      },
    ];
  });
}

/** reduce の入力の区切りのタグ。 */
const CANDIDATES_TAG = /<\s*\/?\s*candidates\b[^>]*>?/gi;

/** 候補の文を 1 行にし、区切りのタグを全角にして無害にする（会話に由来する文字列なので、指示にならないようにする）。 */
function oneLineSafe(text: string): string {
  return neutralizeDelimiters(text.replace(/\s+/g, " ").trim()).replace(CANDIDATES_TAG, (m) =>
    m.replaceAll("<", "＜").replaceAll(">", "＞"),
  );
}

/** reduce の入力。メッセージも根拠も含めず、候補だけにする。 */
export function renderCandidates(candidates: readonly FindingsCandidate[]): string {
  return [
    "<candidates>",
    ...candidates.map(
      (c) => `[${c.id}] (${c.kind}) ${oneLineSafe(c.themeHint)}: ${oneLineSafe(c.statement)}`,
    ),
    "</candidates>",
  ].join("\n");
}

function addUsage(total: AnalysisUsage, used: LlmUsage): void {
  total.calls += 1;
  total.input += used.input;
  total.cachedInput += used.cachedInput;
  total.output += used.output;
  if (!total.models.includes(used.model)) total.models.push(used.model);
}

export async function analyzeFindings(input: AnalyzeFindingsInput): Promise<FindingsAnalysis> {
  const { llm, messages, names, now, botUserId, channelId, cache } = input;
  const log = input.log ?? defaultLog;
  const logFields = { channelId, ...input.logFields };
  const usage: AnalysisUsage = { calls: 0, input: 0, cachedInput: 0, output: 0, models: [] };
  const model = llm.modelOf?.("extract_chunk") ?? "unknown";
  const indexKey = chunksIndexKey(channelId, model);
  const hashes = threadHashes(messages);
  const reused = cache === undefined ? [] : await reusableChunks(cache, indexKey, messages, hashes);
  const reusedTs = new Set(reused.flatMap((chunk) => chunk.messages.map((m) => m.ts)));
  const chunks = chunkMessages(
    messages.filter((m) => !reusedTs.has(m.ts)),
    input.chunkMaxTokens !== undefined ? { maxTokens: input.chunkMaxTokens } : {},
  );
  const nextIndex: CachedChunk[] = [];
  let indexOverflow = false;
  const saveChunk = async (chunk: SlackMessage[], candidates: StoredCandidate[]) => {
    if (cache === undefined) return;
    const key = chunkCacheKey(channelId, chunk, model);
    await cache.put(key, candidates);
    if (indexOverflow) return;
    nextIndex.push(cachedChunk(key, chunk, hashes));
    if (Buffer.byteLength(JSON.stringify(nextIndex), "utf8") > CHUNKS_INDEX_MAX_BYTES) {
      indexOverflow = true;
      nextIndex.length = 0;
    }
    // 成功した chunk ごとに更新し、一時的な失敗の後も再利用できるようにする。
    await cache.put(indexKey, nextIndex);
  };

  // map: chunk ごとに、保存した結果があれば使い、なければ AI を呼んで保存する。
  const stored: StoredCandidate[] = [];
  let cacheHits = reused.length;
  for (const chunk of reused) {
    await saveChunk(chunk.messages, chunk.candidates);
    stored.push(...chunk.candidates);
  }
  for (const chunk of chunks) {
    const key = chunkCacheKey(channelId, chunk, model);
    const cached = cache === undefined ? null : await cache.get(key);
    const parsed = cached === null ? null : StoredCandidatesSchema.safeParse(cached);
    if (parsed?.success) {
      cacheHits += 1;
      stored.push(...parsed.data);
      await saveChunk(chunk, parsed.data);
      continue;
    }

    const pre = preprocess({
      messages: chunk,
      names,
      today: now,
      ...(botUserId !== undefined ? { botUserId } : {}),
    });
    const res = await llm.generateStructured(buildFindingsMapRequest(pre.input));
    addUsage(usage, res.usage);

    const verifyCtx = {
      texts: pre.texts,
      mIdToTs: pre.mIdToTs,
      participantIds: new Set<string>(),
      today: now,
    };
    const candidates: StoredCandidate[] = res.data.candidates.map((c) => {
      // V1・V2。問題があっても捨てず、needsReview にする。
      const v = verifyItem({ evidence: c.evidence, quote: c.quote }, verifyCtx);
      return {
        kind: c.kind,
        themeHint: c.theme_hint,
        statement: c.statement,
        evidenceTs: v.evidenceTs,
        needsReview: v.needsReview,
        reviewReasons: v.reviewReasons,
      };
    });
    // 空の結果も保存する（候補のない chunk でも、次は AI を呼ばない）。
    await saveChunk(chunk, candidates);
    stored.push(...candidates);
  }

  const chunkCount = reused.length + chunks.length;

  const candidates: FindingsCandidate[] = stored.map((c, i) => ({ ...c, id: `c${i + 1}` }));
  if (candidates.length === 0) {
    return { themes: [], chunks: chunkCount, cacheHits, candidates: 0, usage };
  }

  // reduce: 入力は候補だけ。
  const res = await llm.generateStructured(
    buildFindingsReduceRequest(renderCandidates(candidates)),
  );
  addUsage(usage, res.usage);

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const used = new Set<string>();
  const themes: FindingTheme[] = [];
  for (const t of res.data.themes) {
    const findings: FindingItem[] = [];
    for (const f of t.findings) {
      const known = [...new Set(f.candidate_ids)].filter((id) => byId.has(id));
      const unknown = f.candidate_ids.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        // V5 と同じ扱い: 実在しない ID は捨てる。
        log("WARNING", "findings: 存在しない候補の ID を捨てた", {
          ...logFields,
          ids: unknown,
          kept: known.length,
        });
      }
      if (known.length === 0) continue;
      const refs = known.map((id) => byId.get(id) as FindingsCandidate);
      for (const id of known) used.add(id);
      // 根拠は、候補の evidence の和集合（コードで作る）。
      const evidence = [...new Set(refs.flatMap((c) => c.evidenceTs))].sort(compareTs);
      // 検証に通った候補が 1 つもなければ要確認。
      const needsReview = refs.every((c) => c.needsReview);
      findings.push({
        statement: f.statement,
        evidence,
        needsReview,
        reviewReasons: needsReview ? [...new Set(refs.flatMap((c) => c.reviewReasons))] : [],
      });
    }
    if (findings.length > 0) themes.push({ theme: t.theme, findings });
  }
  const omitted = candidates.length - used.size;
  if (omitted > 0) {
    log("INFO", "findings: reduce が使わなかった候補がある", { ...logFields, omitted });
  }

  return { themes, chunks: chunkCount, cacheHits, candidates: candidates.length, usage };
}
