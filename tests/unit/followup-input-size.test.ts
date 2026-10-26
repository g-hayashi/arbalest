/**
 * SC-006 の入力の大きさ（実際の AI を呼ばずに見積もる）。
 * eval/cases/followup-long-01.json（初回 24 件 + 差分 3 件）を、状態を返すフェイクの LLM で通し、
 * 差分の更新の user 入力（<context>・<previous_state>・<messages>）が初回の何割かを countTokens で数える。
 * 固定の system は両方に同じだけ入るので、ここでは含めない（eval/run.ts の「固定を除いた比」の下限に近い値）。
 * フェイクの状態は、実際の AI の出力より小さめの想定。閾値は、前処理を削る前（0.47）からの改善（0.38）を固定するためのもの。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases, toSlackMessage } from "../../eval/cases.js";
import { analyze, type PriorAnalysis } from "../../src/analysis/pipeline.js";
import { PROMPT_VERSION } from "../../src/analysis/prompts/summarize.js";
import type { SummarizePatch } from "../../src/analysis/schemas.js";
import { countTokens } from "../../src/analysis/tokens.js";
import { createFakeLlmProvider, type LlmRequest } from "../../src/llm/index.js";

const EMPTY: SummarizePatch = {
  overview: [],
  topics: [],
  responses: [],
  statements: [],
  todos: [],
  questions: [],
  close: [],
};

/** input の中から、本文に snippet を含むメッセージの m-id を引く。 */
function mid(input: string, snippet: string): string {
  const line = input.split("\n").find((l) => /^\[m\d+\]/.test(l) && l.includes(snippet));
  const id = line === undefined ? undefined : /^\[(m\d+)\]/.exec(line)?.[1];
  if (id === undefined) throw new Error(`メッセージがありません: ${snippet}`);
  return id;
}

function firstPatch(input: string): SummarizePatch {
  const m1 = mid(input, "日程調整です");
  const hands = mid(input, "ハンズオン形式");
  const reply = (p: string, snippet: string) => ({
    evidence: [mid(input, snippet)],
    quote: snippet,
    topic_ref: "new:0",
    option_ref: "new:0",
    participant: p,
    answer: "yes" as const,
    certainty: "explicit" as const,
  });
  return {
    ...EMPTY,
    topics: [
      {
        ref: null,
        evidence: [m1],
        title: "ワークショップの日程",
        required_participants: ["p2", "p3", "p4"],
        options: [
          { ref: null, evidence: [m1], label: "11/10(火) 14:00", date_iso: "2026-11-10" },
          { ref: null, evidence: [m1], label: "11/11(水) 14:00", date_iso: "2026-11-11" },
        ],
      },
      {
        ref: null,
        evidence: [hands],
        title: "ワークショップの内容",
        required_participants: [],
        options: [{ ref: null, evidence: [hands], label: "ハンズオン形式", date_iso: null }],
      },
    ],
    responses: [
      reply("p2", "私は 11/10 の 14:00 で大丈夫です"),
      reply("p3", "11/10 の 14:00 で問題ありません"),
      reply("p4", "私も 11/10 の 14:00 で大丈夫です"),
    ],
    statements: [
      {
        evidence: [mid(input, "確定とします")],
        quote: "11/10(火) 14:00 で確定とします",
        topic_ref: "new:0",
        option_ref: "new:0",
        text: "11/10(火) 14:00 で確定",
        certainty: "explicit",
      },
    ],
    todos: [
      {
        ref: null,
        evidence: [mid(input, "事前にアカウント")],
        quote: "事前にアカウントの準備が必要",
        text: "アカウントを準備する",
        assignee: null,
        due_iso: null,
        due_text: null,
        certainty: "implied",
      },
    ],
    questions: [
      {
        ref: null,
        evidence: [mid(input, "軽食")],
        quote: "軽食もあるといいですね",
        text: "軽食を用意するか",
      },
    ],
    close: [],
  };
}

function followUpPatch(input: string): SummarizePatch {
  const ask = mid(input, "案内資料");
  const accept = mid(input, "私が作成して");
  return {
    ...EMPTY,
    todos: [
      {
        ref: null,
        evidence: [ask, accept],
        quote: "11/6 までに私が作成して共有します",
        text: "ワークショップの案内資料を作成して共有する",
        assignee: "p2",
        due_iso: "2026-11-06",
        due_text: "11/6 まで",
        certainty: "explicit",
      },
    ],
  };
}

/** `<previous_state>` の有無で、初回と差分を見分ける。 */
const handler = (req: LlmRequest<unknown>): SummarizePatch =>
  req.input.includes("<previous_state>") ? followUpPatch(req.input) : firstPatch(req.input);

describe("SC-006: 差分の更新の入力の大きさ（followup-long-01）", () => {
  it("差分の user 入力は、初回の user 入力の 0.4 倍以下", async () => {
    const cases = await loadCases(path.resolve(import.meta.dirname, "../../eval/cases"));
    const c = cases.find((x) => x.id === "followup-long-01");
    if (c?.followUp === undefined) throw new Error("followup-long-01 がありません");

    const llm = createFakeLlmProvider({ summarize_patch: handler });
    const names = new Map(c.participants.map((p) => [p.userId, p.name]));
    const now = new Date(c.now);
    const first = c.messages.map(toSlackMessage);
    const r1 = await analyze({ llm, messages: first, names, now, prior: null });
    const prior: PriorAnalysis = {
      lastAnalyzedTs: r1.lastAnalyzedTs,
      analyzedDigest: r1.analyzedDigest,
      promptVersion: PROMPT_VERSION,
      participants: r1.participants,
      state: r1.state,
      nextSeq: r1.nextSeq,
    };
    const all = [...first, ...c.followUp.messages.map(toSlackMessage)];
    await analyze({ llm, messages: all, names, now, prior });

    const [i1, i2] = llm.calls.map((call) => call.input);
    expect(i2).toContain("<previous_state>");
    const ratio = countTokens(i2 as string) / countTokens(i1 as string);
    expect(ratio).toBeLessThanOrEqual(0.4);
  });
});
