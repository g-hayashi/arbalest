/** SDK が JWT を検証した後だけ呼ぶ、Teams の受付と worker の宛先検証。 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { TaskEnqueuer } from "../tasks/enqueue.js";
import { teamsHtmlToText } from "./graph.js";
import type { TeamsJobPayload } from "./types.js";

export const TEAMS_JOB_PATH = "/jobs/teams-request";
const uuid = z.string().uuid();
const messageId = z.string().regex(/^\d{1,32}$/);
const channelId = z.string().regex(/^19:[A-Za-z0-9._-]+@thread\.(?:tacv2|skype)$/);
const requestText = z.string().max(16000);

export type TeamsTrust = {
  appId: string;
  tenantId: string;
  allowedTeamIds: ReadonlySet<string>;
};
export type TeamsIngressDeps = TeamsTrust & { now: () => Date; enqueue: TaskEnqueuer };

/** 商用クラウドの Teams Bot Connector。任意URLへの認証情報付き投稿を防ぐ。 */
export function isTrustedTeamsServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/[A-Za-z0-9/_-]*\/$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

const payloadSchema = z.object({
  platform: z.literal("teams"),
  taskName: z.string().regex(/^teams-[a-f0-9]{64}$/),
  tenantId: uuid,
  teamId: uuid,
  channelId,
  conversationId: z.string().max(512),
  rootMessageId: messageId,
  mentionId: messageId,
  userId: uuid,
  serviceUrl: z.string().refine(isTrustedTeamsServiceUrl),
  requestText,
  requestedAt: z.iso.datetime(),
});

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function botId(id: string): string {
  return id.replace(/^28:/, "");
}
function allowedTeam(team: string, trust: TeamsTrust): boolean {
  return [...trust.allowedTeamIds].some((allowed) => sameId(team, allowed));
}

function conversationMatches(
  p: Pick<TeamsJobPayload, "conversationId" | "channelId" | "rootMessageId">,
): boolean {
  return (
    p.conversationId === p.channelId ||
    p.conversationId === `${p.channelId};messageid=${p.rootMessageId}`
  );
}

export function teamsTaskName(
  p: Pick<TeamsJobPayload, "tenantId" | "teamId" | "channelId" | "rootMessageId" | "mentionId">,
): string {
  return `teams-${createHash("sha256")
    .update(
      JSON.stringify([
        p.tenantId.toLowerCase(),
        p.teamId.toLowerCase(),
        p.channelId,
        p.rootMessageId,
        p.mentionId,
      ]),
    )
    .digest("hex")}`;
}

export function validateTeamsPayload(value: unknown, trust: TeamsTrust): value is TeamsJobPayload {
  const result = payloadSchema.safeParse(value);
  if (!result.success) return false;
  const p = result.data;
  return (
    sameId(p.tenantId, trust.tenantId) &&
    allowedTeam(p.teamId, trust) &&
    conversationMatches(p) &&
    p.taskName === teamsTaskName(p)
  );
}

const activitySchema = z.object({
  type: z.literal("message"),
  id: messageId,
  channelId: z.literal("msteams"),
  serviceUrl: z.string().refine(isTrustedTeamsServiceUrl),
  text: requestText,
  replyToId: messageId.optional(),
  from: z.object({ id: z.string(), aadObjectId: uuid }),
  recipient: z.object({ id: z.string() }),
  conversation: z.object({ id: z.string(), conversationType: z.literal("channel") }),
  channelData: z.object({
    tenant: z.object({ id: uuid }),
    team: z.object({ aadGroupId: uuid }),
    channel: z.object({ id: channelId }),
  }),
  entities: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        mentioned: z.object({ id: z.string() }).optional(),
      }),
    )
    .default([]),
});

export async function dispatchTeamsMessage(value: unknown, deps: TeamsIngressDeps): Promise<void> {
  const parsed = activitySchema.safeParse(value);
  if (!parsed.success) return;
  const a = parsed.data;
  if (!sameId(botId(a.recipient.id), deps.appId) || sameId(botId(a.from.id), deps.appId)) return;
  const mentions = a.entities.filter(
    (e) =>
      e.type === "mention" &&
      e.mentioned !== undefined &&
      sameId(botId(e.mentioned.id), deps.appId),
  );
  if (mentions.length === 0) return;
  let text = a.text;
  for (const mention of mentions) {
    if (mention.text) text = text.replaceAll(mention.text, "");
  }
  const embeddedRoot = /;messageid=(\d+)$/.exec(a.conversation.id)?.[1];
  const rootMessageId = a.replyToId ?? embeddedRoot ?? a.id;
  const identity = {
    tenantId: a.channelData.tenant.id.toLowerCase(),
    teamId: a.channelData.team.aadGroupId.toLowerCase(),
    channelId: a.channelData.channel.id,
    rootMessageId,
    mentionId: a.id,
  };
  const payload: TeamsJobPayload = {
    ...identity,
    platform: "teams",
    taskName: teamsTaskName(identity),
    conversationId: a.conversation.id,
    rootMessageId,
    userId: a.from.aadObjectId,
    serviceUrl: a.serviceUrl,
    requestText: teamsHtmlToText(text).trim(),
    requestedAt: deps.now().toISOString(),
  };
  if (!validateTeamsPayload(payload, deps)) return;
  await deps.enqueue({ name: payload.taskName, path: TEAMS_JOB_PATH, payload });
}
