import type { protos } from "@google-cloud/tasks";

/** `CloudTasksClient` のうち、使う部分だけ。テストではフェイクに差し替える。 */
export interface CloudTasksLike {
  createTask(request: protos.google.cloud.tasks.v2.ICreateTaskRequest): Promise<unknown>;
}

export type EnqueueOptions = {
  project: string;
  location: string;
  queue: string;
  /** WORKER_URL。末尾の `/` は除いて使う。 */
  workerUrl: string;
  /** TASKS_INVOKER_SA。OIDC トークンの発行に使うサービスアカウント。 */
  invokerServiceAccount: string;
};

export type EnqueueRequest = {
  /** タスク名（`evt-<event_id>` など）。重複の除去に使う（R3）。 */
  name: string;
  /** worker のパス（`/jobs/summarize` など）。 */
  path: string;
  /** JSON の本文。 */
  payload: unknown;
};

/** `created: false` は同じ名前のタスクが既にあった（ALREADY_EXISTS）ことを表す。成功として扱う。 */
export type EnqueueResult = { created: boolean };

export type TaskEnqueuer = (req: EnqueueRequest) => Promise<EnqueueResult>;

/** dispatchDeadline（秒）。R10。 */
export const DISPATCH_DEADLINE_SECONDS = 900;

/** gRPC の ALREADY_EXISTS。 */
const GRPC_ALREADY_EXISTS = 6;

/** Cloud Tasks のタスク名に使えない文字（英数字・`-`・`_` 以外）を `-` にする。 */
function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Events API のイベントのタスク名。 */
export function eventTaskName(eventId: string): string {
  return `evt-${sanitize(eventId)}`;
}

/** block_actions のタスク名。action_ts の `.` は使えないので `-` にする。 */
export function actionTaskName(actionTs: string, userId: string): string {
  return `act-${sanitize(actionTs)}-${sanitize(userId)}`;
}

function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === GRPC_ALREADY_EXISTS;
}

/** タスクを積む関数を作る（R3、R10）。ALREADY_EXISTS 以外の失敗は投げる。 */
export function createTaskEnqueuer(client: CloudTasksLike, options: EnqueueOptions): TaskEnqueuer {
  const workerUrl = options.workerUrl.replace(/\/+$/, "");
  const parent = `projects/${options.project}/locations/${options.location}/queues/${options.queue}`;
  return async (req) => {
    try {
      await client.createTask({
        parent,
        task: {
          name: `${parent}/tasks/${req.name}`,
          dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS },
          httpRequest: {
            url: `${workerUrl}${req.path}`,
            httpMethod: "POST",
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify(req.payload), "utf8"),
            oidcToken: {
              serviceAccountEmail: options.invokerServiceAccount,
              audience: workerUrl,
            },
          },
        },
      });
      return { created: true };
    } catch (error) {
      if (isAlreadyExists(error)) return { created: false };
      throw error;
    }
  };
}
