/** Teams の SDK、Graph、共通 worker を接続する。SDK の匿名認証は使用しない。 */
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { App, ExpressAdapter, type HttpMethod, type HttpRouteHandler } from "@microsoft/teams.apps";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { Store } from "../store/types.js";
import type { TaskEnqueuer } from "../tasks/enqueue.js";
import { log } from "../util/log.js";
import { createWorker, type Worker } from "../worker/server.js";
import {
  dispatchTeamsAction,
  executeTeamsAction,
  TEAMS_ACTION_PATH,
  type TeamsActionPayload,
  validateTeamsActionPayload,
} from "./actions.js";
import { createTeamsGraphReader, parseTeamsRetryAfter, TeamsApiError } from "./graph.js";
import {
  dispatchTeamsMessage,
  isTrustedTeamsServiceUrl,
  TEAMS_JOB_PATH,
  type TeamsTrust,
  validateTeamsPayload,
} from "./ingress.js";
import { createTeamsJob, type TeamsReply, teamsTargetId } from "./job.js";
import {
  recoverTeamsRecord,
  syncTeamsRecord,
  type TeamsRecordWriter,
  validateTeamsRecordMessage,
} from "./records.js";
import { createTeamsRemindersJob } from "./reminders.js";
import { splitTeamsLines } from "./render.js";
import {
  createTeamsSharePointClient,
  resyncTeamsSharePoint,
  syncTeamsSharePoint,
  type TeamsSharePointClient,
} from "./sharepoint.js";
import { type TeamsScope, TeamsWorkError, type TeamsWorkStore } from "./store/types.js";
import type { TeamsGraphReader, TeamsJobPayload } from "./types.js";

export type TeamsConfig = Extract<Config, { CHAT_PLATFORM: "teams" }>;

/** SDK は HTTP エラーに本文やヘッダーを含め得るため、外部の値をログへ展開しない。 */
const safeLogger: NonNullable<App["options"]["logger"]> = {
  debug() {},
  info() {},
  trace() {},
  warn() {
    log("WARNING", "Teams SDK の警告（詳細省略）");
  },
  error() {
    log("ERROR", "Teams SDK のエラー（詳細省略）");
  },
  log(level) {
    if (level === "error") this.error();
    else if (level === "warn") this.warn();
  },
  child() {
    return safeLogger;
  },
};

/** body parser の例外も SDK のルートの後で捕捉し、Express の既定ログへ流さない。 */
class TeamsHttpAdapter extends ExpressAdapter {
  /** Express 自体を公開し、注入テストでも HTTP の応答本文を正しく観測する。 */
  get handle(): RequestListener {
    return this.express;
  }

  override registerRoute(method: HttpMethod, path: string, handler: HttpRouteHandler): void {
    super.registerRoute(method, path, handler);
    this.use(
      (
        error: unknown,
        _req: IncomingMessage,
        res: ServerResponse,
        next: (error?: unknown) => void,
      ) => {
        if (res.headersSent) {
          next(new Error("Teams HTTP 応答エラー"));
          return;
        }
        const status =
          error !== null && typeof error === "object" && "status" in error && error.status === 413
            ? 413
            : 400;
        res.statusCode = status;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("invalid request");
      },
    );
  }
}

export function teamsTrust(config: TeamsConfig): TeamsTrust {
  return {
    appId: config.TEAMS_APP_ID,
    tenantId: config.TEAMS_TENANT_ID,
    allowedTeamIds: new Set(config.TEAMS_ALLOWED_TEAM_IDS),
  };
}

export function createTeamsSdk(config: TeamsConfig, adapter?: ExpressAdapter): App {
  return new App({
    clientId: config.TEAMS_APP_ID,
    clientSecret: config.TEAMS_APP_SECRET,
    tenantId: config.TEAMS_TENANT_ID,
    dangerouslyAllowUnauthenticatedRequests: false,
    logger: safeLogger,
    httpServerAdapter: adapter,
    activity: { mentions: { stripText: false } },
    telemetry: { agent365: false },
    client: {
      logger: safeLogger,
      timeout: 30000,
      middlewares: [
        {
          async invoke(context, next) {
            context.config.maxRedirects = 0;
            return next();
          },
        },
      ],
    },
  });
}

export function createTeamsApp(
  config: TeamsConfig,
  deps: { enqueue: TaskEnqueuer; now?: () => Date; work?: { store: TeamsWorkStore } },
): { app: App; handle: RequestListener } {
  const server = createServer();
  const adapter = new TeamsHttpAdapter(server, { logger: safeLogger });
  const app = createTeamsSdk(config, adapter);
  adapter.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });
  const trust = teamsTrust(config);
  app.on("message", async ({ activity }) => {
    await dispatchTeamsMessage(activity, {
      ...trust,
      enqueue: deps.enqueue,
      now: deps.now ?? (() => new Date()),
    });
  });
  if (deps.work && config.TEAMS_TODO_ENABLED) {
    const store = deps.work.store;
    // 汎用経路を使う。SDKのcard.action.<name>はdata.actionを必要とするため使わない。
    app.on("card.action", async ({ activity }) =>
      dispatchTeamsAction(activity, {
        ...trust,
        store,
        enqueue: deps.enqueue,
        now: deps.now ?? (() => new Date()),
      }),
    );
  }
  if (deps.work) {
    const store = deps.work.store;
    app.on("install.remove", async ({ activity }) => {
      const data = activity.channelData;
      const tenant = data?.tenant?.id;
      const team = data?.team?.aadGroupId ?? data?.team?.id;
      if (
        !tenant ||
        !team ||
        tenant.toLowerCase() !== trust.tenantId.toLowerCase() ||
        !trust.allowedTeamIds.has(team.toLowerCase())
      )
        return;
      for (const settings of await store.listSettings()) {
        if (
          settings.scope.tenantId === tenant.toLowerCase() &&
          settings.scope.teamId === team.toLowerCase()
        )
          await store.disableThread({ scope: settings.scope, now: deps.now?.() ?? new Date() });
      }
    });
  }
  return {
    app,
    handle: adapter.handle,
  };
}

function statusOf(error: unknown): number {
  if (error !== null && typeof error === "object") {
    const status = (error as { response?: { status?: unknown } }).response?.status;
    if (typeof status === "number") return status;
  }
  return 0;
}

function retryAfterOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const headers = (
    error as {
      response?: { headers?: Record<string, unknown> & { get?: (name: string) => unknown } };
    }
  ).response?.headers;
  return parseTeamsRetryAfter(
    typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"],
  );
}

/** serviceUrl は認証した受信データからのみ使い、worker 側でも許可範囲を検証する。 */
export function createTeamsReply(app: App, trust: TeamsTrust): TeamsReply {
  return async (payload, text) => {
    if (!validateTeamsPayload(payload, trust)) throw new TypeError("不正な Teams 返信先です");
    try {
      const api = app.api.fromServiceUrl({ serviceUrl: payload.serviceUrl });
      const sent = await api.conversations.createActivity(
        `${payload.channelId};messageid=${payload.rootMessageId}`,
        {
          type: "message",
          text,
          textFormat: "markdown",
          channelData: { tenant: { id: payload.tenantId } },
        },
      );
      return sent.id;
    } catch (error) {
      // SDK の例外から token / body / URL を上位へ漏らさない。
      throw new TeamsApiError(statusOf(error));
    }
  };
}

/** 通常返信のvoid互換は維持し、管理投稿だけは作成IDを必須にする。 */
export function createTeamsRecordWriter(app: App, trust: TeamsTrust): TeamsRecordWriter {
  const prepare = (
    scope: Parameters<TeamsRecordWriter["create"]>[0],
    reference: Parameters<TeamsRecordWriter["create"]>[1],
    message: Parameters<TeamsRecordWriter["create"]>[2],
  ) => {
    if (
      scope.tenantId.toLowerCase() !== trust.tenantId.toLowerCase() ||
      ![...trust.allowedTeamIds].some((id) => id.toLowerCase() === scope.teamId.toLowerCase()) ||
      !isTrustedTeamsServiceUrl(reference.serviceUrl) ||
      (reference.conversationId !== scope.channelId &&
        reference.conversationId !== `${scope.channelId};messageid=${scope.rootMessageId}`)
    )
      throw new TeamsWorkError("invalid_scope");
    validateTeamsRecordMessage(message);
    return {
      type: "message" as const,
      text: message.text,
      textFormat: "markdown" as const,
      channelData: { tenant: { id: scope.tenantId } },
      ...(message.card
        ? {
            attachments: [
              { contentType: "application/vnd.microsoft.card.adaptive", content: message.card },
            ],
          }
        : {}),
    };
  };
  return {
    async create(scope, reference, message) {
      const body = prepare(scope, reference, message);
      try {
        const sent = await app.api
          .fromServiceUrl({ serviceUrl: reference.serviceUrl })
          .conversations.createActivity(
            `${scope.channelId};messageid=${scope.rootMessageId}`,
            body,
          );
        if (!sent.id?.trim()) throw new TeamsWorkError("delivery_unknown");
        return { activityId: sent.id };
      } catch (error) {
        if (error instanceof TeamsWorkError) throw error;
        throw new TeamsApiError(statusOf(error), retryAfterOf(error));
      }
    },
    async update(scope, reference, activityId, message) {
      const body = prepare(scope, reference, message);
      if (!activityId.trim()) throw new TeamsWorkError("invalid_evidence");
      try {
        await app.api
          .fromServiceUrl({ serviceUrl: reference.serviceUrl })
          .conversations.updateActivity(
            `${scope.channelId};messageid=${scope.rootMessageId}`,
            activityId,
            body,
          );
      } catch (error) {
        throw new TeamsApiError(statusOf(error), retryAfterOf(error));
      }
    },
  };
}

/** 通常履歴とは別の固定GET。ユーザー投稿・Webhook・不明なidentityを拒否する。 */
export function createTeamsRecordVerifier(
  options: TeamsTrust & { token: () => Promise<string>; fetch?: typeof fetch },
): (scope: TeamsScope, activityId: string) => Promise<{ scope: TeamsScope; botOwned: boolean }> {
  return async (scope, activityId) => {
    if (
      scope.tenantId.toLowerCase() !== options.tenantId.toLowerCase() ||
      ![...options.allowedTeamIds].some((id) => id.toLowerCase() === scope.teamId.toLowerCase()) ||
      !activityId.trim()
    )
      throw new TeamsWorkError("invalid_scope");
    const segment = (value: string) => {
      if (!value.trim() || value === "." || value === "..")
        throw new TeamsWorkError("invalid_scope");
      return encodeURIComponent(value);
    };
    const url = `https://graph.microsoft.com/v1.0/teams/${segment(scope.teamId)}/channels/${segment(scope.channelId)}/messages/${segment(scope.rootMessageId)}/replies/${segment(activityId)}`;
    let message: {
      id?: string;
      replyToId?: string;
      deletedDateTime?: string | null;
      channelIdentity?: { teamId?: string; channelId?: string };
      from?: { user?: unknown; application?: { id?: string; applicationIdentityType?: string } };
    };
    try {
      const response = await (options.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${await options.token()}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new TeamsApiError(response.status);
      message = (await response.json()) as typeof message;
    } catch (error) {
      if (error instanceof TeamsApiError) throw error;
      throw new TeamsApiError(0);
    }
    if (
      !message ||
      message.id !== activityId ||
      message.replyToId !== scope.rootMessageId ||
      message.channelIdentity?.teamId?.toLowerCase() !== scope.teamId.toLowerCase() ||
      message.channelIdentity?.channelId !== scope.channelId ||
      message.deletedDateTime
    )
      throw new TeamsWorkError("invalid_scope");
    const application = message.from?.application;
    if (
      message.from?.user ||
      application?.id?.toLowerCase() !== options.appId.toLowerCase() ||
      !["bot", "tenantBot"].includes(application?.applicationIdentityType ?? "")
    )
      throw new TeamsWorkError("unauthorized");
    return { scope, botOwned: true };
  };
}

export function createTeamsWorker(options: {
  config: TeamsConfig;
  store: Store;
  llm: LlmProvider;
  now?: () => Date;
  graph?: TeamsGraphReader;
  reply?: TeamsReply;
  maxRetryCount?: number;
  work?: {
    store: TeamsWorkStore;
    writer?: TeamsRecordWriter;
    sharepointClient?: TeamsSharePointClient;
    verifyActivity?: ReturnType<typeof createTeamsRecordVerifier>;
  };
}): Worker {
  const trust = teamsTrust(options.config);
  const app = createTeamsSdk(options.config);
  const reply = options.reply ?? createTeamsReply(app, trust);
  const now = options.now ?? (() => new Date());
  const token = async () => {
    try {
      const result = await app.tokenProvider.getAppToken(
        "https://graph.microsoft.com/.default",
        trust.tenantId,
      );
      if (!result) throw new TeamsApiError(401);
      return result.toString();
    } catch (error) {
      if (error instanceof TeamsApiError) throw error;
      throw new TeamsApiError(0);
    }
  };
  const graph =
    options.graph ??
    createTeamsGraphReader({
      tenantId: trust.tenantId,
      token,
    });
  const worker = createWorker({
    store: options.store,
    llm: options.llm,
    now,
    maxRetryCount: options.maxRetryCount,
    redactErrors: true,
    notifyRequester: async (payload, text) => {
      if (validateTeamsPayload(payload, trust)) await reply(payload, text);
    },
  });
  const enabled =
    options.config.TEAMS_TODO_ENABLED ||
    options.config.TEAMS_REMINDERS_ENABLED ||
    options.config.TEAMS_RECORD_MODE !== "off";
  const work = enabled ? options.work : undefined;
  const rawWriter = work?.writer ?? createTeamsRecordWriter(app, trust);
  const canSend = async (scope: TeamsScope) => {
    if (
      scope.tenantId.toLowerCase() !== trust.tenantId.toLowerCase() ||
      !trust.allowedTeamIds.has(scope.teamId.toLowerCase())
    )
      return false;
    const settings = await work?.store.getSettings(scope);
    return !!settings && !settings.disabled && settings.expireAt > now();
  };
  const writer: TeamsRecordWriter = {
    async create(scope, reference, message) {
      if (!(await canSend(scope))) throw new TeamsWorkError("disabled");
      return rawWriter.create(scope, reference, message);
    },
    async update(scope, reference, activityId, message) {
      if (!(await canSend(scope))) throw new TeamsWorkError("disabled");
      return rawWriter.update(scope, reference, activityId, message);
    },
  };
  const sharepointDeps = (scope: TeamsScope) => {
    const bindings = options.config.TEAMS_SHAREPOINT_BINDINGS;
    const binding = bindings.find(
      (value) =>
        value.tenantId === scope.tenantId.toLowerCase() &&
        value.teamId === scope.teamId.toLowerCase() &&
        value.channelId === scope.channelId,
    );
    if (!binding || !work) throw new TeamsWorkError("external_not_verified");
    return {
      store: work.store,
      bindings,
      now,
      client:
        work.sharepointClient ??
        createTeamsSharePointClient({ siteId: binding.siteId, listId: binding.listId, token }),
    };
  };
  const sync = async (input: {
    scope: TeamsScope;
    explicitRefresh?: boolean;
    repair?: boolean;
  }) => {
    const result: { teams: string; sharepoint: string; retry?: unknown } = {
      teams: "off",
      sharepoint: "off",
    };
    if (!work || options.config.TEAMS_RECORD_MODE === "off" || !(await canSend(input.scope)))
      return result;
    const record = await work.store.getRecord(input.scope);
    if (!record) return result;
    const attempt = async (kind: "teams" | "sharepoint", fn: () => Promise<{ state: string }>) => {
      try {
        result[kind] = (await fn()).state;
      } catch (error) {
        result[kind] = error instanceof TeamsWorkError ? error.code : "pending";
        if (
          !(error instanceof TeamsWorkError) &&
          (!(error instanceof TeamsApiError) || error.retryable)
        )
          result.retry ??= error;
        if (kind === "teams" && error instanceof TeamsApiError && error.status === 404)
          await work.store.disableThread({ scope: input.scope, now: now() });
      }
    };
    // sharepointモードでも元スレッドの管理投稿は維持し、各副作用を独立して修復する。
    await attempt("teams", () =>
      syncTeamsRecord(
        { ...input, revision: record.desiredRevision },
        { store: work.store, writer, now },
      ),
    );
    if (options.config.TEAMS_RECORD_MODE === "sharepoint" && (await canSend(input.scope)))
      await attempt("sharepoint", () =>
        syncTeamsSharePoint(
          { scope: input.scope, revision: record.desiredRevision },
          sharepointDeps(input.scope),
        ),
      );
    return result;
  };
  const command = async (payload: TeamsJobPayload): Promise<string[] | null> => {
    const text = payload.requestText.normalize("NFKC").trim();
    if (!/^record(?:\s|$)/i.test(text)) return null;
    try {
      if (!work || options.config.TEAMS_RECORD_MODE === "off") throw new TeamsWorkError("disabled");
      const scope: TeamsScope = {
        tenantId: payload.tenantId.toLowerCase(),
        teamId: payload.teamId.toLowerCase(),
        channelId: payload.channelId,
        rootMessageId: payload.rootMessageId,
      };
      const settings = await work.store.getSettings(scope);
      if (!settings || settings.managerAadId !== payload.userId.toLowerCase())
        throw new TeamsWorkError("unauthorized");
      if (!(await canSend(scope))) throw new TeamsWorkError("disabled");
      const record = await work.store.getRecord(scope);
      if (!record) throw new TeamsWorkError("not_found");
      if (/^record status$/i.test(text))
        return splitTeamsLines([
          `記録状態: revision=${record.desiredRevision} / Teams=${record.progress.teams ?? "pending"} / SharePoint=${record.sharepoint?.state ?? "off"}`,
          ...record.slots.map(
            (slot) =>
              `slot=${slot.slot} state=${slot.state} activityId=${slot.activityId ?? "なし"}`,
          ),
        ]);
      const relink = /^record relink ([1-9]\d*) (0|[1-9]\d*) ([A-Za-z0-9:_-]{1,512})$/i.exec(text);
      const recreate = /^record recreate ([1-9]\d*) (0|[1-9]\d*) acknowledge-duplicate$/i.exec(
        text,
      );
      const resync = /^record resync ([1-9]\d*) acknowledge-generated-overwrite$/i.exec(text);
      const match = relink ?? recreate ?? resync;
      if (!match) throw new TeamsWorkError("invalid_evidence");
      const revision = Number(match[1]);
      if (!Number.isSafeInteger(revision) || revision !== record.desiredRevision)
        throw new TeamsWorkError("stale_revision");
      if (resync) {
        if (options.config.TEAMS_RECORD_MODE !== "sharepoint") throw new TeamsWorkError("disabled");
        const result = await resyncTeamsSharePoint(
          { scope, revision, actorAadId: payload.userId, acknowledgeGeneratedOverwrite: true },
          sharepointDeps(scope),
        );
        return [`SharePoint=${result.state} / revision=${result.revision}`];
      }
      const slot = Number(match[2]);
      if (!Number.isSafeInteger(slot)) throw new TeamsWorkError("invalid_evidence");
      const savedSlot = record.slots.find((value) => value.slot === slot);
      if (!savedSlot || !["creating", "delivery_unknown", "deleted"].includes(savedSlot.state))
        throw new TeamsWorkError("conflict");
      await recoverTeamsRecord(
        {
          scope,
          revision,
          actorAadId: payload.userId,
          slot,
          mode: relink ? "relink" : "recreate",
          ...(relink ? { activityId: relink[3] } : { acknowledgeDuplicate: true }),
        },
        {
          store: work.store,
          writer,
          now,
          verifyActivity: work.verifyActivity ?? createTeamsRecordVerifier({ ...trust, token }),
        },
      );
      const result = await sync({ scope });
      return [
        `記録復旧: revision=${revision} / Teams=${result.teams} / SharePoint=${result.sharepoint}`,
      ];
    } catch (error) {
      return [
        `記録操作: ${error instanceof TeamsWorkError ? error.code : "pending"}。record status で状態を確認してください。`,
      ];
    }
  };
  worker.registerJob<TeamsJobPayload>(
    TEAMS_JOB_PATH,
    createTeamsJob({
      graph,
      reply,
      trust,
      ...(work
        ? {
            work: {
              store: work.store,
              writer: options.config.TEAMS_TODO_ENABLED ? writer : undefined,
              now,
              todoEnabled: options.config.TEAMS_TODO_ENABLED,
              recordEnabled: options.config.TEAMS_RECORD_MODE !== "off",
              sync,
              command,
            },
          }
        : {}),
    }),
    {
      validate: (payload) => validateTeamsPayload(payload, trust),
      lockKey: (payload) => teamsTargetId(payload as unknown as TeamsJobPayload),
    },
  );
  if (work) {
    const store = work.store;
    const cronOptions = {
      dedupe: false,
      honorTaskRetryCount: false,
      lockKey: () => null,
      validate: (payload: Record<string, unknown>) =>
        payload.platform === "teams" && Object.keys(payload).length === 1,
    };
    worker.registerJob(
      "/cron/teams-reminders",
      createTeamsRemindersJob({
        store,
        writer,
        now,
        canSend: async (scope) =>
          options.config.TEAMS_TODO_ENABLED &&
          options.config.TEAMS_REMINDERS_ENABLED &&
          (await canSend(scope)),
      }),
      cronOptions,
    );
    worker.registerJob(
      "/cron/teams-repair",
      async () => {
        let failure: unknown;
        for (const record of await store.listRecords()) {
          try {
            const result = await sync({ scope: record.scope, repair: true });
            failure ??= result.retry;
          } catch (error) {
            if (!(error instanceof TeamsWorkError)) failure ??= error;
          }
        }
        if (failure) throw failure;
      },
      cronOptions,
    );
    if (options.config.TEAMS_TODO_ENABLED) {
      worker.registerJob<TeamsActionPayload>(
        TEAMS_ACTION_PATH,
        async (payload) => {
          try {
            await executeTeamsAction(payload, {
              ...trust,
              store,
              graph,
              now,
              recordPolicy: options.config.TEAMS_RECORD_MODE === "off" ? "none" : "existing_only",
            });
          } catch (error) {
            // Invoke完了後の業務拒否は追加公開せず終了する。通信障害だけ再試行する。
            if (!(error instanceof TeamsWorkError)) throw error;
            return;
          }
          const result = await sync({ scope: payload.scope });
          if (result.retry) throw result.retry;
        },
        {
          validate: (payload) => validateTeamsActionPayload(payload, trust),
          // 同時操作は専用storeのtransactionで直列化する。
          lockKey: () => null,
        },
      );
    }
  }
  return worker;
}
