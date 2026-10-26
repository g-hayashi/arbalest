import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/analysis/decide.js";
import {
  applyPatch,
  carryOverIds,
  DROP_REASON,
  diffMarks,
  summaryChanged,
  verifyOverview,
} from "../../src/analysis/merge.js";
import type { SummarizePatch } from "../../src/analysis/schemas.js";
import { REASON, type VerifyContext } from "../../src/analysis/verify.js";
import { type AnalysisState, emptyAnalysisState } from "../../src/store/types.js";
import { jstTs, TODAY } from "../fixtures/schedule-thread.js";

// ---- 入力（合成の会話） ----

const TEXTS = [
  "定例の日程を決めたいです。候補は 10/28(水) 15:00 と 10/29(木) 10:00",
  "28日なら大丈夫です",
  "29日でお願いします",
  "では28日で確定します",
  "資料は佐藤さんが用意してください",
  "場所はどこにしますか",
];
/** m1..m6 → 10:01..10:06 */
const TS = TEXTS.map((_, i) => jstTs(10, i + 1));
const ctx: VerifyContext = {
  texts: new Map(TEXTS.map((t, i) => [`m${i + 1}`, t])),
  mIdToTs: new Map(TS.map((ts, i) => [`m${i + 1}`, ts])),
  participantIds: new Set(["p1", "p2", "p3"]),
  today: TODAY,
};
const ts = (n: number) => TS[n - 1] as string;

type Patch = SummarizePatch;
function patch(p: Partial<Patch>): Patch {
  return {
    overview: [],
    topics: [],
    responses: [],
    statements: [],
    todos: [],
    questions: [],
    close: [],
    ...p,
  };
}

const topicOp = (over: Partial<Patch["topics"][number]> = {}): Patch["topics"][number] => ({
  ref: null,
  evidence: ["m1"],
  title: "定例の日程",
  required_participants: ["p2", "p3"],
  options: [
    { ref: null, evidence: ["m1"], label: "10/28(水) 15:00", date_iso: "2026-10-28" },
    { ref: null, evidence: ["m1"], label: "10/29(木) 10:00", date_iso: "2026-10-29" },
  ],
  ...over,
});

const respOp = (over: Partial<Patch["responses"][number]> = {}): Patch["responses"][number] => ({
  evidence: ["m2"],
  quote: "28日なら大丈夫です",
  topic_ref: "new:0",
  option_ref: "new:0",
  participant: "p2",
  answer: "yes",
  certainty: "explicit",
  ...over,
});

const stmtOp = (over: Partial<Patch["statements"][number]> = {}): Patch["statements"][number] => ({
  evidence: ["m4"],
  quote: "28日で確定します",
  topic_ref: "k1",
  option_ref: "o1",
  text: "28日で確定",
  certainty: "explicit",
  ...over,
});

const todoOp = (over: Partial<Patch["todos"][number]> = {}): Patch["todos"][number] => ({
  ref: null,
  evidence: ["m5"],
  quote: "資料は佐藤さんが用意してください",
  text: "資料を用意する",
  assignee: "p2",
  due_iso: null,
  due_text: null,
  certainty: "explicit",
  ...over,
});

const questionOp = (over: Partial<Patch["questions"][number]> = {}) => ({
  ref: null,
  evidence: ["m6"],
  quote: "場所はどこにしますか",
  text: "場所",
  ...over,
});

const FIRST = patch({
  topics: [topicOp()],
  responses: [respOp()],
  todos: [todoOp()],
  questions: [questionOp()],
});

function first() {
  return applyPatch({ state: emptyAnalysisState(), nextSeq: {}, patch: FIRST, ctx });
}

function counts(s: AnalysisState) {
  return {
    topics: s.topics.length,
    options: s.topics.reduce((n, t) => n + t.options.length, 0),
    responses: s.responses.length,
    statements: s.statements.length,
    todos: s.todos.length,
    questions: s.questions.length,
  };
}

function allIds(s: AnalysisState): string[] {
  return [
    ...s.topics.map((t) => t.id),
    ...s.topics.flatMap((t) => t.options.map((o) => o.id)),
    ...s.responses.map((r) => r.id),
    ...s.statements.map((x) => x.id),
    ...s.todos.map((t) => t.id),
    ...s.questions.map((q) => q.id),
  ];
}

// ---- 例のテスト ----

describe("概要の現在範囲での再検証", () => {
  it("現在の根拠だけを残し、引用が現在の投稿で確認できなければ要確認にする", () => {
    const overview = [
      {
        id: "v1",
        text: "定例の日程を相談している",
        quote: TEXTS[0] as string,
        evidence: [ts(1)],
        needsReview: false,
        reviewReasons: [],
      },
      {
        id: "v2",
        text: "定例の日程への回答があった",
        quote: TEXTS[1] as string,
        evidence: [ts(1), ts(2)],
        needsReview: false,
        reviewReasons: [],
      },
      {
        id: "v3",
        text: "以前の相談",
        quote: TEXTS[0] as string,
        evidence: [ts(1), ts(2)],
        needsReview: false,
        reviewReasons: [],
      },
    ];
    const current = {
      ...ctx,
      texts: new Map([["m1", TEXTS[1] as string]]),
      mIdToTs: new Map([["m1", ts(2)]]),
    };

    expect(verifyOverview(overview, current)).toMatchObject([
      {
        id: "v1",
        evidence: [],
        needsReview: true,
        reviewReasons: [REASON.noEvidence, REASON.quoteNotFound],
      },
      { id: "v2", evidence: [ts(2)], needsReview: false, reviewReasons: [] },
      {
        id: "v3",
        evidence: [ts(2)],
        needsReview: true,
        reviewReasons: [REASON.quoteNotFound],
      },
    ]);
    expect(overview[0]?.evidence).toEqual([ts(1)]);
  });
});

describe("applyPatch: 新しい項目の採番と参照の解決", () => {
  it("概要の根拠と引用を検証し、差分で更新しても最大3項目を保存する", () => {
    const overview = [
      {
        ref: null,
        evidence: ["m1"],
        quote: "定例の日程を決めたいです",
        text: "定例の日程を相談している",
      },
    ];
    const base = applyPatch({
      state: emptyAnalysisState(),
      nextSeq: {},
      patch: { ...patch({}), overview } as Patch,
      ctx,
    });
    expect(base.state).toMatchObject({
      overview: [
        { id: "v1", text: "定例の日程を相談している", evidence: [ts(1)], needsReview: false },
      ],
    });
    const changed = applyPatch({
      state: base.state,
      nextSeq: base.nextSeq,
      patch: {
        ...patch({}),
        overview: [
          {
            ref: "v1",
            evidence: ["m2"],
            quote: "28日なら大丈夫です",
            text: "定例の日程への回答があった",
          },
          { ref: null, evidence: ["m5"], quote: "存在しない引用", text: "資料を準備する" },
          {
            ref: null,
            evidence: ["m6"],
            quote: "場所はどこにしますか",
            text: "場所を確認している",
          },
          { ref: null, evidence: ["m99"], quote: "不明", text: "根拠なし" },
        ],
      } as Patch,
      ctx,
    });
    const items = (
      changed.state as AnalysisState & {
        overview: { evidence: string[]; needsReview: boolean; reviewReasons: string[] }[];
      }
    ).overview;
    expect(items).toHaveLength(3);
    expect(items.some((item) => item.reviewReasons.includes(REASON.quoteNotFound))).toBe(true);
    expect(items.some((item) => item.evidence.includes(ts(2)))).toBe(true);
  });

  it("ref が null の項目に ID を振り、new:<添字> を解決し、根拠を ts に変える", () => {
    const r = first();
    expect(r.dropped).toEqual([]);
    const k = r.state.topics[0];
    expect(k).toMatchObject({ id: "k1", title: "定例の日程", evidence: [ts(1)] });
    expect(k?.requiredParticipants).toEqual(["p2", "p3"]);
    expect(k?.options.map((o) => [o.id, o.dateIso])).toEqual([
      ["o1", "2026-10-28"],
      ["o2", "2026-10-29"],
    ]);
    expect(r.state.responses[0]).toMatchObject({
      id: "r1",
      topicId: "k1",
      optionId: "o1",
      participant: "p2",
      evidence: [ts(2)],
      supersededBy: null,
      needsReview: false,
    });
    expect(r.state.todos[0]).toMatchObject({ id: "t1", assignee: "p2", closed: false });
    expect(r.state.questions[0]).toMatchObject({ id: "q1", closed: false });
    expect(r.nextSeq).toEqual({ k: 1, o: 2, r: 1, t: 1, q: 1 });
  });

  it("既存の topic への新しい option は、patch.topics の中で ref が一致する項目の options を指す", () => {
    const base = first();
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        topics: [
          topicOp({
            ref: "k1",
            evidence: ["m3"],
            options: [
              { ref: "o2", evidence: ["m3"], label: "10/29(木) 10:00", date_iso: "2026-10-29" },
              { ref: null, evidence: ["m3"], label: "10/30(金) 10:00", date_iso: "2026-10-30" },
            ],
          }),
        ],
        responses: [
          respOp({
            evidence: ["m3"],
            quote: "29日でお願いします",
            topic_ref: "k1",
            option_ref: "new:1",
            participant: "p3",
          }),
        ],
      }),
    });
    expect(r.dropped).toEqual([]);
    const k = r.state.topics[0];
    expect(k?.options.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(k?.evidence).toEqual([ts(1), ts(3)]);
    expect(r.state.responses[1]).toMatchObject({ id: "r2", topicId: "k1", optionId: "o3" });
  });

  it("解決できない参照は捨てて記録する", () => {
    const base = first();
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        topics: [topicOp({ ref: "k1", options: [] }), topicOp({ ref: "k99" })],
        responses: [
          respOp({ topic_ref: "new:5" }),
          respOp({ topic_ref: "new:0" }), // topics[0] は ref が null ではない
          respOp({ topic_ref: "k1", option_ref: "new:3" }),
          respOp({ topic_ref: "k1", option_ref: "o99" }),
          respOp({ topic_ref: "k77" }),
        ],
        statements: [stmtOp({ topic_ref: "k1", option_ref: "new:7" })],
      }),
    });
    expect(r.dropped.map((d) => d.path)).toEqual([
      "topics[1]",
      "responses[0]",
      "responses[1]",
      "responses[2]",
      "responses[3]",
      "responses[4]",
      "statements[0]",
    ]);
    expect(r.dropped[0]?.reason).toBe(DROP_REASON.unknownRef);
    expect(counts(r.state)).toEqual(counts(base.state));
  });

  it("別の topic の option は参照できない", () => {
    const base = first();
    const two = applyPatch({
      ...base,
      ctx,
      patch: patch({ topics: [topicOp({ title: "懇親会", evidence: ["m6"] })] }),
    });
    // k2 の option は o3, o4。k1 の参照で o3 は使えない
    const r = applyPatch({
      ...two,
      ctx,
      patch: patch({ responses: [respOp({ topic_ref: "k1", option_ref: "o3" })] }),
    });
    expect(r.dropped.map((d) => d.path)).toEqual(["responses[0]"]);
  });
});

describe("applyPatch: 検証との結合", () => {
  it("引用が見つからない・根拠が無い項目は捨てずに needsReview を付ける", () => {
    const r = applyPatch({
      state: emptyAnalysisState(),
      nextSeq: {},
      ctx,
      patch: patch({
        topics: [topicOp()],
        responses: [respOp({ quote: "存在しない引用" })],
        todos: [todoOp({ evidence: ["m99"] })],
      }),
    });
    expect(r.state.responses[0]).toMatchObject({
      needsReview: true,
      reviewReasons: [REASON.quoteNotFound],
    });
    expect(r.state.todos[0]?.evidence).toEqual([]);
    expect(r.state.todos[0]?.reviewReasons).toContain(REASON.noEvidence);
  });

  it("参加者の表に無い人の回答は捨て、担当者は外して needsReview にする", () => {
    const r = applyPatch({
      state: emptyAnalysisState(),
      nextSeq: {},
      ctx,
      patch: patch({
        topics: [topicOp({ required_participants: ["p2", "p9"] })],
        responses: [respOp({ participant: "p9" })],
        todos: [todoOp({ assignee: "p9" })],
      }),
    });
    expect(r.state.topics[0]?.requiredParticipants).toEqual(["p2"]);
    expect(r.state.topics[0]?.needsReview).toBe(true);
    expect(r.state.responses).toEqual([]);
    expect(r.dropped.map((d) => d.path)).toEqual(["responses[0]"]);
    expect(r.state.todos[0]).toMatchObject({ assignee: null, needsReview: true });
  });

  it("不正な日付は null にする", () => {
    const r = applyPatch({
      state: emptyAnalysisState(),
      nextSeq: {},
      ctx,
      patch: patch({ todos: [todoOp({ due_iso: "2026-02-30", due_text: "2/30" })] }),
    });
    expect(r.state.todos[0]).toMatchObject({ dueIso: null, dueText: "2/30", needsReview: true });
  });
});

describe("applyPatch: 回答の置き換え（supersededBy）", () => {
  it("同じ参加者・同じ topic の新しい回答が、古い回答を置き換える", () => {
    const base = first();
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        responses: [
          respOp({
            evidence: ["m3"],
            quote: "29日でお願いします",
            topic_ref: "k1",
            option_ref: "o2",
          }),
        ],
      }),
    });
    expect(r.state.responses.map((x) => [x.id, x.optionId, x.supersededBy])).toEqual([
      ["r1", "o1", "r2"],
      ["r2", "o2", null],
    ]);
  });

  it("別の参加者の回答は置き換えない", () => {
    const base = first();
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        responses: [respOp({ topic_ref: "k1", option_ref: "o1", participant: "p3" })],
      }),
    });
    expect(r.state.responses.every((x) => x.supersededBy === null)).toBe(true);
  });

  it("最新の回答より前の発言を根拠にする回答は、最新を置き換えない", () => {
    const base = applyPatch({
      state: emptyAnalysisState(),
      nextSeq: {},
      ctx,
      patch: patch({
        topics: [topicOp()],
        responses: [respOp({ evidence: ["m3"], quote: "29日でお願いします", option_ref: "new:1" })],
      }),
    });
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({ responses: [respOp({ topic_ref: "k1", option_ref: "o1" })] }),
    });
    expect(r.state.responses.map((x) => [x.id, x.supersededBy])).toEqual([
      ["r1", null],
      ["r2", "r1"],
    ]);
  });
});

describe("applyPatch: close", () => {
  it("todo と question を閉じる", () => {
    const base = first();
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        close: [
          { ref: "t1", evidence: ["m6"], reason: "done" },
          { ref: "q1", evidence: ["m6"], reason: "resolved" },
        ],
      }),
    });
    expect(r.state.todos[0]?.closed).toBe(true);
    expect(r.state.questions[0]?.closed).toBe(true);
    const marks = diffMarks(base.state, r.state, ["p1", "p2", "p3"]);
    expect([...marks]).toEqual([
      ["t1", "done"],
      ["q1", "done"],
    ]);
  });

  it("topic・option・回答の close、実在しない ID、根拠の無い close は捨てる", () => {
    const base = first();
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        close: [
          { ref: "k1", evidence: ["m6"], reason: "x" },
          { ref: "o1", evidence: ["m6"], reason: "x" },
          { ref: "r1", evidence: ["m6"], reason: "x" },
          { ref: "t99", evidence: ["m6"], reason: "x" },
          { ref: "t1", evidence: ["m99"], reason: "x" },
        ],
      }),
    });
    expect(r.dropped.map((d) => d.reason)).toEqual([
      DROP_REASON.unknownRef,
      DROP_REASON.unknownRef,
      DROP_REASON.unknownRef,
      DROP_REASON.unknownRef,
      DROP_REASON.noEvidence,
    ]);
    expect(r.state).toEqual(base.state);
  });

  it("V5: 実在しない todo・question・topic の ref の更新は捨てる", () => {
    const base = first();
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        topics: [topicOp({ ref: "k9" })],
        todos: [todoOp({ ref: "t9" })],
        questions: [questionOp({ ref: "q9" })],
      }),
    });
    expect(r.dropped.map((d) => d.path)).toEqual(["topics[0]", "todos[0]", "questions[0]"]);
    expect(r.state).toEqual(base.state);
  });
});

describe("applyPatch: 採番", () => {
  it("nextSeq が古くても、既存の ID と衝突しない番号を振る", () => {
    const base = first();
    const r = applyPatch({
      state: base.state,
      nextSeq: { k: 0 },
      ctx,
      patch: patch({ topics: [topicOp({ title: "懇親会", evidence: ["m6"], options: [] })] }),
    });
    expect(r.state.topics.map((t) => t.id)).toEqual(["k1", "k2"]);
    expect(r.nextSeq.k).toBe(2);
  });

  it("patch が参照する実在しない ID は採番で避ける（2 回目の適用でその参照が別の項目を指さない）", () => {
    const p = patch({
      questions: [questionOp({ ref: "q1", text: "場所" }), questionOp({ text: "人数" })],
    });
    const once = applyPatch({ state: emptyAnalysisState(), nextSeq: {}, ctx, patch: p });
    expect(once.state.questions.map((q) => q.id)).toEqual(["q2"]);
    const twice = applyPatch({ ...once, ctx, patch: p });
    expect(twice.state).toEqual(once.state);
  });

  it("同じ項目への ref の更新と、本文が同じ ref: null の項目が同じ patch にあっても、2 回目で増えない", () => {
    const base = first();
    const p = patch({
      questions: [questionOp(), questionOp({ ref: "q1", evidence: ["m1"], text: "人数" })],
    });
    const once = applyPatch({ ...base, ctx, patch: p });
    const twice = applyPatch({ ...once, ctx, patch: p });
    expect(twice.state).toEqual(once.state);
  });

  it("同じ patch を 2 回適用しても項目は増えず、状態も変わらない", () => {
    const once = first();
    const twice = applyPatch({ ...once, ctx, patch: FIRST });
    expect(twice.state).toEqual(once.state);
    expect(twice.nextSeq).toEqual(once.nextSeq);
  });
});

describe("merge と decide の結合（D2）", () => {
  it("確定の発言の後の取り消し・変更は、最新の発言に従う", () => {
    const speakers = ["p1", "p2", "p3"];
    let s = first();
    s = applyPatch({ ...s, ctx, patch: patch({ statements: [stmtOp()] }) });
    expect(decide(s.state, speakers).get("k1")).toMatchObject({
      status: "decided",
      decidedOptionId: "o1",
    });
    s = applyPatch({
      ...s,
      ctx,
      patch: patch({
        statements: [
          stmtOp({
            evidence: ["m6"],
            quote: "場所はどこにしますか",
            option_ref: null,
            text: "保留",
          }),
        ],
      }),
    });
    expect(decide(s.state, speakers).get("k1")?.status).toBe("open");
  });
});

describe("diffMarks", () => {
  it("追加は new、内容や判定の変化は changed", () => {
    const base = first();
    const all = diffMarks(emptyAnalysisState(), base.state, ["p1"]);
    expect([...all.entries()]).toEqual([
      ["k1", "new"],
      ["t1", "new"],
      ["q1", "new"],
    ]);
    const r = applyPatch({
      ...base,
      ctx,
      patch: patch({
        responses: [respOp({ topic_ref: "k1", option_ref: "o1", participant: "p3" })],
        todos: [todoOp({ ref: "t1", due_iso: "2026-10-30", due_text: "10/30" })],
      }),
    });
    expect([...diffMarks(base.state, r.state, ["p1", "p2", "p3"]).entries()]).toEqual([
      ["k1", "changed"],
      ["t1", "changed"],
    ]);
    expect(diffMarks(r.state, r.state, ["p1"]).size).toBe(0);
  });
});

describe("summaryChanged（まとめの変化。ToDo の変化は含めない）", () => {
  const overviewItem = (id: string, text: string) => ({
    id,
    text,
    quote: "引用",
    evidence: [ts(1)],
    needsReview: false,
    reviewReasons: [],
  });
  const changed = (before: AnalysisState, after: AnalysisState) =>
    summaryChanged(before, after, diffMarks(before, after, ["p1", "p2", "p3"]));

  it("同じ状態なら変化なし", () => {
    const s = first().state;
    expect(changed(s, structuredClone(s))).toBe(false);
  });

  it("概要の追加・text の変化・削除は変化、根拠だけの違いは変化にしない", () => {
    const base = first().state;
    const withV: AnalysisState = { ...structuredClone(base), overview: [overviewItem("v1", "A")] };
    expect(changed(base, withV)).toBe(true);
    expect(changed(withV, { ...structuredClone(withV), overview: [overviewItem("v1", "B")] })).toBe(
      true,
    );
    expect(changed(withV, { ...structuredClone(withV), overview: [] })).toBe(true);
    const evidenceOnly = structuredClone(withV);
    (evidenceOnly.overview ?? [])[0]?.evidence.push(ts(2));
    expect(changed(withV, evidenceOnly)).toBe(false);
  });

  it("ToDo だけの変化は、まとめの変化にしない（印は付く）", () => {
    const base = first().state;
    const r = applyPatch({
      state: base,
      nextSeq: {},
      ctx,
      patch: patch({ todos: [todoOp({ ref: "t1", due_iso: "2026-10-30", due_text: "10/30" })] }),
    });
    expect(diffMarks(base, r.state, ["p1"]).get("t1")).toBe("changed");
    expect(changed(base, r.state)).toBe(false);
  });

  it("決定事項・未決定事項と問いの変化、それらの削除は変化", () => {
    const base = first().state;
    const topicChanged = applyPatch({
      state: base,
      nextSeq: {},
      ctx,
      patch: patch({
        responses: [respOp({ topic_ref: "k1", option_ref: "o1", participant: "p3" })],
      }),
    });
    expect(changed(base, topicChanged.state)).toBe(true);
    const questionClosed = structuredClone(base);
    for (const q of questionClosed.questions) q.closed = true;
    expect(changed(base, questionClosed)).toBe(true);
    expect(changed(base, { ...structuredClone(base), topics: [] })).toBe(true);
    expect(changed(base, { ...structuredClone(base), questions: [] })).toBe(true);
  });
});

describe("carryOverIds（全体の処理し直し）", () => {
  it("本文と根拠が一致する項目は前回の ID を引き継ぎ、それ以外は前回の番号の続きを振る", () => {
    const prev = applyPatch({
      state: emptyAnalysisState(),
      nextSeq: {},
      ctx,
      patch: patch({
        topics: [topicOp({ title: "懇親会", evidence: ["m6"], options: [] }), topicOp()],
        responses: [respOp({ topic_ref: "new:1" })],
        todos: [todoOp({ text: "消える ToDo", evidence: ["m3"] }), todoOp()],
      }),
    });
    expect(prev.state.topics.map((t) => t.id)).toEqual(["k1", "k2"]);
    // 全体を処理し直した結果（新しい採番は k1 から）
    const next = applyPatch({
      state: emptyAnalysisState(),
      nextSeq: {},
      ctx,
      patch: patch({
        topics: [topicOp(), topicOp({ title: "新しい議題", evidence: ["m5"], options: [] })],
        responses: [respOp()],
        todos: [todoOp()],
      }),
    });
    const r = carryOverIds(prev.state, next.state, prev.nextSeq);
    expect(r.state.topics.map((t) => t.id)).toEqual(["k2", "k3"]);
    expect(r.state.topics[0]?.options.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(r.state.responses[0]).toMatchObject({ id: "r1", topicId: "k2", optionId: "o1" });
    // 消えた t1 の番号は使い回さない
    expect(r.state.todos.map((t) => t.id)).toEqual(["t2"]);
    expect(r.nextSeq).toMatchObject({ k: 3, t: 2 });
    expect(new Set(allIds(r.state)).size).toBe(allIds(r.state).length);
  });
});

// ---- 性質のテスト ----

const M_IDS = ["m1", "m2", "m3", "m4", "m5", "m6", "m99"];
const arbEvidence = fc.uniqueArray(fc.constantFrom(...M_IDS), { minLength: 1, maxLength: 2 });
const arbP = fc.constantFrom("p1", "p2", "p3", "p9");
const arbCert = fc.constantFrom("explicit" as const, "implied" as const, "uncertain" as const);
const arbQuote = fc.constantFrom(...TEXTS.map((t) => t.slice(0, 6)), "存在しない");
/** 存在しない ID は、採番で作られない大きな番号にする（実在しない ID を AI が返した場合）。 */
const arbTopicRef = fc.constantFrom("new:0", "new:1", "new:2", "k1", "k999");
const arbOptionRef = fc.option(fc.constantFrom("new:0", "new:1", "new:2", "o1", "o2", "o999"), {
  nil: null,
});

const arbPatch: fc.Arbitrary<Patch> = fc.record({
  overview: fc.constant([]),
  topics: fc.array(
    fc.record({
      ref: fc.option(fc.constantFrom("k1", "k999"), { nil: null }),
      evidence: arbEvidence,
      title: fc.constantFrom("日程", "場所", "予算"),
      required_participants: fc.subarray(["p1", "p2", "p3", "p9"]),
      options: fc.array(
        fc.record({
          ref: fc.option(fc.constantFrom("o1", "o2", "o999"), { nil: null }),
          evidence: arbEvidence,
          label: fc.constantFrom("A", "B", "C"),
          date_iso: fc.option(fc.constantFrom("2026-10-28", "2026-13-01"), { nil: null }),
        }),
        { maxLength: 3 },
      ),
    }),
    { maxLength: 3 },
  ),
  responses: fc.array(
    fc.record({
      evidence: arbEvidence,
      quote: arbQuote,
      topic_ref: arbTopicRef,
      option_ref: arbOptionRef,
      participant: arbP,
      answer: fc.constantFrom("yes" as const, "no" as const, "maybe" as const),
      certainty: arbCert,
    }),
    { maxLength: 6 },
  ),
  statements: fc.array(
    fc.record({
      evidence: arbEvidence,
      quote: arbQuote,
      topic_ref: arbTopicRef,
      option_ref: arbOptionRef,
      text: fc.constantFrom("確定", "取り消し"),
      certainty: arbCert,
    }),
    { maxLength: 3 },
  ),
  todos: fc.array(
    fc.record({
      ref: fc.option(fc.constantFrom("t1", "t999"), { nil: null }),
      evidence: arbEvidence,
      quote: arbQuote,
      text: fc.constantFrom("資料", "予約"),
      assignee: fc.option(arbP, { nil: null }),
      due_iso: fc.option(fc.constantFrom("2026-10-30", "2026-02-30"), { nil: null }),
      due_text: fc.option(fc.constantFrom("10/30(金)", "来週"), { nil: null }),
      certainty: arbCert,
    }),
    { maxLength: 3 },
  ),
  questions: fc.array(
    fc.record({
      ref: fc.option(fc.constantFrom("q1", "q999"), { nil: null }),
      evidence: arbEvidence,
      quote: arbQuote,
      text: fc.constantFrom("場所", "人数"),
    }),
    { maxLength: 2 },
  ),
  close: fc.array(
    fc.record({
      ref: fc.constantFrom("k1", "o1", "r1", "s1", "t1", "q1", "t999"),
      evidence: arbEvidence,
      reason: fc.constant("x"),
    }),
    { maxLength: 3 },
  ),
});

/** 前回の状態: 空か、k1(o1, o2)・r1・t1・q1 のある状態（s1 は無い）。 */
const arbBase = fc
  .boolean()
  .map((empty) =>
    empty
      ? applyPatch({ state: emptyAnalysisState(), nextSeq: {}, patch: patch({}), ctx })
      : first(),
  );

function maxSeq(ids: string[], prefix: string): number {
  return ids.reduce((m, id) => {
    const n = new RegExp(`^${prefix}(\\d+)$`).exec(id)?.[1];
    return n === undefined ? m : Math.max(m, Number(n));
  }, 0);
}

describe("applyPatch の性質", () => {
  it("同じ patch を 2 回適用しても項目が増えない", () => {
    fc.assert(
      fc.property(arbBase, arbPatch, (base, p) => {
        const once = applyPatch({ ...base, ctx, patch: p });
        const twice = applyPatch({ ...once, ctx, patch: p });
        expect(counts(twice.state)).toEqual(counts(once.state));
        expect(twice.state).toEqual(once.state);
      }),
      { numRuns: 500 },
    );
  });

  it("採番は nextSeq から単調に増え、ID は一意で、既存の ID は変わらない", () => {
    fc.assert(
      fc.property(arbBase, arbPatch, (base, p) => {
        const r = applyPatch({ ...base, ctx, patch: p });
        const ids = allIds(r.state);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of allIds(base.state)) expect(ids).toContain(id);
        for (const prefix of ["k", "o", "r", "s", "t", "q"]) {
          const before = base.nextSeq[prefix] ?? 0;
          const after = r.nextSeq[prefix] ?? 0;
          expect(after).toBeGreaterThanOrEqual(before);
          expect(maxSeq(ids, prefix)).toBeLessThanOrEqual(after);
          // 新しい ID は、前回の番号より大きい
          const fresh = ids.filter((id) => !allIds(base.state).includes(id));
          for (const id of fresh.filter((x) => x.startsWith(prefix))) {
            expect(Number(id.slice(1))).toBeGreaterThan(before);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("close は todo と question にだけ効き、他の項目を変えない", () => {
    fc.assert(
      fc.property(
        arbBase,
        fc.array(
          fc.record({
            ref: fc.constantFrom("k1", "o1", "o2", "r1", "t1", "q1", "t999"),
            evidence: arbEvidence,
            reason: fc.constant("x"),
          }),
        ),
        (base, close) => {
          const r = applyPatch({ ...base, ctx, patch: patch({ close }) });
          const strip = (s: AnalysisState) => ({
            ...s,
            todos: s.todos.map((t) => ({ ...t, closed: false })),
            questions: s.questions.map((q) => ({ ...q, closed: false })),
          });
          expect(strip(r.state)).toEqual(strip(base.state));
          for (const t of r.state.todos) {
            const closedNow = close.some(
              (c) => c.ref === t.id && c.evidence.some((m) => m !== "m99"),
            );
            expect(t.closed).toBe(closedNow);
          }
        },
      ),
    );
  });

  it("同じ参加者・同じ topic で、最新の回答（supersededBy が null）は 1 つだけ", () => {
    fc.assert(
      fc.property(arbBase, arbPatch, arbPatch, (base, p1, p2) => {
        const r1 = applyPatch({ ...base, ctx, patch: p1 });
        const r = applyPatch({ ...r1, ctx, patch: p2 });
        const latest = new Map<string, number>();
        for (const x of r.state.responses) {
          if (x.supersededBy !== null) continue;
          const key = `${x.participant}|${x.topicId}`;
          latest.set(key, (latest.get(key) ?? 0) + 1);
        }
        expect([...latest.values()].every((n) => n === 1)).toBe(true);
        // supersededBy は同じ参加者・同じ topic の回答を指す
        const byId = new Map(r.state.responses.map((x) => [x.id, x]));
        for (const x of r.state.responses) {
          if (x.supersededBy === null) continue;
          const to = byId.get(x.supersededBy);
          expect(to?.participant).toBe(x.participant);
          expect(to?.topicId).toBe(x.topicId);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("carryOverIds: 前回の状態に同じ patch を処理し直しても ID が全部引き継がれ、一意である", () => {
    fc.assert(
      fc.property(arbPatch, (p) => {
        const prev = applyPatch({ state: emptyAnalysisState(), nextSeq: {}, ctx, patch: p });
        const again = applyPatch({ state: emptyAnalysisState(), nextSeq: {}, ctx, patch: p });
        const r = carryOverIds(prev.state, again.state, prev.nextSeq);
        expect(r.state).toEqual(prev.state);
        const ids = allIds(r.state);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      { numRuns: 300 },
    );
  });
});
