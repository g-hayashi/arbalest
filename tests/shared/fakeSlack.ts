/**
 * ジョブのテスト用の Slack のフェイク（外部に接続しない）。`WebClient` のうち、まとめのジョブが使う部分だけ。
 * - conversations.replies: スレッドの全メッセージ（親と返信）を返す。
 * - conversations.history: チャネルの最上位のメッセージを返す（`oldest` より新しいもの）。
 * - users.info / auth.test / chat.postMessage。
 */
import type { WebClient } from "@slack/web-api";
import type { RawSlackMessage } from "../../src/slack/conversation.js";
import { compareTs } from "../../src/slack/conversation.js";
import type { FakeCanvas } from "./fakeCanvas.js";

export const WORKSPACE_URL = "https://example.slack.com";
export const BOT_USER_ID = "U0ARBALEST";

export type PostedMessage = {
  channel: string;
  thread_ts?: string;
  text: string;
  blocks?: unknown[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

export type UpdatedMessage = { channel: string; ts: string; text: string; blocks?: unknown[] };
export type EphemeralMessage = { channel: string; user: string; text: string };

export type FakeSlackOptions = {
  /** `users.info` が `deleted: true` を返すユーザー。 */
  deleted?: ReadonlySet<string>;
  /** canvas の API（conversations.info / conversations.canvases / canvases / files.info）を混ぜる。 */
  canvas?: FakeCanvas;
};

export type FakeSlack = {
  client: WebClient;
  /** 投稿されたメッセージ。 */
  posts: PostedMessage[];
  /** `chat.update` の呼び出し。 */
  updates: UpdatedMessage[];
  /** `chat.postEphemeral` の呼び出し。 */
  ephemerals: EphemeralMessage[];
  /** n 番目（0 始まり）の投稿の ts。 */
  tsOfPost(index: number): string;
  /** conversations.history に渡された引数。 */
  historyCalls: { channel: string; oldest?: string; latest?: string; inclusive?: boolean }[];
  /** スレッドのメッセージを置き換える。 */
  setThread(threadTs: string, messages: RawSlackMessage[]): void;
  /** チャネルの最上位のメッセージを置き換える。 */
  setHistory(messages: RawSlackMessage[]): void;
  /** 投稿された本文（blocks の本文も含む）をつないだもの。 */
  allText(): string;
  /** 投稿された actions ブロックのボタン（URL ボタンを含む）。postIndex は posts の添字。 */
  buttons(): { postIndex: number; label: string; url: string; actionId: string }[];
};

export function createFakeSlack(
  names: ReadonlyMap<string, string>,
  options: FakeSlackOptions = {},
): FakeSlack {
  const threads = new Map<string, RawSlackMessage[]>();
  let history: RawSlackMessage[] = [];
  const posts: PostedMessage[] = [];
  const updates: UpdatedMessage[] = [];
  const ephemerals: EphemeralMessage[] = [];
  const tsOfPost = (index: number): string => `${1792800000 + index + 1}.000000`;
  const historyCalls: FakeSlack["historyCalls"] = [];

  const client = {
    auth: { test: async () => ({ ok: true, user_id: BOT_USER_ID, url: `${WORKSPACE_URL}/` }) },
    users: {
      info: async ({ user }: { user: string }) => ({
        ok: true,
        user: {
          id: user,
          deleted: options.deleted?.has(user) ?? false,
          profile: { display_name: names.get(user) ?? "" },
        },
      }),
    },
    ...(options.canvas !== undefined
      ? { canvases: options.canvas.api.canvases, files: options.canvas.api.files }
      : {}),
    conversations: {
      ...(options.canvas !== undefined
        ? {
            info: options.canvas.api.conversations.info,
            canvases: options.canvas.api.conversations.canvases,
          }
        : {}),
      replies: async ({ ts }: { ts: string }) => ({
        ok: true,
        messages: structuredClone(threads.get(ts) ?? []),
      }),
      history: async (args: FakeSlack["historyCalls"][number]) => {
        const { oldest, latest, inclusive } = args;
        historyCalls.push(args);
        return {
          ok: true,
          messages: structuredClone(
            history.filter(
              (m) =>
                (oldest === undefined || compareTs(m.ts, oldest) >= (inclusive ? 0 : 1)) &&
                (latest === undefined || compareTs(m.ts, latest) <= (inclusive ? 0 : -1)),
            ),
          ),
        };
      },
    },
    chat: {
      postMessage: async (args: PostedMessage) => {
        posts.push(structuredClone(args));
        return { ok: true, ts: tsOfPost(posts.length - 1) };
      },
      update: async (args: UpdatedMessage) => {
        updates.push(structuredClone(args));
        return { ok: true, ts: args.ts };
      },
      postEphemeral: async (args: EphemeralMessage) => {
        ephemerals.push(structuredClone(args));
        return { ok: true };
      },
    },
  } as unknown as WebClient;

  return {
    client,
    posts,
    updates,
    ephemerals,
    tsOfPost,
    historyCalls,
    setThread: (threadTs, messages) => threads.set(threadTs, messages),
    setHistory: (messages) => {
      history = messages;
    },
    allText: () =>
      posts
        .flatMap((p) => [
          p.text,
          ...(
            (p.blocks ?? []) as Array<{
              text?: { text: string };
              elements?: { text: string | { text: string } }[];
            }>
          ).flatMap((b) => [
            b.text?.text ?? "",
            ...(b.elements ?? []).map((e) => (typeof e.text === "string" ? e.text : e.text.text)),
          ]),
        ])
        .join("\n"),
    buttons: () =>
      posts.flatMap((p, postIndex) =>
        (
          (p.blocks ?? []) as Array<{
            type: string;
            elements?: {
              type: string;
              text?: { text: string };
              url?: string;
              action_id?: string;
            }[];
          }>
        )
          .filter((b) => b.type === "actions")
          .flatMap((b) => b.elements ?? [])
          .map((e) => ({
            postIndex,
            label: e.text?.text ?? "",
            url: e.url ?? "",
            actionId: e.action_id ?? "",
          })),
      ),
  };
}
