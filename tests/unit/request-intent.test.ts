import { describe, expect, it } from "vitest";
import { interpretRequest } from "../../src/commands/intent.js";
import { createFakeLlmProvider } from "../../src/llm/fake.js";

const NOW = new Date("2026-10-25T08:00:00.000Z");
const output = (over: Record<string, unknown> = {}) => ({
  intent: "summary",
  suppressTodo: false,
  suppressCanvas: false,
  period: null,
  ...over,
});

describe("interpretRequest", () => {
  it.each(["", "  ", "まとめ", "summary", "要約"])(
    "既定の依頼 %s はAIを呼ばずsummaryにする",
    async (text) => {
      const llm = createFakeLlmProvider();
      expect(await interpretRequest({ text, llm, now: NOW })).toEqual({
        intent: { kind: "summary", suppressTodo: false, suppressCanvas: false },
        usage: null,
      });
      expect(llm.calls).toHaveLength(0);
    },
  );

  it("自然文の依頼だけを構造化抽出へ渡す", async () => {
    const llm = createFakeLlmProvider({ request_intent: () => output() });
    const result = await interpretRequest({ text: "今の話を整理して", llm, now: NOW });
    expect(result.intent).toEqual({ kind: "summary", suppressTodo: false, suppressCanvas: false });
    expect(result.usage?.model).toBe("fake");
    expect(llm.calls[0]).toMatchObject({ task: "extract", schemaName: "request_intent" });
    expect(JSON.parse(llm.calls[0]?.input ?? "{}")).toEqual({ request: "今の話を整理して" });
  });

  it.each(["見るだけ", "登録しないでまとめて"])(
    "明示した抑止 %s をコードでも維持する",
    async (text) => {
      const llm = createFakeLlmProvider({ request_intent: () => output() });
      expect((await interpretRequest({ text, llm, now: NOW })).intent).toEqual({
        kind: "summary",
        suppressTodo: true,
        suppressCanvas: true,
      });
    },
  );

  it.each([
    [
      "先週の動きを振り返って",
      "last_week",
      null,
      "2026-10-11T15:00:00.000Z",
      "2026-10-18T15:00:00.000Z",
    ],
    ["この2週間の学びは？", "rolling_weeks", 2, "2026-10-11T08:00:00.000Z", NOW.toISOString()],
    ["最近の振り返り", "default", null, "2026-09-25T08:00:00.000Z", NOW.toISOString()],
  ])("%s の期間はコードで計算する", async (text, kind, amount, start, end) => {
    const llm = createFakeLlmProvider({
      request_intent: () => output({ intent: "findings", period: { kind, amount } }),
    });
    expect((await interpretRequest({ text: String(text), llm, now: NOW })).intent).toMatchObject({
      kind: "findings",
      period: { start, end, clamped: false },
    });
  });

  it("曖昧な依頼では副作用を抑止して確認する", async () => {
    const llm = createFakeLlmProvider({ request_intent: () => output({ intent: "clarify" }) });
    expect((await interpretRequest({ text: "あれをやって", llm, now: NOW })).intent).toMatchObject({
      kind: "clarify",
      suppressTodo: true,
      suppressCanvas: true,
    });
  });

  it("不正な期間はsummaryにフォールバックせず確認する", async () => {
    const llm = createFakeLlmProvider({
      request_intent: () =>
        output({ intent: "findings", period: { kind: "rolling_days", amount: 0 } }),
    });
    expect(
      (await interpretRequest({ text: "0日分を振り返って", llm, now: NOW })).intent,
    ).toMatchObject({ kind: "clarify", suppressTodo: true, suppressCanvas: true });
  });
});
