import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const common = {
  GCP_PROJECT: "test-project",
  TASKS_QUEUE: "arbalest-queue",
  TASKS_LOCATION: "asia-northeast1",
  TASKS_INVOKER_SA: "invoker@test-project.iam.gserviceaccount.com",
  SLACK_BOT_TOKEN: "xoxb-dummy",
  SLACK_SIGNING_SECRET: "dummy-secret",
  LLM_PROVIDER: "openai-compatible",
  LLM_BASE_URL: "https://llm.example.com/v1",
  LLM_API_KEY: "dummy-key",
  LLM_MODEL_EXTRACT: "model-extract",
  LLM_MODEL_SYNTH: "model-synth",
};

const ingressEnv = { ...common, APP_ROLE: "ingress", WORKER_URL: "https://worker.example.com" };
const workerEnv = { ...common, APP_ROLE: "worker" };

describe("loadConfig", () => {
  const teamsEnv = {
    ...workerEnv,
    CHAT_PLATFORM: "teams",
    SLACK_BOT_TOKEN: "",
    SLACK_SIGNING_SECRET: "",
    TEAMS_APP_ID: "22222222-2222-4222-8222-222222222222",
    TEAMS_APP_SECRET: "synthetic-secret",
    TEAMS_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    TEAMS_ALLOWED_TEAM_IDS: "33333333-3333-4333-8333-333333333333",
  };

  it("TeamsはSlackの秘密なしで起動設定を検証できる", () => {
    const c = loadConfig(teamsEnv);
    expect(c.CHAT_PLATFORM).toBe("teams");
    if (c.CHAT_PLATFORM !== "teams") throw new Error("Teams 設定ではありません");
    expect(c.TEAMS_ALLOWED_TEAM_IDS).toEqual([teamsEnv.TEAMS_ALLOWED_TEAM_IDS]);
    expect(loadConfig(workerEnv).CHAT_PLATFORM).toBe("slack");
  });

  it("Teams管理機能は独立した既定無効フラグを持つ", () => {
    expect(loadConfig(teamsEnv)).toMatchObject({
      TEAMS_TODO_ENABLED: false,
      TEAMS_REMINDERS_ENABLED: false,
      TEAMS_RECORD_MODE: "off",
      TEAMS_SHAREPOINT_BINDINGS: [],
    });
    expect(
      loadConfig({ ...teamsEnv, TEAMS_TODO_ENABLED: "true", TEAMS_RECORD_MODE: "message" }),
    ).toMatchObject({
      TEAMS_TODO_ENABLED: true,
      TEAMS_REMINDERS_ENABLED: false,
      TEAMS_RECORD_MODE: "message",
    });
    for (const [key, value] of [
      ["TEAMS_TODO_ENABLED", "yes"],
      ["TEAMS_REMINDERS_ENABLED", "1"],
      ["TEAMS_RECORD_MODE", "canvas"],
      ["TEAMS_SHAREPOINT_BINDINGS", "private-invalid-json"],
    ] as const) {
      expect(() => loadConfig({ ...teamsEnv, [key]: value })).toThrow(new RegExp(key));
    }
  });

  it("SharePoint固定bindingはtenant/team/重複を拒否し値をエラーへ出さない", () => {
    const binding = {
      tenantId: teamsEnv.TEAMS_TENANT_ID,
      teamId: teamsEnv.TEAMS_ALLOWED_TEAM_IDS,
      channelId: "19:test@thread.tacv2",
      siteId: "private-site",
      listId: "private-list",
      verified: {
        selected: true,
        listWrite: true,
        get: true,
        search: true,
        post: true,
        patch: true,
        precondition: true,
        otherListDenied: true,
        sameAudience: true,
      },
    };
    expect(
      loadConfig({ ...teamsEnv, TEAMS_SHAREPOINT_BINDINGS: JSON.stringify([binding]) }),
    ).toMatchObject({ TEAMS_SHAREPOINT_BINDINGS: [binding] });
    for (const bindings of [
      [binding, binding],
      [{ ...binding, tenantId: teamsEnv.TEAMS_APP_ID }],
      [{ ...binding, teamId: teamsEnv.TEAMS_APP_ID }],
    ]) {
      expect(() =>
        loadConfig({ ...teamsEnv, TEAMS_SHAREPOINT_BINDINGS: JSON.stringify(bindings) }),
      ).toThrow("TEAMS_SHAREPOINT_BINDINGS");
    }
    expect(() =>
      loadConfig({ ...teamsEnv, TEAMS_SHAREPOINT_BINDINGS: "private-invalid-json" }),
    ).not.toThrow(/private-invalid-json/);
  });

  it("Slack構成への切り戻しで残ったTeams設定を要求・誤解釈しない", () => {
    expect(
      loadConfig({ ...workerEnv, TEAMS_ALLOWED_TEAM_IDS: teamsEnv.TEAMS_ALLOWED_TEAM_IDS })
        .CHAT_PLATFORM,
    ).toBe("slack");
  });

  it.each(["TEAMS_APP_ID", "TEAMS_APP_SECRET", "TEAMS_TENANT_ID", "TEAMS_ALLOWED_TEAM_IDS"])(
    "Teamsの必須項目 %s が欠けたら失敗する",
    (key) => {
      expect(() => loadConfig({ ...teamsEnv, [key]: "" })).toThrow(new RegExp(key));
    },
  );

  it("Teamsの識別子・空allowlist・プラットフォーム誤記は拒否する", () => {
    expect(() => loadConfig({ ...teamsEnv, TEAMS_APP_ID: "not-a-guid" })).toThrow(/TEAMS_APP_ID/);
    expect(() => loadConfig({ ...teamsEnv, TEAMS_ALLOWED_TEAM_IDS: " , " })).toThrow(
      /TEAMS_ALLOWED_TEAM_IDS/,
    );
    expect(() => loadConfig({ ...teamsEnv, TEAMS_ALLOWED_TEAM_IDS: "arbitrary" })).toThrow(
      /TEAMS_ALLOWED_TEAM_IDS/,
    );
    expect(() => loadConfig({ ...teamsEnv, CHAT_PLATFORM: "temas" })).toThrow(/CHAT_PLATFORM/);
  });

  it("ingress: すべて揃っていれば読める（FIRESTORE_DATABASE の既定は (default)）", () => {
    const c = loadConfig(ingressEnv);
    expect(c.APP_ROLE).toBe("ingress");
    expect(c.WORKER_URL).toBe("https://worker.example.com");
    expect(c.FIRESTORE_DATABASE).toBe("(default)");
    expect(c.LLM_REASONING_EXTRACT).toBeUndefined();
    expect(c.LLM_REASONING_SYNTH).toBeUndefined();
  });

  it("worker: WORKER_URL がなくても読める", () => {
    const c = loadConfig(workerEnv);
    expect(c.APP_ROLE).toBe("worker");
    expect(c.WORKER_URL).toBeUndefined();
  });

  it("ingress: WORKER_URL がなければ、その名前を挙げて失敗する", () => {
    const { WORKER_URL: _omit, ...env } = ingressEnv;
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/WORKER_URL/);
  });

  it("空文字は未設定として扱う", () => {
    expect(() => loadConfig({ ...ingressEnv, WORKER_URL: "" })).toThrow(/WORKER_URL/);
  });

  it("APP_ROLE がないか不正なら失敗する", () => {
    const { APP_ROLE: _omit, ...env } = workerEnv;
    expect(() => loadConfig(env)).toThrow(/APP_ROLE/);
    expect(() => loadConfig({ ...workerEnv, APP_ROLE: "other" })).toThrow(/APP_ROLE/);
  });

  it.each([
    "GCP_PROJECT",
    "TASKS_QUEUE",
    "TASKS_LOCATION",
    "TASKS_INVOKER_SA",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL_EXTRACT",
    "LLM_MODEL_SYNTH",
  ])("必須項目 %s がなければ、その名前を挙げて失敗する", (key) => {
    for (const base of [ingressEnv, workerEnv]) {
      const env: Record<string, string> = { ...base };
      delete env[key];
      expect(() => loadConfig(env)).toThrow(new RegExp(key));
    }
  });

  it("エラーの文面に秘密の値を含めない", () => {
    try {
      loadConfig({ ...workerEnv, LLM_PROVIDER: "nope" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("xoxb-dummy");
      expect((e as Error).message).not.toContain("dummy-key");
      expect((e as Error).message).not.toContain("dummy-secret");
    }
  });

  it("LLM_PROVIDER は openai-compatible か fake だけ", () => {
    expect(() => loadConfig({ ...workerEnv, LLM_PROVIDER: "azure" })).toThrow(/LLM_PROVIDER/);
  });

  it("LLM_PROVIDER=fake なら LLM の接続項目は要らない", () => {
    const env: Record<string, string> = { ...workerEnv, LLM_PROVIDER: "fake" };
    delete env.LLM_BASE_URL;
    delete env.LLM_API_KEY;
    delete env.LLM_MODEL_EXTRACT;
    delete env.LLM_MODEL_SYNTH;
    expect(loadConfig(env).LLM_PROVIDER).toBe("fake");
  });

  it("任意項目を読む", () => {
    const c = loadConfig({
      ...workerEnv,
      FIRESTORE_DATABASE: "arbalest-test",
      LLM_REASONING_EXTRACT: "low",
      LLM_REASONING_SYNTH: "high",
    });
    expect(c.FIRESTORE_DATABASE).toBe("arbalest-test");
    expect(c.LLM_REASONING_EXTRACT).toBe("low");
    expect(c.LLM_REASONING_SYNTH).toBe("high");
  });
});
