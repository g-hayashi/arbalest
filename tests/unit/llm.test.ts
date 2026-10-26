import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config.js";
import { createFakeLlmProvider } from "../../src/llm/fake.js";
import { createLlmProvider } from "../../src/llm/index.js";
import { type ChatClient, createOpenAiCompatibleProvider } from "../../src/llm/openaiCompatible.js";
import { LlmError } from "../../src/llm/provider.js";
import { log } from "../../src/util/log.js";

const Out = z.object({ answer: z.string(), n: z.number().nullable() });
const settings = {
  baseUrl: "http://localhost",
  apiKey: "k",
  modelExtract: "model-e",
  modelSynth: "model-s",
};

function completion(
  content: string,
  usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 60 },
  },
) {
  return { model: "served", choices: [{ message: { content } }], usage } as never;
}

// biome-ignore lint/suspicious/noExplicitAny: 送ったパラメータの中身を自由に確かめるため
type Params = Record<string, any>;
function paramsOf(create: { mock: { calls: unknown[][] } }, i: number): Params {
  return (create.mock.calls[i]?.[0] ?? {}) as Params;
}

function clientOf(...responses: Array<unknown | Error>) {
  const create = vi.fn(async (_p: unknown) => {
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r as never;
  });
  const client: ChatClient = { chat: { completions: { create } } };
  return { client, create };
}

const base = { system: "sys", input: "in", schema: Out, schemaName: "out_schema" } as const;

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("severity と message を持つ 1 行の JSON を出す", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("INFO", "hello", { a: 1 });
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({
      severity: "INFO",
      message: "hello",
      a: 1,
    });
  });
});

describe("openai-compatible provider", () => {
  it("strict の JSON Schema を送り、結果と使用量を返す。usage を構造化ログに出す", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, create } = clientOf(completion('{"answer":"x","n":null}'));
    const p = createOpenAiCompatibleProvider(settings, client);
    const r = await p.generateStructured({ ...base, task: "extract", maxOutputTokens: 500 });
    expect(r.data).toEqual({ answer: "x", n: null });
    expect(r.usage).toMatchObject({ input: 100, cachedInput: 60, output: 20, model: "model-e" });
    const params = paramsOf(create, 0);
    expect(params.model).toBe("model-e");
    expect(params.max_completion_tokens).toBe(500);
    expect(params.reasoning_effort).toBeUndefined();
    expect(params.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(params.messages[1]).toEqual({ role: "user", content: "in" });
    expect(params.response_format.type).toBe("json_schema");
    expect(params.response_format.json_schema.name).toBe("out_schema");
    expect(params.response_format.json_schema.strict).toBe(true);
    expect(params.response_format.json_schema.schema.required).toEqual(["answer", "n"]);
    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({
      severity: "INFO",
      message: "llm_usage",
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 20,
    });
    expect(JSON.stringify(logged)).not.toContain("sys");
  });

  it("task でモデルと推論の強さを選ぶ（extract_chunk は EXTRACT、synthesize は SYNTH）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = { ...settings, reasoningExtract: "low", reasoningSynth: "high" };
    const ok = '{"answer":"x","n":1}';
    const { client, create } = clientOf(completion(ok), completion(ok));
    const p = createOpenAiCompatibleProvider(s, client);
    await p.generateStructured({ ...base, task: "extract_chunk" });
    await p.generateStructured({ ...base, task: "synthesize" });
    const [a, b] = create.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect([a?.model, a?.reasoning_effort]).toEqual(["model-e", "low"]);
    expect([b?.model, b?.reasoning_effort]).toEqual(["model-s", "high"]);
  });

  it("スキーマ違反は、エラーを添えて 1 回だけ再要求し、使用量は合算する", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, create } = clientOf(
      completion('{"answer":1}'),
      completion('{"answer":"y","n":2}'),
    );
    const p = createOpenAiCompatibleProvider(settings, client);
    const r = await p.generateStructured({ ...base, task: "extract" });
    expect(r.data).toEqual({ answer: "y", n: 2 });
    expect(r.usage.input).toBe(200);
    expect(create).toHaveBeenCalledTimes(2);
    const msgs = paramsOf(create, 1).messages as Array<{ role: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("2 回続けてスキーマ違反なら kind=schema（JSON でない応答も含む）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, create } = clientOf(completion("not json"), completion('{"answer":1}'));
    const p = createOpenAiCompatibleProvider(settings, client);
    await expect(p.generateStructured({ ...base, task: "extract" })).rejects.toMatchObject({
      kind: "schema",
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, "rate_limit"],
    [500, "server"],
    [503, "server"],
    [401, "config"],
  ])("HTTP %i は kind=%s", async (status, kind) => {
    const err = new OpenAI.APIError(status, {}, "x", new Headers());
    const { client } = clientOf(err);
    const p = createOpenAiCompatibleProvider(settings, client);
    await expect(p.generateStructured({ ...base, task: "extract" })).rejects.toMatchObject({
      name: "LlmError",
      kind,
    });
  });

  it.each([
    ["code が content_filter", { code: "content_filter", type: null }],
    ["code が content_policy_violation", { code: "content_policy_violation", type: null }],
    ["type が content_filter", { code: null, type: "content_filter" }],
  ])(
    "HTTP 400 で %s なら、一時的でない kind=content_filter。ログは status・code・type だけ",
    async (_n, body) => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const secret = "SECRET-PROMPT-BODY";
      const err = new OpenAI.APIError(400, body, secret, new Headers());
      const { client, create } = clientOf(err);
      const p = createOpenAiCompatibleProvider(settings, client);
      await expect(p.generateStructured({ ...base, task: "extract" })).rejects.toMatchObject({
        name: "LlmError",
        kind: "content_filter",
      });
      expect(create).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls.map((c) => String(c[0]));
      const line = logged.find((l) => l.includes("安全フィルタ") && l.includes('"status":400'));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string)).toMatchObject({ status: 400, ...body });
      expect(logged.join("\n")).not.toContain(secret);
    },
  );

  it("HTTP 400 でもフィルタ以外（code が別）は kind=server のまま", async () => {
    const err = new OpenAI.APIError(400, { code: "invalid_prompt", type: "x" }, "m", new Headers());
    const { client } = clientOf(err);
    const p = createOpenAiCompatibleProvider(settings, client);
    await expect(p.generateStructured({ ...base, task: "extract" })).rejects.toMatchObject({
      kind: "server",
    });
  });

  it("応答の finish_reason が content_filter なら kind=content_filter（再要求しない）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const filtered = {
      model: "served",
      choices: [{ message: { content: null }, finish_reason: "content_filter" }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    } as never;
    const { client, create } = clientOf(filtered);
    const p = createOpenAiCompatibleProvider(settings, client);
    await expect(p.generateStructured({ ...base, task: "extract" })).rejects.toMatchObject({
      kind: "content_filter",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("タイムアウトは kind=timeout", async () => {
    const { client } = clientOf(new OpenAI.APIConnectionTimeoutError());
    const p = createOpenAiCompatibleProvider(settings, client);
    await expect(p.generateStructured({ ...base, task: "extract" })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("モデルや接続情報がなければ kind=config", async () => {
    await expect(
      createOpenAiCompatibleProvider(
        { ...settings, modelSynth: undefined },
        clientOf().client,
      ).generateStructured({ ...base, task: "synthesize" }),
    ).rejects.toMatchObject({ kind: "config" });
    await expect(
      createOpenAiCompatibleProvider({ modelExtract: "m" }).generateStructured({
        ...base,
        task: "extract",
      }),
    ).rejects.toMatchObject({ kind: "config" });
  });
});

describe("fake provider", () => {
  it("スキーマ名ごとの関数の戻り値を検証して返し、要求を記録する", async () => {
    const f = createFakeLlmProvider({ out_schema: (req) => ({ answer: req.input, n: null }) });
    const r = await f.generateStructured({ ...base, task: "extract" });
    expect(r.data).toEqual({ answer: "in", n: null });
    expect(r.usage.model).toBe("fake");
    expect(f.calls).toHaveLength(1);
  });

  it("応答がなければ config、スキーマに合わなければ schema", async () => {
    await expect(
      createFakeLlmProvider().generateStructured({ ...base, task: "extract" }),
    ).rejects.toMatchObject({ kind: "config" });
    const f = createFakeLlmProvider({ out_schema: () => ({ answer: 1 }) });
    await expect(f.generateStructured({ ...base, task: "extract" })).rejects.toBeInstanceOf(
      LlmError,
    );
    await expect(f.generateStructured({ ...base, task: "extract" })).rejects.toMatchObject({
      kind: "schema",
    });
  });
});

describe("createLlmProvider", () => {
  const env = {
    APP_ROLE: "worker",
    GCP_PROJECT: "p",
    TASKS_QUEUE: "q",
    TASKS_LOCATION: "l",
    TASKS_INVOKER_SA: "sa",
    SLACK_BOT_TOKEN: "t",
    SLACK_SIGNING_SECRET: "s",
  };

  it("LLM_PROVIDER=fake なら fake を返す", async () => {
    const p = createLlmProvider(loadConfig({ ...env, LLM_PROVIDER: "fake" }), {
      fakeHandlers: { out_schema: () => ({ answer: "a", n: 1 }) },
    });
    expect((await p.generateStructured({ ...base, task: "extract" })).data.answer).toBe("a");
  });

  it("openai-compatible なら設定のモデルを使う", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = loadConfig({
      ...env,
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "http://x",
      LLM_API_KEY: "k",
      LLM_MODEL_EXTRACT: "me",
      LLM_MODEL_SYNTH: "ms",
    });
    const { client, create } = clientOf(completion('{"answer":"a","n":1}'));
    await createLlmProvider(config, { client }).generateStructured({ ...base, task: "synthesize" });
    expect(paramsOf(create, 0).model).toBe("ms");
  });
});
