import { describe, expect, it, vi } from "vitest";
import {
  compareTs,
  fetchChannelMessages,
  fetchThreadMessages,
  type RawSlackMessage,
  type SlackConversationClient,
} from "../../src/slack/conversation.js";
import { createUserResolver, type SlackUsersClient } from "../../src/slack/users.js";

type Page = { messages: RawSlackMessage[]; next?: string };

/** cursor ごとのページを返すフェイク。 */
function fakeClient(opts: { replies?: Record<string, Page[]>; history?: Page[] }) {
  const calls = {
    replies: [] as Record<string, unknown>[],
    history: [] as Record<string, unknown>[],
  };
  const client: SlackConversationClient = {
    conversations: {
      async replies(args) {
        calls.replies.push(args);
        const pages = opts.replies?.[args.ts] ?? [];
        const idx = args.cursor ? Number(args.cursor.replace("c", "")) : 0;
        const page = pages[idx];
        return {
          messages: page?.messages ?? [],
          response_metadata: { next_cursor: page?.next ?? "" },
        };
      },
      async history(args) {
        calls.history.push(args);
        const pages = opts.history ?? [];
        const idx = args.cursor ? Number(args.cursor.replace("c", "")) : 0;
        const page = pages[idx];
        return {
          messages: (page?.messages ?? []).filter(
            (message) =>
              (args.oldest === undefined ||
                compareTs(message.ts, args.oldest) >= (args.inclusive ? 0 : 1)) &&
              (args.latest === undefined ||
                compareTs(message.ts, args.latest) <= (args.inclusive ? 0 : -1)),
          ),
          response_metadata: { next_cursor: page?.next ?? "" },
        };
      },
    },
  };
  return { client, calls };
}

const m = (ts: string, text: string, extra: Partial<RawSlackMessage> = {}): RawSlackMessage => ({
  ts,
  text,
  user: "U1",
  ...extra,
});

describe("fetchThreadMessages", () => {
  it("cursor でページングし、ts の昇順で返す", async () => {
    const { client, calls } = fakeClient({
      replies: {
        "100.000100": [
          { messages: [m("100.000100", "親", { thread_ts: "100.000100" })], next: "c1" },
          { messages: [m("100.000200", "返信 1", { thread_ts: "100.000100" })], next: "c2" },
          { messages: [m("100.000300", "返信 2", { thread_ts: "100.000100" })] },
        ],
      },
    });
    const msgs = await fetchThreadMessages(client, "C1", "100.000100");
    expect(msgs.map((x) => x.text)).toEqual(["親", "返信 1", "返信 2"]);
    expect(calls.replies).toHaveLength(3);
    expect(calls.replies[1]?.cursor).toBe("c1");
  });

  it("ボット、join / leave / channel_* の subtype は除く。thread_broadcast などは残す", async () => {
    const { client } = fakeClient({
      replies: {
        "1.000000": [
          {
            messages: [
              m("1.000000", "親"),
              m("1.000100", "bot", { bot_id: "B1", subtype: "bot_message", user: undefined }),
              m("1.000200", "アプリ", { bot_id: "B2" }),
              m("1.000300", "joined", { subtype: "channel_join" }),
              m("1.000400", "left", { subtype: "channel_leave" }),
              m("1.000500", "topic", { subtype: "channel_topic" }),
              m("1.000600", "x", { subtype: "group_join" }),
              m("1.000700", "ブロードキャスト", { subtype: "thread_broadcast" }),
              m("1.000800", "me too", { subtype: "me_message" }),
            ],
          },
        ],
      },
    });
    const msgs = await fetchThreadMessages(client, "C1", "1.000000");
    expect(msgs.map((x) => x.text)).toEqual(["親", "ブロードキャスト", "me too"]);
  });

  it("botUserId のメッセージも除く", async () => {
    const { client } = fakeClient({
      replies: {
        "1.000000": [{ messages: [m("1.000000", "親"), m("1.000100", "自分", { user: "UBOT" })] }],
      },
    });
    const msgs = await fetchThreadMessages(client, "C1", "1.000000", { botUserId: "UBOT" });
    expect(msgs.map((x) => x.text)).toEqual(["親"]);
  });

  it("編集後の本文（Slack が返す text）を使い、edited と reactions を持つ", async () => {
    const { client } = fakeClient({
      replies: {
        "1.000000": [
          {
            messages: [
              m("1.000000", "編集後の本文", {
                edited: { user: "U1", ts: "1.500000" },
                reactions: [{ name: "+1", count: 3, users: ["U2", "U3", "U4"] }],
              }),
            ],
          },
        ],
      },
    });
    const [msg] = await fetchThreadMessages(client, "C1", "1.000000");
    expect(msg).toEqual({
      ts: "1.000000",
      threadTs: null,
      userId: "U1",
      text: "編集後の本文",
      edited: true,
      reactions: [{ name: "+1", userIds: ["U2", "U3", "U4"] }],
    });
  });

  it("text が無いメッセージは空文字にする", async () => {
    const { client } = fakeClient({
      replies: { "1.000000": [{ messages: [{ ts: "1.000000", user: "U1" }] }] },
    });
    const [msg] = await fetchThreadMessages(client, "C1", "1.000000");
    expect(msg?.text).toBe("");
  });
});

describe("fetchChannelMessages", () => {
  it("期間前の親を全ページから探し、期間内の返信だけを重複なく返す", async () => {
    const { client, calls } = fakeClient({
      history: [
        {
          messages: [
            m("101.000000", "終了後の親", { thread_ts: "101.000000", reply_count: 1 }),
            m("50.000000", "開始の親", { thread_ts: "50.000000", reply_count: 1 }),
            m("20.000000", "更新のない親", {
              thread_ts: "20.000000",
              reply_count: 1,
              ...{ latest_reply: "49.999999" },
            }),
          ],
          next: "c1",
        },
        {
          messages: [m("10.000000", "期間前の親", { thread_ts: "10.000000", reply_count: 4 })],
        },
      ],
      replies: {
        "50.000000": [{ messages: [m("50.000000", "開始の親")] }],
        "10.000000": [
          {
            messages: [
              m("10.000000", "期間前の親"),
              m("49.999999", "開始前の返信", { thread_ts: "10.000000" }),
              m("50.000000", "重複する開始", { thread_ts: "10.000000" }),
              m("75.000000", "期間内の返信", { thread_ts: "10.000000" }),
            ],
            next: "c1",
          },
          {
            messages: [
              m("75.000000", "重複する返信", { thread_ts: "10.000000" }),
              m("100.000000", "終了の返信", { thread_ts: "10.000000" }),
              m("101.000000", "終了後の返信", { thread_ts: "10.000000" }),
            ],
          },
        ],
      },
    });

    const messages = await fetchChannelMessages(client, "C1", {
      oldest: "50.000000",
      latest: "100.000000",
    });

    expect(messages.map((message) => message.text)).toEqual(["開始の親", "期間内の返信"]);
    expect(messages[1]?.threadTs).toBe("10.000000");
    expect(calls.replies.map((call) => call.ts)).toEqual(["50.000000", "10.000000", "10.000000"]);
    expect(calls.history).toHaveLength(4);
  });

  it("期間前の親探索は終了から90日以内に限り、90日前の親の返信も拾う", async () => {
    const day = 86400;
    const earliest = `${10 * day}.000000`;
    const ancient = `${9 * day}.000000`;
    const replyTs = `${99 * day}.000001`;
    const { client, calls } = fakeClient({
      history: [
        {
          messages: [
            m(ancient, "取得範囲より古い親", { thread_ts: ancient, reply_count: 1 }),
            m(earliest, "90日前の親", { thread_ts: earliest, reply_count: 1 }),
          ],
        },
      ],
      replies: {
        [ancient]: [{ messages: [m(replyTs, "古すぎる親の返信")] }],
        [earliest]: [{ messages: [m(replyTs, "取得可能な親の返信", { thread_ts: earliest })] }],
      },
    });

    const messages = await fetchChannelMessages(client, "C1", {
      oldest: `${99 * day}.000000`,
      latest: `${100 * day}.000000`,
    });

    expect(messages.map((message) => message.text)).toEqual(["取得可能な親の返信"]);
    expect(calls.history[1]).toMatchObject({ oldest: earliest, inclusive: true });
    expect(calls.replies.map((call) => call.ts)).toEqual([earliest]);
  });

  it("開始を含み終了を含まない範囲で、全ページの親と返信を絞る", async () => {
    const { client, calls } = fakeClient({
      history: [
        {
          messages: [
            m("49.999999", "開始前"),
            m("50.000000", "開始", { thread_ts: "50.000000", reply_count: 4 }),
            m("100.000000", "終了"),
          ],
        },
      ],
      replies: {
        "50.000000": [
          { messages: [m("49.999999", "範囲外の返信"), m("50.000000", "開始")], next: "c1" },
          {
            messages: [
              m("99.999999", "最後の返信"),
              m("100.000000", "終了の返信"),
              m("101.000000", "終了後"),
            ],
          },
        ],
      },
    });
    const msgs = await fetchChannelMessages(client, "C1", {
      oldest: "50.000000",
      latest: "100.000000",
    });
    expect(msgs.map((x) => x.text)).toEqual(["開始", "最後の返信"]);
    expect(calls.history[0]).toMatchObject({
      oldest: "50.000000",
      latest: "100.000000",
      inclusive: true,
    });
    expect(calls.replies).toHaveLength(2);
  });

  it("oldest を渡し、cursor でページングする。返信のある親は conversations.replies で展開する", async () => {
    const { client, calls } = fakeClient({
      history: [
        {
          // history は新しい順
          messages: [
            m("300.000000", "親 B（返信あり）", { thread_ts: "300.000000", reply_count: 2 }),
            m("200.000000", "単発"),
          ],
          next: "c1",
        },
        { messages: [m("100.000000", "最初")] },
      ],
      replies: {
        "300.000000": [
          {
            messages: [
              m("300.000000", "親 B（返信あり）", { thread_ts: "300.000000", reply_count: 2 }),
              m("310.000000", "返信 1", { thread_ts: "300.000000" }),
              m("320.000000", "返信 2", { thread_ts: "300.000000" }),
            ],
          },
        ],
      },
    });
    const msgs = await fetchChannelMessages(client, "C1", { oldest: "50.000000" });
    expect(calls.history[0]?.oldest).toBe("50.000000");
    expect(calls.history[1]?.cursor).toBe("c1");
    expect(calls.replies).toHaveLength(1);
    expect(msgs.map((x) => x.text)).toEqual([
      "最初",
      "単発",
      "親 B（返信あり）",
      "返信 1",
      "返信 2",
    ]);
    // 返信は threadTs を持つ。親と単発は null。
    expect(msgs.map((x) => x.threadTs)).toEqual([null, null, null, "300.000000", "300.000000"]);
  });

  it("返信のない親（reply_count が 0）は展開しない", async () => {
    const { client, calls } = fakeClient({
      history: [{ messages: [m("1.000000", "単発", { thread_ts: "1.000000", reply_count: 0 })] }],
    });
    await fetchChannelMessages(client, "C1", { oldest: "0" });
    expect(calls.replies).toHaveLength(0);
  });
});

describe("createUserResolver", () => {
  function fakeUsers(): { client: SlackUsersClient; info: ReturnType<typeof vi.fn> } {
    const info = vi.fn(async ({ user }: { user: string }) => {
      if (user === "UGONE")
        throw Object.assign(new Error("user_not_found"), { data: { error: "user_not_found" } });
      return {
        user: {
          id: user,
          name: `name-${user}`,
          real_name: `real-${user}`,
          profile: { display_name: user === "U2" ? "" : `disp-${user}` },
        },
      };
    });
    return { client: { users: { info } }, info };
  }

  it("display_name → real_name → name の順で表示名を選ぶ", async () => {
    const { client } = fakeUsers();
    const r = createUserResolver(client, () => new Date(0));
    expect((await r.getUser("U1")).name).toBe("disp-U1");
    expect((await r.getUser("U2")).name).toBe("real-U2");
  });

  it("1 時間はキャッシュし、過ぎたら取り直す", async () => {
    const { client, info } = fakeUsers();
    let now = new Date(0);
    const r = createUserResolver(client, () => now);
    await r.getUser("U1");
    now = new Date(59 * 60 * 1000);
    await r.getUser("U1");
    expect(info).toHaveBeenCalledTimes(1);
    now = new Date(61 * 60 * 1000);
    await r.getUser("U1");
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("user_not_found は ID を名前にして、deleted として返す（投げない）", async () => {
    const { client } = fakeUsers();
    const r = createUserResolver(client, () => new Date(0));
    expect(await r.getUser("UGONE")).toEqual({ id: "UGONE", name: "UGONE", deleted: true });
  });

  it("users.info の deleted を返す。無ければ false", async () => {
    const client: SlackUsersClient = {
      users: {
        async info({ user }) {
          return {
            user: { id: user, name: user, ...(user === "UOLD" ? { deleted: true } : {}) },
          };
        },
      },
    };
    const r = createUserResolver(client, () => new Date(0));
    expect((await r.getUser("UOLD")).deleted).toBe(true);
    expect((await r.getUser("UNEW")).deleted).toBe(false);
  });

  it("それ以外のエラーは投げる", async () => {
    const client: SlackUsersClient = {
      users: {
        async info() {
          throw new Error("ratelimited");
        },
      },
    };
    const r = createUserResolver(client, () => new Date(0));
    await expect(r.getUser("U1")).rejects.toThrow("ratelimited");
  });
});
