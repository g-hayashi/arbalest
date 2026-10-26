import inject from "light-my-request";
import { describe, expect, it, vi } from "vitest";
import { createFakeLlmProvider } from "../../src/llm/fake.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { TeamsApiError } from "../../src/teams/graph.js";
import { BUSY_TEXT, createWorker, FAILED_TEXT } from "../../src/worker/server.js";

function setup() {
  const store = createMemoryStore();
  const notify = vi.fn().mockResolvedValue(undefined);
  const worker = createWorker({
    store,
    llm: createFakeLlmProvider(),
    now: () => new Date(),
    notifyRequester: notify,
  });
  return { worker, store, notify };
}
const payload = { taskName: "teams-request", platform: "teams" };

describe("Teams worker の共通経路", () => {
  it("cronはCloud Tasksの最終試行ヘッダーが混入しても一時失敗をHTTP失敗で返す", async () => {
    const { worker, notify } = setup();
    worker.registerJob(
      "/cron/teams-reminders",
      async () => {
        throw new TeamsApiError(429, 120000);
      },
      { dedupe: false, honorTaskRetryCount: false },
    );
    const response = await inject(worker.handle, {
      method: "POST",
      url: "/cron/teams-reminders",
      headers: { "x-cloudtasks-taskretrycount": "99" },
      payload: { platform: "teams" },
    });
    expect(response.statusCode).toBe(500);
    expect(notify).not.toHaveBeenCalled();
  });
  it("試行上限を無視する明示オプションは重複除去の有無と独立する", async () => {
    const { worker, notify } = setup();
    worker.registerJob(
      "/teams",
      async () => {
        throw new TeamsApiError(503);
      },
      { honorTaskRetryCount: false },
    );
    const response = await inject(worker.handle, {
      method: "POST",
      url: "/teams",
      headers: { "x-cloudtasks-taskretrycount": "99" },
      payload,
    });
    expect(response.statusCode).toBe(500);
    expect(notify).not.toHaveBeenCalled();
  });
  it("Slack workerへTeams管理/cronを混入させない", async () => {
    const { worker } = setup();
    for (const url of ["/jobs/teams-action", "/cron/teams-reminders", "/cron/teams-repair"])
      expect((await inject(worker.handle, { method: "POST", url, payload })).statusCode).toBe(404);
  });
  it("不正payloadは重複処理記録より前に拒否する", async () => {
    const { worker, store, notify } = setup();
    const dedupe = vi.spyOn(store.events, "markProcessed");
    const handler = vi.fn();
    worker.registerJob("/teams", handler, { validate: () => false });
    const res = await inject(worker.handle, { method: "POST", url: "/teams", payload });
    expect(res.statusCode).toBe(400);
    expect(dedupe).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it("busy通知をTeamsの通知関数へ渡す", async () => {
    const { worker, store, notify } = setup();
    await store.locks.acquire("teams-target", 60000);
    worker.registerJob("/teams", vi.fn(), { lockKey: () => "teams-target" });
    const res = await inject(worker.handle, { method: "POST", url: "/teams", payload });
    expect(res.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith(payload, BUSY_TEXT);
  });
  it("失敗通知をTeamsへ渡し、Slackへアクセスしない", async () => {
    const { worker, notify } = setup();
    worker.registerJob("/teams", async () => {
      throw new TypeError("bug");
    });
    const res = await inject(worker.handle, { method: "POST", url: "/teams", payload });
    expect(res.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith(payload, FAILED_TEXT);
  });
});
