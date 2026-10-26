/** SDK 認証済みのカード操作。カードは秘密参照だけを持ち、操作対象は保存値から解決する。 */
import { createHash, randomBytes } from "node:crypto";
import type { AdaptiveCardActionMessageResponse } from "@microsoft/teams.api";
import { z } from "zod";
import type { TaskEnqueuer } from "../tasks/enqueue.js";
import { isTrustedTeamsServiceUrl, type TeamsTrust } from "./ingress.js";
import type {
  TeamsActionRef,
  TeamsActionRefInput,
  TeamsScope,
  TeamsTodoCandidate,
  TeamsWorkStore,
} from "./store/types.js";
import { matchTeamsTodos, TeamsWorkError } from "./todo-identity.js";
import type { TeamsGraphReader } from "./types.js";

export const TEAMS_ACTION_PATH = "/jobs/teams-action";
export type TeamsActionResponse = AdaptiveCardActionMessageResponse;
export type TeamsActionPayload = {
  platform: "teams";
  taskName: string;
  tokenHash: string;
  scope: TeamsScope;
  actorAadId: string;
  sourceActivityId: string;
  requestedAt: string;
};
type CommonDeps = TeamsTrust & { store: TeamsWorkStore; now: () => Date };
export type TeamsActionIngressDeps = CommonDeps & { enqueue: TaskEnqueuer };
export type TeamsActionWorkerDeps = CommonDeps & {
  graph: TeamsGraphReader;
  recordPolicy?: "none" | "existing_only";
};

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const nonempty = z.string().min(1).max(512);
const scopeSchema = z
  .object({
    tenantId: uuid,
    teamId: uuid,
    channelId: z.string().regex(/^19:[A-Za-z0-9._-]+@thread\.(?:tacv2|skype)$/),
    rootMessageId: nonempty,
  })
  .strict();
const payloadSchema = z
  .object({
    platform: z.literal("teams"),
    taskName: z.string().regex(/^teams-action-[a-f0-9]{64}$/),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: scopeSchema,
    actorAadId: uuid,
    sourceActivityId: nonempty,
    requestedAt: z.iso.datetime(),
  })
  .strict();
const activitySchema = z.object({
  type: z.literal("invoke"),
  name: z.literal("adaptiveCard/action"),
  id: nonempty,
  channelId: z.literal("msteams"),
  serviceUrl: z.string().refine(isTrustedTeamsServiceUrl),
  from: z.object({ id: nonempty, aadObjectId: uuid }),
  recipient: z.object({ id: nonempty }),
  conversation: z.object({ id: nonempty, conversationType: z.literal("channel") }),
  replyToId: nonempty,
  channelData: z.object({
    tenant: z.object({ id: uuid }),
    team: z.object({ aadGroupId: uuid }),
    channel: z.object({ id: nonempty }),
  }),
  value: z.object({
    action: z.object({
      type: z.literal("Action.Execute"),
      data: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
    }),
  }),
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sameScope = (a: TeamsScope, b: TeamsScope) =>
  a.tenantId.toLowerCase() === b.tenantId.toLowerCase() &&
  a.teamId.toLowerCase() === b.teamId.toLowerCase() &&
  a.channelId === b.channelId &&
  a.rootMessageId === b.rootMessageId;
function trusted(scope: TeamsScope, trust: TeamsTrust): boolean {
  return (
    scope.tenantId.toLowerCase() === trust.tenantId.toLowerCase() &&
    [...trust.allowedTeamIds].some((id) => id.toLowerCase() === scope.teamId.toLowerCase())
  );
}
export function validateTeamsActionPayload(
  value: unknown,
  trust: TeamsTrust,
): value is TeamsActionPayload {
  const result = payloadSchema.safeParse(value);
  return result.success && trusted(result.data.scope, trust);
}

/** raw token は返却先カードだけが保持し、永続化・キュー投入は hash に限定する。 */
export async function issueTeamsAction(
  input: Omit<TeamsActionRefInput, "tokenHash">,
  deps: { store: TeamsWorkStore },
): Promise<{ token: string }> {
  const token = randomBytes(32).toString("base64url");
  await deps.store.putActionRef({ ...input, tokenHash: digest(token) });
  return { token };
}

/** 受付と worker に共通の現在状態の検査。業務変更時の原子的再検査は store も行う。 */
async function check(
  payload: TeamsActionPayload,
  deps: CommonDeps,
  now: Date,
): Promise<TeamsActionRef> {
  if (!validateTeamsActionPayload(payload, deps)) throw new TeamsWorkError("invalid_scope");
  const ref = await deps.store.getActionRef(payload.tokenHash);
  if (!ref) throw new TeamsWorkError("expired");
  if (!sameScope(payload.scope, ref.scope) || payload.sourceActivityId !== ref.sourceActivityId)
    throw new TeamsWorkError("invalid_scope");
  if (now >= ref.expireAt || now.getTime() >= Date.parse(ref.createdAt) + 7 * 86_400_000)
    throw new TeamsWorkError("expired");
  const settings = await deps.store.getSettings(payload.scope);
  if (!settings) throw new TeamsWorkError("not_found");
  if (now >= settings.expireAt) throw new TeamsWorkError("expired");
  if (settings.disabled) throw new TeamsWorkError("disabled");
  const actor = payload.actorAadId.toLowerCase();
  if (ref.allowedActorAadIds.length > 0 && !ref.allowedActorAadIds.includes(actor))
    throw new TeamsWorkError("unauthorized");
  if (ref.action.startsWith("notifications_")) {
    if (settings.managerAadId !== actor) throw new TeamsWorkError("unauthorized");
  } else if (["link", "confirm_update", "done"].includes(ref.action)) {
    const todo = (await deps.store.getTodos(payload.scope)).find(
      (value) => value.todoId === ref.todoId,
    );
    if (!todo) throw new TeamsWorkError("not_found");
    if (now >= todo.expireAt) throw new TeamsWorkError("expired");
    if (todo.assigneeAadId !== actor && todo.createdByAadId !== actor)
      throw new TeamsWorkError("unauthorized");
    if (
      !(ref.action === "done" && todo.status === "done") &&
      todo.revision !== ref.expectedRevision
    )
      throw new TeamsWorkError("stale_revision");
  }
  if (ref.candidate)
    matchTeamsTodos({ scope: payload.scope, candidates: [ref.candidate], existing: [] });
  else if (["register", "link", "confirm_update"].includes(ref.action))
    throw new TeamsWorkError("invalid_evidence");
  return ref;
}

function response(value: string): TeamsActionResponse {
  return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value };
}
export async function dispatchTeamsAction(
  value: unknown,
  deps: TeamsActionIngressDeps,
): Promise<TeamsActionResponse> {
  try {
    const parsed = activitySchema.safeParse(value);
    if (!parsed.success) throw new TeamsWorkError("invalid_scope");
    const a = parsed.data;
    if (
      a.recipient.id.replace(/^28:/, "").toLowerCase() !== deps.appId.toLowerCase() ||
      a.from.id.replace(/^28:/, "").toLowerCase() === deps.appId.toLowerCase()
    )
      throw new TeamsWorkError("unauthorized");
    // replyToId は元カード。root は認証された会話IDからだけ導出する。
    const prefix = `${a.channelData.channel.id};messageid=`;
    if (!a.conversation.id.startsWith(prefix)) throw new TeamsWorkError("invalid_scope");
    const scope = scopeSchema.parse({
      tenantId: a.channelData.tenant.id,
      teamId: a.channelData.team.aadGroupId,
      channelId: a.channelData.channel.id,
      rootMessageId: a.conversation.id.slice(prefix.length),
    });
    const now = deps.now();
    const payload: TeamsActionPayload = {
      platform: "teams",
      taskName: `teams-action-${digest(JSON.stringify([scope, a.id]))}`,
      tokenHash: digest(a.value.action.data.token),
      scope,
      actorAadId: a.from.aadObjectId,
      sourceActivityId: a.replyToId,
      requestedAt: now.toISOString(),
    };
    await check(payload, deps, now);
    try {
      await deps.enqueue({ name: payload.taskName, path: TEAMS_ACTION_PATH, payload });
    } catch {
      throw new TeamsWorkError("enqueue_failed");
    }
    return response("操作を受け付けました。");
  } catch (error) {
    if (error instanceof TeamsWorkError && error.code === "enqueue_failed")
      return response("受付に失敗しました。再操作してください。");
    if (error instanceof TeamsWorkError && ["expired", "stale_revision"].includes(error.code))
      return response("一覧を再取得して操作してください。");
    return response("この操作は実行できません。一覧を再取得してください。");
  }
}

function sameRef(
  a: TeamsTodoCandidate["evidence"][number]["ref"],
  b: TeamsTodoCandidate["evidence"][number]["ref"],
): boolean {
  return sameScope(a, b) && a.kind === b.kind && a.messageId === b.messageId;
}
/** 保存snapshotの根拠は編集・削除や取得参加者の変更を考慮して再取得する。 */
async function verifyCandidate(
  scope: TeamsScope,
  candidate: TeamsTodoCandidate,
  graph: TeamsGraphReader,
): Promise<void> {
  const current = await graph.getThread(scope.teamId, scope.channelId, scope.rootMessageId);
  const normalize = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");
  for (const evidence of candidate.evidence) {
    const entry = [...current.sourceRefs].find(([, ref]) => sameRef(ref, evidence.ref));
    const message = entry && current.messages.find((value) => value.ts === entry[0]);
    // Graph adapterのtsは元ミリ秒+衝突回避用の下3桁。下3桁を日時へ混ぜない。
    const timestamp = message && /^(\d+)\.(\d{6})$/.exec(message.ts);
    const createdAt = timestamp
      ? Number(timestamp[1]) * 1000 + Number(timestamp[2]?.slice(0, 3))
      : Number.NaN;
    if (
      !message ||
      Date.parse(evidence.sourceCreatedAt) !== createdAt ||
      !normalize(evidence.quote) ||
      !normalize(message.text).includes(normalize(evidence.quote)) ||
      current.links.get(message.ts) !== evidence.link
    )
      throw new TeamsWorkError("invalid_evidence");
  }
  if (
    candidate.assigneeAadId !== null &&
    !current.messages.some(
      (message) => message.userId?.toLowerCase() === candidate.assigneeAadId?.toLowerCase(),
    )
  )
    throw new TeamsWorkError("invalid_evidence");
}

export async function executeTeamsAction(
  payload: TeamsActionPayload,
  deps: TeamsActionWorkerDeps,
): Promise<{ changed: boolean }> {
  const ref = await check(payload, deps, deps.now());
  if (ref.candidate) await verifyCandidate(payload.scope, ref.candidate, deps.graph);
  // Graph取得中の期限・権限・revisionの変更も適用直前に再検査する。
  const now = deps.now();
  await check(payload, deps, now);
  const common = {
    scope: payload.scope,
    actorAadId: payload.actorAadId.toLowerCase(),
    now,
    recordPolicy: deps.recordPolicy ?? ("existing_only" as const),
  };
  if (ref.action === "register" || ref.action === "link") {
    if (!ref.candidate) throw new TeamsWorkError("invalid_evidence");
    const result = await deps.store.register({
      ...common,
      requestId: `teams-action-${digest(JSON.stringify([payload.scope, payload.tokenHash]))}`,
      candidate: ref.candidate,
      mode: ref.action === "link" ? "link" : "new",
      ...(ref.todoId ? { todoId: ref.todoId } : {}),
      ...(ref.expectedRevision !== null ? { expectedRevision: ref.expectedRevision } : {}),
      explicitNew: ref.explicitNew,
    });
    return { changed: result.changed };
  }
  if (ref.action === "done" || ref.action === "confirm_update") {
    if (!ref.todoId || ref.expectedRevision === null) throw new TeamsWorkError("invalid_evidence");
    const input = { ...common, todoId: ref.todoId, expectedRevision: ref.expectedRevision };
    if (ref.action === "done") return { changed: (await deps.store.markDone(input)).changed };
    if (!ref.candidate) throw new TeamsWorkError("invalid_evidence");
    return {
      changed: (await deps.store.confirmUpdate({ ...input, candidate: ref.candidate })).changed,
    };
  }
  const enabled = ref.action === "notifications_on";
  const previous = await deps.store.getSettings(payload.scope);
  await deps.store.setNotifications({ ...common, enabled });
  return { changed: previous?.notificationsEnabled !== enabled };
}
