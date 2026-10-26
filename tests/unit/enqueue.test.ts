import { describe, expect, it } from "vitest";
import {
  actionTaskName,
  type CloudTasksLike,
  createTaskEnqueuer,
  eventTaskName,
} from "../../src/tasks/enqueue.js";

type CreateTaskRequest = Parameters<CloudTasksLike["createTask"]>[0];

function fakeClient(fail?: unknown) {
  const requests: CreateTaskRequest[] = [];
  const client: CloudTasksLike = {
    async createTask(req) {
      requests.push(req);
      if (fail !== undefined) throw fail;
      return [{}];
    },
  };
  return { client, requests };
}

const options = {
  project: "proj",
  location: "asia-northeast1",
  queue: "q1",
  workerUrl: "https://worker.example.run.app",
  invokerServiceAccount: "invoker@proj.iam.gserviceaccount.com",
};

describe("タスク名", () => {
  it("イベントは evt-<event_id>", () => {
    expect(eventTaskName("Ev01ABC")).toBe("evt-Ev01ABC");
  });
  it("block_actions は act-<action_ts>-<user>。ts の . は使えない文字なので - にする", () => {
    expect(actionTaskName("1729746180.123456", "U1")).toBe("act-1729746180-123456-U1");
  });
});

describe("createTaskEnqueuer", () => {
  it("url、OIDC、dispatchDeadline、タスク名、本文を設定する", async () => {
    const { client, requests } = fakeClient();
    const enqueue = createTaskEnqueuer(client, options);
    const result = await enqueue({
      name: "evt-Ev1",
      path: "/jobs/summarize",
      payload: { a: 1 },
    });
    expect(result).toEqual({ created: true });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req?.parent).toBe("projects/proj/locations/asia-northeast1/queues/q1");
    const task = req?.task;
    expect(task?.name).toBe("projects/proj/locations/asia-northeast1/queues/q1/tasks/evt-Ev1");
    expect(task?.dispatchDeadline).toEqual({ seconds: 900 });
    expect(task?.httpRequest?.url).toBe("https://worker.example.run.app/jobs/summarize");
    expect(task?.httpRequest?.httpMethod).toBe("POST");
    expect(task?.httpRequest?.headers).toEqual({ "Content-Type": "application/json" });
    expect(task?.httpRequest?.oidcToken).toEqual({
      serviceAccountEmail: "invoker@proj.iam.gserviceaccount.com",
      audience: "https://worker.example.run.app",
    });
    expect(JSON.parse(Buffer.from(task?.httpRequest?.body as Buffer).toString("utf8"))).toEqual({
      a: 1,
    });
  });

  it("workerUrl の末尾の / は重ねない。audience は WORKER_URL のまま（末尾の / を除く）", async () => {
    const { client, requests } = fakeClient();
    const enqueue = createTaskEnqueuer(client, { ...options, workerUrl: "https://w.example/" });
    await enqueue({ name: "evt-1", path: "/jobs/todo", payload: {} });
    expect(requests[0]?.task?.httpRequest?.url).toBe("https://w.example/jobs/todo");
    expect(requests[0]?.task?.httpRequest?.oidcToken?.audience).toBe("https://w.example");
  });

  it("ALREADY_EXISTS（gRPC code 6）は成功として扱う", async () => {
    const { client } = fakeClient(Object.assign(new Error("6 ALREADY_EXISTS"), { code: 6 }));
    const enqueue = createTaskEnqueuer(client, options);
    expect(await enqueue({ name: "evt-1", path: "/jobs/todo", payload: {} })).toEqual({
      created: false,
    });
  });

  it("それ以外の失敗は投げる", async () => {
    const { client } = fakeClient(Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }));
    const enqueue = createTaskEnqueuer(client, options);
    await expect(enqueue({ name: "evt-1", path: "/jobs/todo", payload: {} })).rejects.toThrow(
      "UNAVAILABLE",
    );
  });
});
