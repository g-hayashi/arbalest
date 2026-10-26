import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { log } from "../util/log.js";
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmTask,
  type LlmUsage,
} from "./provider.js";

/** 使う設定（Config の部分集合）。 */
export interface OpenAiCompatibleSettings {
  baseUrl?: string;
  apiKey?: string;
  modelExtract?: string;
  modelSynth?: string;
  reasoningExtract?: string;
  reasoningSynth?: string;
}

/** 差し替え可能な OpenAI クライアントの最小の形。 */
export interface ChatClient {
  chat: {
    completions: {
      create(
        params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

/** 429 と 5xx の再試行回数（SDK 側。R4）。 */
const SDK_MAX_RETRIES = 3;
const TIMEOUT_MS = 120_000;

function modelAndReasoning(s: OpenAiCompatibleSettings, task: LlmTask) {
  const synth = task === "synthesize";
  const model = synth ? s.modelSynth : s.modelExtract;
  const reasoning = synth ? s.reasoningSynth : s.reasoningExtract;
  return { model, reasoning };
}

/** 提供元の安全フィルタに該当したことを示す code / type（Azure: content_filter、OpenAI: content_policy_violation）。 */
const CONTENT_FILTER_CODES = new Set(["content_filter", "content_policy_violation"]);

const asText = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError("timeout", "AI の呼び出しがタイムアウトしました", { cause: e });
  }
  if (e instanceof OpenAI.APIError) {
    const code = asText(e.code);
    const type = asText(e.type);
    if (
      e.status === 400 &&
      ((code !== null && CONTENT_FILTER_CODES.has(code)) ||
        (type !== null && CONTENT_FILTER_CODES.has(type)))
    ) {
      // 本文やメッセージ（会話の内容を含みうる）は出さない。status・code・type だけ。
      log("WARNING", "AI の安全フィルタに該当しました", { status: e.status, code, type });
      return new LlmError("content_filter", "AI の安全フィルタに該当しました (400)", { cause: e });
    }
    if (e.status === 429)
      return new LlmError("rate_limit", "AI の呼び出しが制限されました (429)", { cause: e });
    if (e.status === 401 || e.status === 403) {
      return new LlmError("config", `AI の認証に失敗しました (${e.status})`, { cause: e });
    }
    return new LlmError("server", `AI の呼び出しに失敗しました (${e.status ?? "接続"})`, {
      cause: e,
    });
  }
  return new LlmError("server", "AI の呼び出しに失敗しました", { cause: e });
}

/** OpenAI 互換の Chat Completions で、strict の JSON Schema の応答を得る LlmProvider（R4）。 */
export function createOpenAiCompatibleProvider(
  settings: OpenAiCompatibleSettings,
  client?: ChatClient,
): LlmProvider {
  const resolveClient = (): ChatClient => {
    if (client) return client;
    if (!settings.baseUrl || !settings.apiKey) {
      throw new LlmError("config", "LLM_BASE_URL と LLM_API_KEY が必要です");
    }
    return new OpenAI({
      baseURL: settings.baseUrl,
      apiKey: settings.apiKey,
      maxRetries: SDK_MAX_RETRIES,
      timeout: TIMEOUT_MS,
    });
  };
  let cached: ChatClient | undefined;

  return {
    modelOf: (task: LlmTask) => modelAndReasoning(settings, task).model,
    async generateStructured<T>(req: LlmRequest<T>) {
      const { model, reasoning } = modelAndReasoning(settings, req.task);
      if (!model) throw new LlmError("config", `モデルが未設定です (task=${req.task})`);
      cached ??= resolveClient();
      const c = cached;

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: req.system },
        { role: "user", content: req.input },
      ];
      const responseFormat = zodResponseFormat(req.schema, req.schemaName);
      const total: LlmUsage = { input: 0, cachedInput: 0, output: 0, model, latencyMs: 0 };

      // 1 回目と、スキーマの検証に失敗したときの 1 回だけの再要求（R4）。
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        let completion: OpenAI.Chat.Completions.ChatCompletion;
        try {
          completion = await c.chat.completions.create({
            model,
            messages,
            response_format: responseFormat,
            ...(req.maxOutputTokens !== undefined
              ? { max_completion_tokens: req.maxOutputTokens }
              : {}),
            ...(reasoning
              ? {
                  reasoning_effort:
                    reasoning as OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"],
                }
              : {}),
          });
        } catch (e) {
          throw toLlmError(e);
        }
        const latencyMs = Date.now() - started;
        const u = completion.usage;
        const usage = {
          input: u?.prompt_tokens ?? 0,
          cachedInput: u?.prompt_tokens_details?.cached_tokens ?? 0,
          output: u?.completion_tokens ?? 0,
        };
        total.input += usage.input;
        total.cachedInput += usage.cachedInput;
        total.output += usage.output;
        total.latencyMs += latencyMs;
        // FR-053: 毎回の使用量を記録する。本文は出さない。
        log("INFO", "llm_usage", {
          task: req.task,
          schemaName: req.schemaName,
          model: completion.model ?? model,
          attempt: attempt + 1,
          inputTokens: usage.input,
          cachedInputTokens: usage.cachedInput,
          outputTokens: usage.output,
          latencyMs,
        });

        if (completion.choices[0]?.finish_reason === "content_filter") {
          log("WARNING", "AI の応答が安全フィルタで止められました", {
            status: 200,
            code: "content_filter",
            type: null,
          });
          throw new LlmError("content_filter", "AI の応答が安全フィルタで止められました");
        }
        const content = completion.choices[0]?.message?.content ?? "";
        let problem: string;
        try {
          const parsed = req.schema.safeParse(JSON.parse(content));
          if (parsed.success) return { data: parsed.data, usage: total };
          problem = z.prettifyError(parsed.error);
        } catch {
          problem = "応答が JSON として読めません";
        }
        if (attempt === 1) {
          throw new LlmError("schema", `AI の応答がスキーマに合いません (${req.schemaName})`);
        }
        messages.push(
          { role: "assistant", content },
          {
            role: "user",
            content: `直前の応答はスキーマに合いませんでした。次のエラーを直して、JSON だけをもう一度返してください。\n${problem}`,
          },
        );
      }
      /* c8 ignore next */
      throw new LlmError("schema", `AI の応答がスキーマに合いません (${req.schemaName})`);
    },
  };
}
