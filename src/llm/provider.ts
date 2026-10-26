import type { z } from "zod";

/** AI の用途。extract と extract_chunk は EXTRACT のモデル、synthesize は SYNTH のモデルを使う。 */
export type LlmTask = "extract" | "extract_chunk" | "synthesize";

export interface LlmRequest<T> {
  task: LlmTask;
  /** 変わらない部分（プロンプトキャッシュの対象）。版を含める。 */
  system: string;
  /** 変わる部分。 */
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number;
}

export interface LlmUsage {
  input: number;
  cachedInput: number;
  output: number;
  model: string;
  latencyMs: number;
}

export interface LlmProvider {
  generateStructured<T>(req: LlmRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
  /**
   * 用途に使うモデルの識別子（未設定なら未定義）。呼び出す前に分かる値で、`chunk_cache` のキーに使う
   * （モデルが変わったら、保存した結果を使わない）。実装しない提供元は、キーの値が固定になる。
   */
  modelOf?(task: LlmTask): string | undefined;
}

/**
 * 失敗の種類。rate_limit・server・timeout は一時的（再試行で成功しうる）。
 * schema・config・content_filter（提供元の安全フィルタに該当した）は、再試行しても同じ結果になる。
 */
export type LlmErrorKind =
  | "rate_limit"
  | "server"
  | "schema"
  | "timeout"
  | "config"
  | "content_filter";

/** AI の呼び出しの失敗。kind で再試行の可否などを判断する。 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  constructor(kind: LlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
    this.kind = kind;
  }
}
