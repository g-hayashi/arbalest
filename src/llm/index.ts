import type { Config } from "../config.js";
import { createFakeLlmProvider, type FakeHandlers } from "./fake.js";
import { type ChatClient, createOpenAiCompatibleProvider } from "./openaiCompatible.js";
import type { LlmProvider } from "./provider.js";

export { createFakeLlmProvider, type FakeHandlers, type FakeLlmProvider } from "./fake.js";
export type { LlmProvider, LlmRequest, LlmTask, LlmUsage } from "./provider.js";
export { LlmError } from "./provider.js";

export interface CreateLlmOptions {
  /** LLM_PROVIDER=fake のときの応答関数。 */
  fakeHandlers?: FakeHandlers;
  /** openai-compatible のクライアントの差し替え（テスト用）。 */
  client?: ChatClient;
}

/** LLM_PROVIDER に従って LlmProvider を作る。 */
export function createLlmProvider(config: Config, options: CreateLlmOptions = {}): LlmProvider {
  if (config.LLM_PROVIDER === "fake") return createFakeLlmProvider(options.fakeHandlers);
  return createOpenAiCompatibleProvider(
    {
      baseUrl: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY,
      modelExtract: config.LLM_MODEL_EXTRACT,
      modelSynth: config.LLM_MODEL_SYNTH,
      reasoningExtract: config.LLM_REASONING_EXTRACT,
      reasoningSynth: config.LLM_REASONING_SYNTH,
    },
    options.client,
  );
}
