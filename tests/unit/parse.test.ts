import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/commands/parse.js";

describe("parseCommand", () => {
  it.each(["まとめ", "summary", "要約", "  まとめ  ", "SUMMARY", "Summary"])(
    "summarize: %s",
    (text) => {
      expect(parseCommand(text)).toEqual({ kind: "summarize" });
    },
  );

  it.each(["canvas", "キャンバス", "Canvas"])("canvas: %s", (text) => {
    expect(parseCommand(text)).toEqual({ kind: "canvas" });
  });

  it.each(["todo", "ToDo", "TODO", "タスク"])("todo: %s", (text) => {
    expect(parseCommand(text)).toEqual({ kind: "todo" });
  });

  it("findings の既定は 30 日", () => {
    expect(parseCommand("findings")).toEqual({ kind: "findings", days: 30, clamped: false });
    expect(parseCommand("振り返り")).toEqual({ kind: "findings", days: 30, clamped: false });
  });

  it("findings の日数を読む（日あり・なし、別名）", () => {
    expect(parseCommand("findings 30日")).toEqual({ kind: "findings", days: 30, clamped: false });
    expect(parseCommand("findings 30")).toEqual({ kind: "findings", days: 30, clamped: false });
    expect(parseCommand("振り返り 14日")).toEqual({ kind: "findings", days: 14, clamped: false });
    expect(parseCommand("findings 7days")).toEqual({ kind: "findings", days: 7, clamped: false });
  });

  it("全角の数字・英字・空白を半角にして読む", () => {
    expect(parseCommand("ｆｉｎｄｉｎｇｓ　１４日")).toEqual({
      kind: "findings",
      days: 14,
      clamped: false,
    });
    expect(parseCommand("ＴＯＤＯ")).toEqual({ kind: "todo" });
    expect(parseCommand("ｃａｎｖａｓ")).toEqual({ kind: "canvas" });
  });

  it("上限の 90 日は clamped にならない", () => {
    expect(parseCommand("findings 90日")).toEqual({ kind: "findings", days: 90, clamped: false });
  });

  it("上限を超えたら 90 にして clamped: true", () => {
    expect(parseCommand("findings 91")).toEqual({ kind: "findings", days: 90, clamped: true });
    expect(parseCommand("findings 365日")).toEqual({ kind: "findings", days: 90, clamped: true });
    expect(parseCommand("振り返り １００日")).toEqual({
      kind: "findings",
      days: 90,
      clamped: true,
    });
  });

  it("定型コマンドとして不正な引数も依頼文として worker に渡す", () => {
    expect(parseCommand("findings 0")).toEqual({ kind: "request", text: "findings 0" });
    expect(parseCommand("findings abc")).toEqual({ kind: "request", text: "findings abc" });
  });

  it.each(["", "   ", "こんにちは", "まとめて", "先週の動きを振り返って"])(
    "空と自然文は request: %s",
    (text) => {
      expect(parseCommand(text)).toEqual({ kind: "request", text: text.trim() });
    },
  );

  it("依頼文は全角を正規化し、英字の大文字は保持する", () => {
    expect(parseCommand("  この２週間の ToDo を見たい  ")).toEqual({
      kind: "request",
      text: "この2週間の ToDo を見たい",
    });
  });
});
