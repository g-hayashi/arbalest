import { z } from "zod";

/** 設定の検証に失敗したときの例外。メッセージには項目名だけを入れ、値は入れない。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const required = z.string().min(1);
const enabled = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const bindingSchema = z
  .object({
    tenantId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    teamId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    channelId: z.string().regex(/^19:[A-Za-z0-9._-]+@thread\.(?:tacv2|skype)$/),
    siteId: required,
    listId: required,
    verified: z
      .object({
        selected: z.boolean(),
        listWrite: z.boolean(),
        get: z.boolean(),
        search: z.boolean(),
        post: z.boolean(),
        patch: z.boolean(),
        precondition: z.boolean(),
        otherListDenied: z.boolean(),
        sameAudience: z.boolean(),
      })
      .strict(),
  })
  .strict();
const bindings = z
  .string()
  .default("[]")
  .transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid json" });
      return z.NEVER;
    }
  })
  .pipe(z.array(bindingSchema));

const base = z.object({
  GCP_PROJECT: required,
  TASKS_QUEUE: required,
  TASKS_LOCATION: required,
  TASKS_INVOKER_SA: required,
  LLM_PROVIDER: z.enum(["openai-compatible", "fake"]),
  LLM_BASE_URL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL_EXTRACT: z.string().min(1).optional(),
  LLM_MODEL_SYNTH: z.string().min(1).optional(),
  LLM_REASONING_EXTRACT: z.string().min(1).optional(),
  LLM_REASONING_SYNTH: z.string().min(1).optional(),
  FIRESTORE_DATABASE: z.string().min(1).default("(default)"),
});

const platform = z.discriminatedUnion("CHAT_PLATFORM", [
  z.object({
    CHAT_PLATFORM: z.literal("slack"),
    SLACK_BOT_TOKEN: required,
    SLACK_SIGNING_SECRET: required,
  }),
  z.object({
    CHAT_PLATFORM: z.literal("teams"),
    TEAMS_APP_ID: z.string().uuid(),
    TEAMS_APP_SECRET: required,
    TEAMS_TENANT_ID: z.string().uuid(),
    TEAMS_TODO_ENABLED: enabled,
    TEAMS_REMINDERS_ENABLED: enabled,
    TEAMS_RECORD_MODE: z.enum(["off", "message", "sharepoint"]).default("off"),
    TEAMS_SHAREPOINT_BINDINGS: bindings,
    TEAMS_ALLOWED_TEAM_IDS: z
      .string()
      .transform((value) => [
        ...new Set(
          value
            .split(",")
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean),
        ),
      ])
      .pipe(z.array(z.string().uuid()).min(1)),
  }),
]);

const roles = z.discriminatedUnion("APP_ROLE", [
  base.extend({ APP_ROLE: z.literal("ingress"), WORKER_URL: required }),
  base.extend({ APP_ROLE: z.literal("worker"), WORKER_URL: z.string().min(1).optional() }),
]);

const schema = z.intersection(roles, platform).superRefine((c, ctx) => {
  if (c.CHAT_PLATFORM === "teams") {
    const seen = new Set<string>();
    for (const binding of c.TEAMS_SHAREPOINT_BINDINGS) {
      const key = JSON.stringify([binding.tenantId, binding.teamId, binding.channelId]);
      if (
        binding.tenantId !== c.TEAMS_TENANT_ID.toLowerCase() ||
        !c.TEAMS_ALLOWED_TEAM_IDS.includes(binding.teamId) ||
        seen.has(key)
      )
        ctx.addIssue({
          code: "custom",
          path: ["TEAMS_SHAREPOINT_BINDINGS"],
          message: "invalid scope",
        });
      seen.add(key);
    }
  }
  // fake の LLM は接続しないので、接続項目は openai-compatible のときだけ必須にする。
  if (c.LLM_PROVIDER !== "openai-compatible") return;
  for (const key of [
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL_EXTRACT",
    "LLM_MODEL_SYNTH",
  ] as const) {
    if (c[key] === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: "required" });
    }
  }
});

export type Config = z.infer<typeof schema>;

/**
 * 環境変数を検証して設定にする。空文字は未設定として扱う。
 * 失敗したら、問題のある項目名を並べた ConfigError を投げる（値は出さない）。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  cleaned.CHAT_PLATFORM ??= "slack";
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? "(env)")))];
    throw new ConfigError(`環境変数が不正です: ${keys.join(", ")}`);
  }
  return result.data;
}
