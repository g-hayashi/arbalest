/**
 * worker の土台（contracts/http-and-tasks.md#worker、R3）。
 * ルートとジョブ本体は registerJob で登録する（各ユーザーストーリーで追加）。共通の処理:
 * 1. `events.markProcessed(taskName)` で重複を除く（再試行のときは除かない。後述）。
 * 2. `locks.acquire(targetId)` が取れなければ「処理中です」と返信して 200。
 * 3. ジョブを呼ぶ。失敗したら、種類に応じて 200 か 5xx を返す。一時的でない失敗（LlmError の schema・config・
 *    content_filter、実装のバグ）は 200 と失敗の返信。一時的な失敗（timeout・rate_limit・server など）だけ 5xx。
 * 4. ロックを解放する（トークンが一致するときだけ消える）。
 *
 * 再試行の扱い: 失敗して 5xx を返したジョブは、Cloud Tasks が `X-CloudTasks-TaskRetryCount` ≥ 1 で
 * 再送する。markProcessed は最初の試行で済んでいるので、再試行のときは重複の除去を飛ばして実行する。
 * （最初の試行が成功した後の重複配信は retry count が 0 なので、除かれる。）
 */
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { WebClient } from "@slack/web-api";
import { findingsLockId, targetIdOf } from "../jobs/targetId.js";
import { LlmError, type LlmProvider } from "../llm/index.js";
import { NO_UNFURL } from "../slack/unfurl.js";
import { LOCK_LEASE_MS } from "../store/ttl.js";
import type { Store } from "../store/types.js";
import { log } from "../util/log.js";

export type JobContext = {
  slack: WebClient;
  store: Store;
  llm: LlmProvider;
  now: () => Date;
  log: typeof log;
};

export type JobHandler<P = unknown> = (payload: P, ctx: JobContext) => Promise<void>;

export type RegisterJobOptions = {
  /** プラットフォーム固有の入力を、ストアや通知に触れる前に検証する。 */
  validate?: (payload: Record<string, unknown>) => boolean;
  /**
   * ロックの ID。null ならロックしない。
   * 既定: `command` と `channelId` を持つ JobPayload なら、findings は `f_<ch>`、
   * それ以外はスレッドが `t_<ch>_<ts>`、チャネルが `c_<ch>`。持たなければロックしない。
   */
  lockKey?: (payload: Record<string, unknown>) => string | null;
  /** false なら taskName を求めず、重複の除去もしない（`/cron/reminders` など）。既定は true。 */
  dedupe?: boolean;
  /** falseならTasksの最終試行でも一時失敗をHTTP失敗で返す（Scheduler用）。既定true。 */
  honorTaskRetryCount?: boolean;
};

export type WorkerDeps = {
  slack?: WebClient;
  /** Teams 等の通知先。未指定なら従来の Slack 通知を使う。 */
  notifyRequester?: (payload: Record<string, unknown>, text: string) => Promise<void>;
  /** 外部SDKの例外が本文や認証情報を含む場合はログへ展開しない。 */
  redactErrors?: boolean;
  store: Store;
  llm: LlmProvider;
  now: () => Date;
  /** `X-CloudTasks-TaskRetryCount` がこの値以上なら最後の試行とみなす。キューの max_attempts - 1 に合わせる。 */
  maxRetryCount?: number;
};

export interface Worker {
  registerJob<P = unknown>(
    path: string,
    handler: JobHandler<P>,
    options?: RegisterJobOptions,
  ): void;
  /** Node の http サーバに渡すリスナー（テストは light-my-request に渡す）。 */
  handle: RequestListener;
  listen(port: number): Promise<Server>;
}

/** キューの max_attempts = 5（最初の試行 + 再試行 4 回）を想定した既定。 */
export const DEFAULT_MAX_RETRY_COUNT = 4;

export const BUSY_TEXT = "同じ対象を処理中です。完了までしばらくお待ちください。";
export const NOT_IN_CHANNEL_TEXT =
  "このチャネルの会話を読めませんでした。チャネルに `/invite @arbalest` してから、もう一度お試しください。";
export const FAILED_TEXT = "処理に失敗しました。時間をおいて、もう一度メンションしてください。";
export const FILTERED_TEXT =
  "AI の安全フィルタにより分析できませんでした。会話の内容を確認してから、もう一度メンションしてください。";

/** 再試行しても直らない失敗か（contracts/http-and-tasks.md#応答コード）。 */
function isPermanentFailure(error: unknown): boolean {
  if (error instanceof LlmError) {
    return error.kind === "schema" || error.kind === "config" || error.kind === "content_filter";
  }
  // 実装のバグ。再試行しても同じ例外になる。
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  );
}

const MAX_BODY_BYTES = 1024 * 1024;

type Route = {
  handler: JobHandler<Record<string, unknown>>;
  dedupe: boolean;
  options: RegisterJobOptions;
};

class BadRequestError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError("body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequestError("invalid json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError("body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function retryCountOf(req: IncomingMessage): number {
  const raw = req.headers["x-cloudtasks-taskretrycount"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = value === undefined ? 0 : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function slackErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : null;
}

function defaultLockKey(payload: Record<string, unknown>): string | null {
  const { command, channelId, threadTs } = payload;
  if (typeof command !== "string" || typeof channelId !== "string") return null;
  if (command === "findings") return findingsLockId(channelId);
  return targetIdOf(channelId, typeof threadTs === "string" ? threadTs : null);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * 呼んだ人に知らせる。スレッドへの返信 → chat.postEphemeral → DM の順に試す。
 * どれも失敗したらログだけ残す（再試行させないため、例外は投げない）。
 */
async function notifyRequester(
  slack: WebClient,
  payload: Record<string, unknown>,
  text: string,
): Promise<void> {
  const channel = str(payload.channelId);
  const user = str(payload.userId);
  const threadTs = str(payload.mentionTs) ?? str(payload.threadTs);
  if (channel !== undefined) {
    try {
      await slack.chat.postMessage({
        channel,
        text,
        ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
        ...NO_UNFURL,
      });
      return;
    } catch {
      // 次の手段へ
    }
  }
  if (channel !== undefined && user !== undefined) {
    try {
      await slack.chat.postEphemeral({ channel, user, text });
      return;
    } catch {
      // 次の手段へ
    }
  }
  if (user !== undefined) {
    try {
      const dm = await slack.conversations.open({ users: user });
      const dmId = dm.channel?.id;
      if (dmId !== undefined) {
        await slack.chat.postMessage({ channel: dmId, text, ...NO_UNFURL });
        return;
      }
    } catch {
      // 諦める
    }
  }
  log("WARNING", "利用者に通知できませんでした", { channelId: channel });
}

export function createWorker(deps: WorkerDeps): Worker {
  const maxRetryCount = deps.maxRetryCount ?? DEFAULT_MAX_RETRY_COUNT;
  const routes = new Map<string, Route>();
  const ctx: JobContext = {
    get slack() {
      if (!deps.slack) throw new TypeError("Slack はこの worker で設定されていません");
      return deps.slack;
    },
    store: deps.store,
    llm: deps.llm,
    now: deps.now,
    log,
  };
  const notify = async (payload: Record<string, unknown>, text: string): Promise<void> => {
    if (deps.notifyRequester) {
      try {
        await deps.notifyRequester(payload, text);
      } catch {
        log("WARNING", "利用者に通知できませんでした");
      }
    } else if (deps.slack) {
      await notifyRequester(deps.slack, payload, text);
    }
  };

  async function runJob(
    path: string,
    route: Route,
    req: IncomingMessage,
  ): Promise<{ status: number; body: string }> {
    const body = await readJsonBody(req);
    if (route.options.validate && !route.options.validate(body)) {
      throw new BadRequestError("invalid job payload");
    }
    const retryCount = retryCountOf(req);

    if (route.dedupe) {
      const taskName = str(body.taskName);
      if (taskName === undefined) throw new BadRequestError("taskName is required");
      if (retryCount === 0 && !(await deps.store.events.markProcessed(taskName))) {
        log("INFO", "重複のため処理しません", { path, taskName });
        return { status: 200, body: "duplicate" };
      }
    }

    const lockKey = (route.options.lockKey ?? defaultLockKey)(body);
    let token: string | null = null;
    if (lockKey !== null) {
      token = await deps.store.locks.acquire(lockKey, LOCK_LEASE_MS);
      if (token === null) {
        log("INFO", "同じ対象を処理中のため、処理しません", { path, lockKey });
        await notify(body, BUSY_TEXT);
        return { status: 200, body: "busy" };
      }
    }

    try {
      await route.handler(body, ctx);
      return { status: 200, body: "ok" };
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "not_in_channel" || code === "channel_not_found") {
        log("WARNING", "チャネルに招待されていません", { path, code });
        await notify(body, NOT_IN_CHANNEL_TEXT);
        return { status: 200, body: "not in channel" };
      }
      const message = deps.redactErrors
        ? "詳細省略"
        : error instanceof Error
          ? error.message
          : String(error);
      log("ERROR", "ジョブが失敗しました", { path, retryCount, error: message });
      // 一時的でない失敗は、再試行させず 200 で終える（Cloud Tasks の再試行は一時的な失敗だけ）。
      if (isPermanentFailure(error)) {
        const filtered = error instanceof LlmError && error.kind === "content_filter";
        await notify(body, filtered ? FILTERED_TEXT : FAILED_TEXT);
        return { status: 200, body: "failed" };
      }
      // Scheduler専用の指定時だけHTTP失敗を保ち、既存経路の最終試行契約を維持する。
      if (route.options.honorTaskRetryCount !== false && retryCount >= maxRetryCount) {
        await notify(body, FAILED_TEXT);
        return { status: 200, body: "failed" };
      }
      return { status: 500, body: "error" };
    } finally {
      if (token !== null && lockKey !== null) {
        await deps.store.locks.release(lockKey, token);
      }
    }
  }

  const handle: RequestListener = (req, res) => {
    const send = (status: number, body: string) => {
      if (res.headersSent) return;
      res.statusCode = status;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(body);
    };
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && path === "/healthz") {
      send(200, "ok");
      return;
    }
    const route = req.method === "POST" ? routes.get(path) : undefined;
    if (route === undefined) {
      send(404, "not found");
      return;
    }
    runJob(path, route, req).then(
      (r) => send(r.status, r.body),
      (error: unknown) => {
        if (error instanceof BadRequestError) {
          send(400, error.message);
          return;
        }
        // ストアの失敗など。Cloud Tasks に再試行させる。
        const message = deps.redactErrors
          ? "詳細省略"
          : error instanceof Error
            ? error.message
            : String(error);
        log("ERROR", "worker の共通処理が失敗しました", { path, error: message });
        send(500, "error");
      },
    );
  };

  return {
    registerJob(path, handler, options = {}) {
      routes.set(path, {
        handler: handler as JobHandler<Record<string, unknown>>,
        dedupe: options.dedupe ?? true,
        options,
      });
    },
    handle,
    listen(port) {
      const server = createServer(handle);
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve(server));
      });
    },
  };
}
