import { z } from "zod";
import { LlmError, type LlmProvider, type LlmRequest, type LlmUsage } from "./provider.js";

/** スキーマ名ごとの応答関数。戻り値はスキーマで検証される。 */
export type FakeHandlers = Record<string, (req: LlmRequest<unknown>) => unknown | Promise<unknown>>;

export interface FakeLlmProvider extends LlmProvider {
  /** 受け取った要求の記録（テストでの確認用）。 */
  readonly calls: LlmRequest<unknown>[];
}

/** テスト用の LlmProvider。外部に接続せず、スキーマ名に対応する関数の戻り値を返す。 */
export function createFakeLlmProvider(handlers: FakeHandlers = {}): FakeLlmProvider {
  const calls: LlmRequest<unknown>[] = [];
  return {
    calls,
    modelOf: () => "fake",
    async generateStructured<T>(req: LlmRequest<T>) {
      calls.push(req as LlmRequest<unknown>);
      const handler = handlers[req.schemaName];
      if (!handler) {
        throw new LlmError("config", `fake の応答がありません: ${req.schemaName}`);
      }
      const raw = await handler(req as LlmRequest<unknown>);
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        throw new LlmError(
          "schema",
          `fake の応答がスキーマに合いません: ${z.prettifyError(parsed.error)}`,
        );
      }
      const usage: LlmUsage = { input: 0, cachedInput: 0, output: 0, model: "fake", latencyMs: 0 };
      return { data: parsed.data, usage };
    },
  };
}
