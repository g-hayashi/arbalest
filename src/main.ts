/**
 * エントリポイント。`APP_ROLE` で ingress と worker を切り替える（plan.md、R2、R3）。
 * - ingress: Slack の署名を検証してイベントをタスクに積む（公開）。
 * - worker: Cloud Tasks から呼ばれてジョブを実行する（非公開、IAM 必須）。
 */
import { fileURLToPath } from "node:url";
import { CloudTasksClient } from "@google-cloud/tasks";
import { WebClient } from "@slack/web-api";
import { type Config, loadConfig } from "./config.js";
import { createIngressApp } from "./ingress/app.js";
import { createIngressSlack } from "./ingress/slack.js";
import { JOB_PATHS, type JobPayload, REMINDERS_PATH, type TodoDonePayload } from "./jobs/types.js";
import { createLlmProvider } from "./llm/index.js";
import { FirestoreStore } from "./store/firestore/index.js";
import { createTaskEnqueuer } from "./tasks/enqueue.js";
import { renderTeamsRecordSnapshot } from "./teams/records.js";
import { createFirestoreTeamsWorkStore } from "./teams/store/firestore.js";
import { log } from "./util/log.js";
import { canvasJob } from "./worker/jobs/canvas.js";
import { findingsJob } from "./worker/jobs/findings.js";
import { remindersJob } from "./worker/jobs/reminders.js";
import { requestJob } from "./worker/jobs/request.js";
import { summarizeJob } from "./worker/jobs/summarize.js";
import { todoDoneJob, todoJob } from "./worker/jobs/todos.js";
import { createWorker, DEFAULT_MAX_RETRY_COUNT } from "./worker/server.js";

function portOf(env: Record<string, string | undefined>): number {
  const port = Number.parseInt(env.PORT ?? "", 10);
  return Number.isFinite(port) && port > 0 ? port : 8080;
}

async function startIngress(
  config: Extract<Config, { APP_ROLE: "ingress"; CHAT_PLATFORM: "slack" }>,
  port: number,
): Promise<void> {
  const web = new WebClient(config.SLACK_BOT_TOKEN);
  const auth = await web.auth.test();
  if (!auth.user_id) throw new Error("auth.test の応答に user_id がありません");
  const { app } = createIngressApp({
    signingSecret: config.SLACK_SIGNING_SECRET,
    botToken: config.SLACK_BOT_TOKEN,
    botId: auth.bot_id,
    deps: {
      botUserId: auth.user_id,
      now: () => new Date(),
      slack: createIngressSlack(web),
      enqueue: createTaskEnqueuer(new CloudTasksClient(), {
        project: config.GCP_PROJECT,
        location: config.TASKS_LOCATION,
        queue: config.TASKS_QUEUE,
        workerUrl: config.WORKER_URL,
        invokerServiceAccount: config.TASKS_INVOKER_SA,
      }),
    },
  });
  await app.start(port);
  log("INFO", "ingress を起動しました", { port });
}

async function startWorker(
  config: Extract<Config, { APP_ROLE: "worker"; CHAT_PLATFORM: "slack" }>,
  env: Record<string, string | undefined>,
  port: number,
): Promise<void> {
  const maxRetry = Number.parseInt(env.TASKS_MAX_RETRY_COUNT ?? "", 10);
  const worker = createWorker({
    slack: new WebClient(config.SLACK_BOT_TOKEN),
    store: new FirestoreStore({
      databaseId: config.FIRESTORE_DATABASE,
      collectionPrefix: "",
      projectId: config.GCP_PROJECT,
    }),
    llm: createLlmProvider(config),
    now: () => new Date(),
    maxRetryCount: Number.isFinite(maxRetry) && maxRetry >= 0 ? maxRetry : DEFAULT_MAX_RETRY_COUNT,
  });
  // ジョブの本体は、各ユーザーストーリーで worker.registerJob(path, handler) として登録する。
  worker.registerJob<JobPayload>(JOB_PATHS.summarize, summarizeJob);
  worker.registerJob<JobPayload>(JOB_PATHS.request, requestJob);
  worker.registerJob<JobPayload>(JOB_PATHS.canvas, canvasJob);
  worker.registerJob<JobPayload>(JOB_PATHS.todo, todoJob);
  // findings のロックは server.ts の既定（f_<channelId>）。
  worker.registerJob<JobPayload>(JOB_PATHS.findings, findingsJob);
  // 完了の操作は他のジョブと並んでよい（ロックしない）。リマインドは taskName を持たず、重複の除去もしない。
  worker.registerJob<TodoDonePayload>(JOB_PATHS.todoDone, todoDoneJob, { lockKey: () => null });
  worker.registerJob(REMINDERS_PATH, remindersJob, { dedupe: false });
  await worker.listen(port);
  log("INFO", "worker を起動しました", { port });
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env);
  const port = portOf(env);
  if (config.CHAT_PLATFORM === "teams") {
    const { createTeamsApp, createTeamsWorker } = await import("./teams/runtime.js");
    const enabled =
      config.TEAMS_TODO_ENABLED ||
      config.TEAMS_REMINDERS_ENABLED ||
      config.TEAMS_RECORD_MODE !== "off";
    const store =
      config.APP_ROLE === "worker" || enabled
        ? new FirestoreStore({
            databaseId: config.FIRESTORE_DATABASE,
            collectionPrefix: "",
            projectId: config.GCP_PROJECT,
          })
        : undefined;
    const work =
      enabled && store
        ? {
            store: createFirestoreTeamsWorkStore({
              firestore: store.db,
              collectionPrefix: store.collectionPrefix,
              renderSnapshot: renderTeamsRecordSnapshot,
            }),
          }
        : undefined;
    if (config.APP_ROLE === "ingress") {
      const { app } = createTeamsApp(config, {
        work,
        enqueue: createTaskEnqueuer(new CloudTasksClient(), {
          project: config.GCP_PROJECT,
          location: config.TASKS_LOCATION,
          queue: config.TASKS_QUEUE,
          workerUrl: config.WORKER_URL,
          invokerServiceAccount: config.TASKS_INVOKER_SA,
        }),
      });
      await app.start(port);
    } else {
      if (!store) throw new Error("Teams worker store is missing");
      const maxRetry = Number.parseInt(env.TASKS_MAX_RETRY_COUNT ?? "", 10);
      await createTeamsWorker({
        config,
        store,
        work,
        llm: createLlmProvider(config),
        maxRetryCount:
          Number.isFinite(maxRetry) && maxRetry >= 0 ? maxRetry : DEFAULT_MAX_RETRY_COUNT,
      }).listen(port);
    }
    log("INFO", "Teams サービスを起動しました", { role: config.APP_ROLE, port });
  } else if (config.APP_ROLE === "ingress") {
    await startIngress(config, port);
  } else {
    await startWorker(config, env, port);
  }
}

// `node dist/main.js` で直接実行されたときだけ起動する（テストが import しても起動しない）。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    log("ERROR", "起動に失敗しました", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
