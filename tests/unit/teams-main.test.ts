import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(undefined),
  sdk: vi.fn(),
  worker: vi.fn(),
  slack: vi.fn(),
  tasks: vi.fn(),
  workStore: vi.fn().mockReturnValue({ synthetic: "work-store" }),
}));
vi.mock("../../src/teams/store/firestore.js", () => ({
  createFirestoreTeamsWorkStore: mocks.workStore,
}));
vi.mock("../../src/teams/runtime.js", () => ({
  createTeamsApp: mocks.sdk.mockImplementation(() => ({ app: { start: mocks.start } })),
  createTeamsWorker: mocks.worker.mockImplementation(() => ({ listen: mocks.listen })),
}));
vi.mock("@slack/web-api", () => ({ WebClient: mocks.slack }));
vi.mock("@google-cloud/tasks", () => ({
  CloudTasksClient: class {
    createTask = mocks.tasks;
  },
}));
vi.mock("../../src/store/firestore/index.js", () => ({
  FirestoreStore: class {
    db = { synthetic: "db" };
    collectionPrefix = "";
  },
}));

import { main } from "../../src/main.js";
import { TEAMS_ACTION_PATH } from "../../src/teams/actions.js";

const env = {
  CHAT_PLATFORM: "teams",
  TEAMS_APP_ID: "22222222-2222-4222-8222-222222222222",
  TEAMS_APP_SECRET: "synthetic",
  TEAMS_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  TEAMS_ALLOWED_TEAM_IDS: "33333333-3333-4333-8333-333333333333",
  GCP_PROJECT: "test",
  TASKS_QUEUE: "test",
  TASKS_LOCATION: "test",
  TASKS_INVOKER_SA: "tasks@example.test",
  LLM_PROVIDER: "fake",
  PORT: "8082",
};
beforeEach(() => vi.clearAllMocks());
describe("Teams のエントリポイント", () => {
  it("Teams actionを投入するCloud Tasksにも固定worker audienceのOIDCを付ける", async () => {
    await main({
      ...env,
      APP_ROLE: "ingress",
      WORKER_URL: "https://worker.example.test/",
      TEAMS_TODO_ENABLED: "true",
    });
    await mocks.sdk.mock.calls[0]?.[1].enqueue({
      name: "teams-action-synthetic",
      path: TEAMS_ACTION_PATH,
      payload: { platform: "teams" },
    });
    expect(mocks.tasks).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          httpRequest: expect.objectContaining({
            url: `https://worker.example.test${TEAMS_ACTION_PATH}`,
            oidcToken: {
              serviceAccountEmail: env.TASKS_INVOKER_SA,
              audience: "https://worker.example.test",
            },
          }),
        }),
      }),
    );
  });
  it.each(["worker", "ingress"])(
    "%sの有効機能へ共用DBの専用storeとrendererを注入する",
    async (role) => {
      await main({
        ...env,
        APP_ROLE: role,
        WORKER_URL: "https://worker.example.test",
        TEAMS_TODO_ENABLED: "true",
      });
      expect(mocks.workStore).toHaveBeenCalledWith(
        expect.objectContaining({
          firestore: { synthetic: "db" },
          collectionPrefix: "",
          renderSnapshot: expect.any(Function),
        }),
      );
      const args =
        role === "worker" ? mocks.worker.mock.calls[0]?.[0] : mocks.sdk.mock.calls[0]?.[1];
      expect(args.work).toEqual({ store: { synthetic: "work-store" } });
    },
  );
  it("ingressはTeams SDKだけを起動し、Slackへ接続しない", async () => {
    await main({ ...env, APP_ROLE: "ingress", WORKER_URL: "https://worker.example.test" });
    expect(mocks.sdk).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(8082);
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.slack).not.toHaveBeenCalled();
    expect(mocks.tasks).not.toHaveBeenCalled();
  });
  it("workerはTeams用ルートを使い、キューの再試行設定を渡す", async () => {
    await main({ ...env, APP_ROLE: "worker", TASKS_MAX_RETRY_COUNT: "6" });
    expect(mocks.worker).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetryCount: 6,
        config: expect.objectContaining({ CHAT_PLATFORM: "teams" }),
      }),
    );
    expect(mocks.listen).toHaveBeenCalledWith(8082);
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.slack).not.toHaveBeenCalled();
  });
});
