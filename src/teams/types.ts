import type { SlackMessage } from "../slack/conversation.js";

export type TeamsJobPayload = {
  platform: "teams";
  taskName: string;
  tenantId: string;
  teamId: string;
  channelId: string;
  conversationId: string;
  rootMessageId: string;
  mentionId: string;
  userId: string;
  serviceUrl: string;
  requestText: string;
  requestedAt: string;
};

/** 分析用の時刻や短いIDに依存しない、元投稿の識別子。 */
export type MessageRef = {
  tenantId: string;
  teamId: string;
  channelId: string;
  rootMessageId: string;
  kind: "root" | "reply";
  messageId: string;
};

export type TeamsConversation = {
  messages: SlackMessage[];
  names: Map<string, string>;
  links: Map<string, string>;
  sourceIds: Map<string, string>;
  sourceRefs: Map<string, MessageRef>;
};

export interface TeamsGraphReader {
  getThread(teamId: string, channelId: string, rootId: string): Promise<TeamsConversation>;
  getChannel(teamId: string, channelId: string, start: Date, end: Date): Promise<TeamsConversation>;
}
