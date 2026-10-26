import { describe, expect, it } from "vitest";
import { CHUNK_MAX_TOKENS, chunkMessages } from "../../src/analysis/chunk.js";
import { countTokens } from "../../src/analysis/tokens.js";
import type { SlackMessage } from "../../src/slack/conversation.js";

function m(ts: string, text: string, threadTs: string | null = null): SlackMessage {
  return { ts, threadTs, userId: "U1", text, edited: false, reactions: [] };
}

/** テストでは 1 文字 = 1 トークンとして数える。 */
const measure = (msg: SlackMessage) => msg.text.length;

const tsOf = (chunks: SlackMessage[][]) => chunks.map((c) => c.map((x) => x.ts));

describe("tokens", () => {
  it("o200k でトークン数を数える", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("定例の日程を決めたいです")).toBeGreaterThan(0);
  });

  it("特別なトークンの文字列を含んでも例外にしない", () => {
    expect(countTokens("<|endoftext|> と <|im_start|>")).toBeGreaterThan(2);
  });
});

describe("chunkMessages", () => {
  it("上限は 60,000 トークン（R5）", () => {
    expect(CHUNK_MAX_TOKENS).toBe(60_000);
  });

  it("空なら空", () => {
    expect(chunkMessages([], { maxTokens: 10, measure })).toEqual([]);
  });

  it("上限に収まれば 1 つにまとめる", () => {
    const msgs = [m("1.000001", "aaaa"), m("2.000001", "bbbb")];
    expect(tsOf(chunkMessages(msgs, { maxTokens: 100, measure }))).toEqual([
      ["1.000001", "2.000001"],
    ]);
  });

  it("上限を超えたら、メッセージの切れ目で次の塊にする", () => {
    const msgs = [m("1.000001", "aaaa"), m("2.000001", "bbbb"), m("3.000001", "cccc")];
    expect(tsOf(chunkMessages(msgs, { maxTokens: 8, measure }))).toEqual([
      ["1.000001", "2.000001"],
      ["3.000001"],
    ]);
  });

  it("ちょうど上限なら同じ塊に入る", () => {
    const msgs = [m("1.000001", "aaaa"), m("2.000001", "bbbb")];
    expect(chunkMessages(msgs, { maxTokens: 8, measure })).toHaveLength(1);
  });

  it("スレッド（親と返信）は切らずに同じ塊に入れる", () => {
    const msgs = [
      m("1.000001", "aaaa"), // 単発
      m("2.000001", "bbbb"), // 親
      m("3.000001", "cc"), // 単発（親と返信の間）
      m("4.000001", "dddd", "2.000001"), // 返信
      m("5.000001", "eeee", "2.000001"), // 返信
    ];
    // スレッドは親 bbbb(4) + dddd(4) + eeee(4) = 12 トークン
    const chunks = chunkMessages(msgs, { maxTokens: 16, measure });
    for (const c of chunks) {
      const hasParent = c.some((x) => x.ts === "2.000001");
      const replies = c.filter((x) => x.threadTs === "2.000001").length;
      if (hasParent || replies > 0) expect(replies).toBe(2);
    }
    // 塊の中は ts の昇順
    for (const c of chunks) {
      expect(c.map((x) => x.ts)).toEqual([...c.map((x) => x.ts)].sort());
    }
    // すべてのメッセージが 1 回ずつ現れる
    expect(
      chunks
        .flat()
        .map((x) => x.ts)
        .sort(),
    ).toEqual(msgs.map((x) => x.ts));
  });

  it("スレッド全体が入らなければ、スレッドごと次の塊に送る", () => {
    const msgs = [
      m("1.000001", "aaaaaaaa"), // 8
      m("2.000001", "bbbb"), // 親 4
      m("3.000001", "cccc", "2.000001"), // 4
    ];
    expect(tsOf(chunkMessages(msgs, { maxTokens: 12, measure }))).toEqual([
      ["1.000001"],
      ["2.000001", "3.000001"],
    ]);
  });

  it("1 つのスレッドが上限を超えるときだけ、時刻順に分ける", () => {
    const msgs = [
      m("1.000001", "aaaa"), // 親
      m("2.000001", "bbbb", "1.000001"),
      m("3.000001", "cccc", "1.000001"),
      m("4.000001", "dddd", "1.000001"),
      m("5.000001", "eeee", "1.000001"),
    ];
    const chunks = chunkMessages(msgs, { maxTokens: 8, measure });
    expect(tsOf(chunks)).toEqual([
      ["1.000001", "2.000001"],
      ["3.000001", "4.000001"],
      ["5.000001"],
    ]);
  });

  it("上限を超えるスレッドの前に溜まった塊は先に閉じる", () => {
    const msgs = [
      m("1.000001", "aa"),
      m("2.000001", "bbbb"), // 親（スレッドは 12 で上限 8 を超える）
      m("3.000001", "cccc", "2.000001"),
      m("4.000001", "dddd", "2.000001"),
    ];
    expect(tsOf(chunkMessages(msgs, { maxTokens: 8, measure }))).toEqual([
      ["1.000001"],
      ["2.000001", "3.000001"],
      ["4.000001"],
    ]);
  });

  it("1 件で上限を超えるメッセージは、そのまま 1 件だけの塊にする", () => {
    const msgs = [m("1.000001", "a"), m("2.000001", "bbbbbbbbbbbb"), m("3.000001", "c")];
    expect(tsOf(chunkMessages(msgs, { maxTokens: 5, measure }))).toEqual([
      ["1.000001"],
      ["2.000001"],
      ["3.000001"],
    ]);
  });

  it("親が入力に無い返信も、同じスレッドとして扱う", () => {
    const msgs = [
      m("5.000001", "aaaa", "1.000001"),
      m("6.000001", "bbbb", "1.000001"),
      m("7.000001", "cccc"),
    ];
    expect(tsOf(chunkMessages(msgs, { maxTokens: 8, measure }))).toEqual([
      ["5.000001", "6.000001"],
      ["7.000001"],
    ]);
  });

  it("入力の並びが ts の昇順でなくても、塊は時刻順にする", () => {
    const msgs = [m("3.000001", "cc"), m("1.000001", "aa"), m("2.000001", "bb")];
    expect(tsOf(chunkMessages(msgs, { maxTokens: 100, measure }))).toEqual([
      ["1.000001", "2.000001", "3.000001"],
    ]);
  });

  it("既定の数え方: 本文のトークン数に行の見出しの分を足す", () => {
    const big = "word ".repeat(1000); // 約 1000 トークン
    const msgs = [m("1.000001", big), m("2.000001", big), m("3.000001", big)];
    const chunks = chunkMessages(msgs, { maxTokens: 2500 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2);
  });
});
