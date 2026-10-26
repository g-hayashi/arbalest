import { describe, expect, it, vi } from "vitest";
import { createTeamsGraphReader, TeamsApiError, teamsHtmlToText } from "../../src/teams/graph.js";

const base = "https://graph.microsoft.com/v1.0/teams/team/channels/channel";
const rootPath = `${base}/messages/root`;
const when = "2026-10-26T00:00:00.123Z";
const message = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  createdDateTime: when,
  messageType: "message",
  from: { user: { id: "user", displayName: "田中" } },
  body: { contentType: "html", content: `<p>${id}</p>` },
  ...overrides,
});

function setup(routes: Record<string, unknown>, limits = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const url = String(input);
    if (url === base) return Response.json({ membershipType: "standard" });
    if (!(url in routes)) throw new Error("Unexpected synthetic request");
    const result = routes[url];
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : Response.json(result);
  });
  return {
    fetch,
    reader: createTeamsGraphReader({
      token: async () => "synthetic-token",
      fetch,
      tenantId: "tenant",
      ...limits,
    }),
  };
}

describe("Teams Graph", () => {
  it("永続根拠はUUIDだけ小文字化し、同じIDの親・返信・別rootを区別する", async () => {
    const tenantId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const teamId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const channelId = "19:MixedCase@thread.tacv2";
    const channelPath = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${encodeURIComponent(channelId)}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url === channelPath) return Response.json({ membershipType: "standard" });
      if (url === `${channelPath}/messages`) {
        return Response.json({ value: [message("RootA"), message("RootB")] });
      }
      if (url.endsWith("/messages/RootA/replies")) {
        return Response.json({ value: [message("RootA"), message("SharedID")] });
      }
      if (url.endsWith("/messages/RootB/replies")) {
        return Response.json({ value: [message("SharedID")] });
      }
      throw new Error("unexpected synthetic request");
    });
    const reader = createTeamsGraphReader({ token: async () => "synthetic", fetch, tenantId });
    const result = await reader.getChannel(
      teamId,
      channelId,
      new Date("2026-10-26T00:00:00Z"),
      new Date("2026-10-27T00:00:00Z"),
    );
    const refs = [...result.sourceRefs.values()];
    expect(refs).toHaveLength(5);
    expect(new Set(refs.map((ref) => JSON.stringify(ref))).size).toBe(5);
    expect(refs).toEqual(
      expect.arrayContaining([
        {
          tenantId: tenantId.toLowerCase(),
          teamId: teamId.toLowerCase(),
          channelId,
          rootMessageId: "RootA",
          kind: "root",
          messageId: "RootA",
        },
        {
          tenantId: tenantId.toLowerCase(),
          teamId: teamId.toLowerCase(),
          channelId,
          rootMessageId: "RootA",
          kind: "reply",
          messageId: "RootA",
        },
        {
          tenantId: tenantId.toLowerCase(),
          teamId: teamId.toLowerCase(),
          channelId,
          rootMessageId: "RootB",
          kind: "reply",
          messageId: "SharedID",
        },
      ]),
    );
    for (const m of result.messages) {
      expect(result.sourceRefs.get(m.ts)?.messageId).toBe(result.sourceIds.get(m.ts));
      expect(result.links.has(m.ts)).toBe(true);
    }
  });

  it("実チャネルIDのnextLinkが非エンコード形でも同一コレクションとして辿る", async () => {
    const channelId = "19:abc@thread.tacv2";
    const first = `https://graph.microsoft.com/v1.0/teams/team/channels/${encodeURIComponent(channelId)}`;
    const next = `https://graph.microsoft.com/v1.0/teams/team/channels/${channelId}/messages/root/replies?$skiptoken=more`;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const current = String(url);
      if (current === first) return Response.json({ membershipType: "standard" });
      if (current === `${first}/messages/root`) return Response.json(message("root"));
      if (current === `${first}/messages/root/replies`)
        return Response.json({ value: [], "@odata.nextLink": next });
      if (current === next) return Response.json({ value: [message("reply")] });
      throw new Error("unexpected synthetic request");
    });
    const reader = createTeamsGraphReader({
      token: async () => "synthetic",
      fetch,
      tenantId: "tenant",
    });
    expect((await reader.getThread("team", channelId, "root")).messages).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("Graphの既定システム種別も本文を分析せずに除き、enum展開を明示する", async () => {
    const { reader, fetch } = setup({
      [rootPath]: message("root"),
      [`${rootPath}/replies`]: {
        value: ["unknownFutureValue", "chatEvent", "typing"].map((messageType) =>
          message(messageType, { messageType, body: null, from: null }),
        ),
      },
    });
    expect((await reader.getThread("team", "channel", "root")).messages).toHaveLength(1);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Prefer: "include-unknown-enum-members",
    });
  });

  it("返信コレクションで親と同じIDを持つ返信も別投稿として保持する", async () => {
    const { reader } = setup({
      [rootPath]: message("root"),
      [`${rootPath}/replies`]: {
        value: [
          message("root", {
            replyToId: "root",
            body: { contentType: "text", content: "親とIDが同じ返信" },
          }),
        ],
      },
    });
    const result = await reader.getThread("team", "channel", "root");
    expect(result.messages).toHaveLength(2);
    const parent = result.messages.find((m) => m.threadTs === null);
    const reply = result.messages.find((m) => m.text === "親とIDが同じ返信");
    expect(reply?.threadTs).toBe(parent?.ts);
    expect(reply?.ts).not.toBe(parent?.ts);
  });

  it("別スレッドで同じ返信IDがあっても両方を保持し、根拠を元の親へ対応させる", async () => {
    const { reader } = setup({
      [`${base}/messages`]: { value: [message("parent-a"), message("parent-b")] },
      [`${base}/messages/parent-a/replies`]: {
        value: [
          message("same-reply", {
            replyToId: "parent-a",
            body: { contentType: "text", content: "Aの返信" },
          }),
        ],
      },
      [`${base}/messages/parent-b/replies`]: {
        value: [
          message("same-reply", {
            replyToId: "parent-b",
            body: { contentType: "text", content: "Bの返信" },
          }),
        ],
      },
    });
    const result = await reader.getChannel(
      "team",
      "channel",
      new Date("2026-10-25Z"),
      new Date("2026-10-27Z"),
    );
    expect(result.messages).toHaveLength(4);
    const a = result.messages.find((m) => m.text === "Aの返信");
    const b = result.messages.find((m) => m.text === "Bの返信");
    expect(a?.ts).not.toBe(b?.ts);
    expect(a?.threadTs).not.toBe(b?.threadTs);
    expect(new URL(result.links.get(a?.ts ?? "") ?? "").searchParams.get("parentMessageId")).toBe(
      "parent-a",
    );
    expect(new URL(result.links.get(b?.ts ?? "") ?? "").searchParams.get("parentMessageId")).toBe(
      "parent-b",
    );
  });

  it("親と全ページの返信を正規化し元ID・名前・検証したリンクを対応させる", async () => {
    const next = `${rootPath}/replies?$skiptoken=second`;
    const { reader, fetch } = setup({
      [rootPath]: message("root", {
        body: {
          contentType: "html",
          content: "<p>決定 &amp; 確認<br><at id='0'>佐藤</at></p><script>秘密</script>",
        },
        webUrl: "https://teams.microsoft.com/l/message/channel/root?tenantId=tenant",
      }),
      [`${rootPath}/replies`]: { value: [message("reply-b")], "@odata.nextLink": next },
      [next]: { value: [message("reply-a", { lastEditedDateTime: when })] },
    });
    const result = await reader.getThread("team", "channel", "root");
    expect(result.messages.map((m) => m.ts)).toEqual([
      "1792972800.123000",
      "1792972800.123001",
      "1792972800.123002",
    ]);
    expect([...result.sourceIds.values()]).toEqual(["reply-a", "reply-b", "root"]);
    const root = result.messages.find((m) => result.sourceIds.get(m.ts) === "root");
    expect(root).toMatchObject({ text: "決定 & 確認\n@佐藤", threadTs: null, userId: "user" });
    expect(result.messages[0]).toMatchObject({ edited: true, threadTs: root?.ts, reactions: [] });
    expect(result.names.get("user")).toBe("田中");
    expect(result.links.get(root?.ts ?? "")).toBe(
      "https://teams.microsoft.com/l/message/channel/root?tenantId=tenant",
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("HTMLはパーサーでentity・改行・メンションを処理しscript/styleを除去する", () => {
    expect(
      teamsHtmlToText("<p>A &lt; B</p><style>secret</style><p><at>佐藤 &amp; 鈴木</at><br>C</p>"),
    ).toBe("A < B\n@佐藤 & 鈴木\nC");
    expect(teamsHtmlToText("<p title='>'>本文</p><script><p>除外</p></script>末尾")).toBe(
      "本文\n末尾",
    );
  });

  it("削除・application・システム投稿を除き、text形式の本文はHTML解釈しない", async () => {
    const { reader } = setup({
      [rootPath]: message("root", { body: { contentType: "text", content: "<b>そのまま</b>" } }),
      [`${rootPath}/replies`]: {
        value: [
          message("deleted", { deletedDateTime: when }),
          message("bot", { from: { application: { id: "app" }, user: { id: "user" } } }),
          message("system", { messageType: "systemEventMessage" }),
        ],
      },
    });
    expect((await reader.getThread("team", "channel", "root")).messages).toMatchObject([
      { text: "<b>そのまま</b>" },
    ]);
  });

  it("全親と全返信のページを展開し期間前の親への期間内返信を含め半開区間で絞る", async () => {
    const next = `${base}/messages?$skiptoken=more`;
    const repliesNext = `${base}/messages/old/replies?$skiptoken=more`;
    const { reader } = setup({
      [`${base}/messages`]: {
        value: [message("old", { createdDateTime: "2026-10-01T00:00:00Z" })],
        "@odata.nextLink": next,
      },
      [next]: { value: [message("new", { createdDateTime: "2026-10-27T00:00:00Z" })] },
      [`${base}/messages/old/replies`]: {
        value: [message("before", { createdDateTime: "2026-10-25T23:59:59.999Z" })],
        "@odata.nextLink": repliesNext,
      },
      [repliesNext]: {
        value: [
          message("start", { createdDateTime: "2026-10-26T00:00:00Z" }),
          message("end", { createdDateTime: "2026-10-27T00:00:00Z" }),
        ],
      },
      [`${base}/messages/new/replies`]: { value: [] },
    });
    const result = await reader.getChannel(
      "team",
      "channel",
      new Date("2026-10-26Z"),
      new Date("2026-10-27Z"),
    );
    expect([...result.sourceIds.values()]).toEqual(["start"]);
    expect(result.messages[0]?.threadTs).toBe("1790812800.000000");
  });

  it("ページ順によらず同一msの元ID順にIDを割り当て重複を除く", async () => {
    const collect = async (ids: string[]) => {
      const { reader } = setup({
        [rootPath]: message("root"),
        [`${rootPath}/replies`]: { value: ids.map((id) => message(id)) },
      });
      return (await reader.getThread("team", "channel", "root")).sourceIds;
    };
    expect(await collect(["b", "a", "b"])).toEqual(await collect(["a", "b"]));
  });

  it.each([
    "https://evil.example/messages?token=secret",
    `${rootPath}/replies/other?$skiptoken=secret`,
    `${base}/messages/other/replies?$skiptoken=secret`,
    `${rootPath}/replies/../other`,
    `http://graph.microsoft.com/v1.0/teams/team/channels/channel/messages/root/replies`,
    `https://user:secret@graph.microsoft.com/v1.0/teams/team/channels/channel/messages/root/replies`,
    `${rootPath}/replies#secret`,
    `${base}/messages%2Froot/replies`,
    `${rootPath}/replies%ZZ`,
  ])("不正なnextLinkへトークンを送らず拒否する: %s", async (next) => {
    const { reader, fetch } = setup({
      [rootPath]: message("root"),
      [`${rootPath}/replies`]: { value: [], "@odata.nextLink": next },
    });
    await expect(reader.getThread("team", "channel", "root")).rejects.toBeInstanceOf(TeamsApiError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("nextLink循環は不完全な結果を返さず停止する", async () => {
    const { reader, fetch } = setup({
      [rootPath]: message("root"),
      [`${rootPath}/replies`]: { value: [], "@odata.nextLink": `${rootPath}/replies` },
    });
    await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["private", "shared", undefined])(
    "標準チャネル以外の履歴を読まない: %s",
    async (membershipType) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ membershipType }));
      const reader = createTeamsGraphReader({
        token: async () => "synthetic",
        fetch,
        tenantId: "tenant",
      });
      await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 404, 429, 500, 503])(
    "HTTP失敗は秘密を含まず再試行可否を分類する: %s",
    async (status) => {
      const { reader } = setup({ [rootPath]: new Response("secret body", { status }) });
      const error = await reader.getThread("team", "channel", "root").catch((e) => e);
      expect(error).toBeInstanceOf(TeamsApiError);
      expect(error).toMatchObject({ status, retryable: status === 429 || status >= 500 });
      expect(String(error)).not.toMatch(/secret|synthetic|https:\/\//);
    },
  );

  it.each([new Error("secret network URL"), new DOMException("secret timeout", "TimeoutError")])(
    "通信失敗を安全な再試行可能エラーにする",
    async (failure) => {
      const { reader } = setup({ [rootPath]: failure });
      await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
        status: 0,
        retryable: true,
      });
    },
  );

  it.each([
    new Response("secret malformed json"),
    { value: "invalid" },
    { value: [message("bad", { createdDateTime: "not a date" })] },
    { value: [message("bad", { createdDateTime: "2026-02-30T00:00:00Z" })] },
    { value: [message("bad", { body: { contentType: "html", content: 42 } })] },
    { value: [], "@odata.nextLink": 42 },
  ])("不正なJSONやメッセージを安全に拒否する", async (page) => {
    const { reader } = setup({ [rootPath]: message("root"), [`${rootPath}/replies`]: page });
    await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("取得対象と異なる親IDを拒否する", async () => {
    const { reader } = setup({ [rootPath]: message("other") });
    await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
      retryable: false,
    });
  });

  it.each([
    "https://teams.microsoft.com.evil.example/secret",
    "javascript:alert(1)",
    "https://user:secret@teams.microsoft.com/secret",
    "https://teams.microsoft.com:444/secret",
  ])("不正なwebUrlは同じ元メッセージへの公式リンクに置き換える", async (webUrl) => {
    const { reader } = setup({
      [rootPath]: message("root", { webUrl }),
      [`${rootPath}/replies`]: { value: [message("reply")] },
    });
    const result = await reader.getThread("team", "channel", "root");
    for (const [id, link] of result.links) {
      const url = new URL(link);
      expect(url.origin).toBe("https://teams.microsoft.com");
      expect(url.pathname).toBe(`/l/message/channel/${result.sourceIds.get(id)}`);
      expect(url.searchParams.get("tenantId")).toBe("tenant");
      expect(url.searchParams.get("groupId")).toBe("team");
      expect(url.searchParams.get("parentMessageId")).toBe("root");
    }
  });

  it("全HTTPリクエストのページ上限を超える前に停止する", async () => {
    const { reader, fetch } = setup({ [rootPath]: message("root") }, { maxPages: 2 });
    await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("除外投稿も含め取得メッセージ数を制限し部分的な分析を返さない", async () => {
    const { reader } = setup(
      {
        [rootPath]: message("root"),
        [`${rootPath}/replies`]: { value: [message("deleted", { deletedDateTime: when })] },
      },
      { maxMessages: 1 },
    );
    await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("同一msの1000件以上を拒否する", async () => {
    const { reader } = setup({
      [rootPath]: message("root"),
      [`${rootPath}/replies`]: {
        value: Array.from({ length: 999 }, (_, i) => message(`reply-${i}`)),
      },
    });
    await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("空や逆転した期間と不正な上限を拒否する", async () => {
    const { reader, fetch } = setup({});
    await expect(
      reader.getChannel("team", "channel", new Date(1), new Date(0)),
    ).rejects.toBeInstanceOf(TeamsApiError);
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      createTeamsGraphReader({ token: async () => "x", tenantId: "t", maxPages: 0 }),
    ).toThrow(TeamsApiError);
  });

  it("本文を持たない削除済みの親を除き返信の親IDを保つ", async () => {
    const { reader } = setup({
      [rootPath]: message("root", { deletedDateTime: when, body: null, from: null }),
      [`${rootPath}/replies`]: { value: [message("reply")] },
    });
    const result = await reader.getThread("team", "channel", "root");
    expect([...result.sourceIds.values()]).toEqual(["reply"]);
    expect(result.messages[0]?.threadTs).toBe("1792972800.123001");
  });

  it("レスポンス本文の通信タイムアウトも安全に再試行可能とする", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("secret URL", "TimeoutError"));
      },
    });
    const { reader } = setup({ [rootPath]: new Response(stream) });
    await expect(reader.getThread("team", "channel", "root")).rejects.toMatchObject({
      status: 0,
      retryable: true,
    });
  });

  it.each([".", ".."])("パスを変える識別子を送信前に拒否する: %s", async (id) => {
    const { reader, fetch } = setup({});
    await expect(reader.getThread("team", "channel", id)).rejects.toBeInstanceOf(TeamsApiError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
