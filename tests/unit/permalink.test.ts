import { describe, expect, it, vi } from "vitest";
import { buildPermalink, createPermalinkBuilder } from "../../src/slack/permalink.js";

describe("buildPermalink", () => {
  it("トップレベルのメッセージは /archives/<ch>/p<ts の数字>", () => {
    expect(buildPermalink("https://acme.slack.com/", "C1", "1729746180.123456", null)).toBe(
      "https://acme.slack.com/archives/C1/p1729746180123456",
    );
  });

  it("スレッドの返信は ?thread_ts=&cid= を付ける", () => {
    expect(
      buildPermalink("https://acme.slack.com", "C1", "1729746200.000100", "1729746180.123456"),
    ).toBe(
      "https://acme.slack.com/archives/C1/p1729746200000100?thread_ts=1729746180.123456&cid=C1",
    );
  });

  it("スレッドの親（threadTs が ts と同じ）は付けない", () => {
    expect(buildPermalink("https://acme.slack.com/", "C1", "1.000100", "1.000100")).toBe(
      "https://acme.slack.com/archives/C1/p1000100",
    );
  });
});

describe("createPermalinkBuilder", () => {
  it("auth.test の url を 1 回だけ取ってキャッシュする", async () => {
    const test = vi.fn(async () => ({ url: "https://acme.slack.com/" }));
    const b = createPermalinkBuilder({ auth: { test } });
    expect(await b.permalink("C1", "1.000100", null)).toBe(
      "https://acme.slack.com/archives/C1/p1000100",
    );
    expect(await b.permalink("C2", "2.000200", "1.000100")).toBe(
      "https://acme.slack.com/archives/C2/p2000200?thread_ts=1.000100&cid=C2",
    );
    expect(test).toHaveBeenCalledTimes(1);
  });

  it("auth.test が失敗したらキャッシュせず、次の呼び出しで取り直す", async () => {
    const test = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ url: "https://acme.slack.com/" });
    const b = createPermalinkBuilder({ auth: { test } });
    await expect(b.permalink("C1", "1.000100", null)).rejects.toThrow("boom");
    expect(await b.permalink("C1", "1.000100", null)).toBe(
      "https://acme.slack.com/archives/C1/p1000100",
    );
  });

  it("url が無い応答は失敗にする", async () => {
    const b = createPermalinkBuilder({ auth: { test: async () => ({}) } });
    await expect(b.permalink("C1", "1.000100", null)).rejects.toThrow();
  });
});
