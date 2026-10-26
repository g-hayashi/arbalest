import { describe, expect, it } from "vitest";
import {
  type ActualOutput,
  type ActualTheme,
  aggregate,
  aggregateFindings,
  checkThresholds,
  evidenceOverlaps,
  findingsCaseScore,
  normalizeForMatch,
  scoreCase,
  scoreFindings,
  scoreOverview,
  THRESHOLDS,
  toActualOutput,
  toActualThemes,
} from "../../eval/match.js";
import { emptyAnalysisState, type Participant } from "../../src/store/types.js";

describe("自然文依頼の評価閾値（002 SC-006/007）", () => {
  it("概要の要点は根拠と許容する表現で一対一に照合し、要確認は一致に数えない", () => {
    const score = scoreOverview(
      [
        { evidenceTs: ["1.1"], textIncludesAny: ["資料共有", "資料を配布"] },
        { evidenceTs: ["1.1"], textIncludesAny: ["資料共有"] },
        { evidenceTs: ["2.1"], textIncludesAny: ["相談"] },
      ],
      [
        {
          text: "資料を配布した",
          quote: "資料を配布した",
          evidenceTs: ["1.1"],
          needsReview: false,
        },
        { text: "相談した", quote: "相談した", evidenceTs: ["2.1"], needsReview: true },
        { text: "資料共有", quote: "資料共有", evidenceTs: ["8.1"], needsReview: false },
      ],
      new Map([
        ["1.1", "資料を配布した"],
        ["2.1", "相談した"],
        ["8.1", "資料共有"],
      ]),
    );
    expect(score.points).toEqual({ expected: 3, actual: 3, matched: 1 });
    expect(score.evidence).toEqual({ items: 3, passed: 2 });
  });

  it.each<[string[], string, number]>([
    [["1.1"], "資料を共有しました", 1],
    [["1.1"], "資料 を、共有しました。", 1],
    [["8.1"], "資料を共有しました", 0],
    [["1.1", "8.1"], "資料を共有しました", 0],
    [["1.1"], "確認されていない引用", 0],
    [["1.1"], "", 0],
    [["1.1"], "。 !", 0],
  ])("要確認フラグがfalseでも根拠%sと引用%sを元投稿へ直接照合する", (evidenceTs, quote, passed) => {
    const score = scoreOverview(
      [{ evidenceTs: ["1.1"], textIncludesAny: ["資料共有"] }],
      [{ text: "資料共有", quote, evidenceTs, needsReview: false }],
      new Map([["1.1", "資料を共有しました。"]]),
    );
    expect(score.evidence).toEqual({ items: 1, passed });
    expect(score.points.matched).toBe(passed);
  });

  it.each<[number, number, number, number, string[]]>([
    [1, 0.8, 19 / 20, 0, []],
    [0.99, 0.8, 19 / 20, 0, ["overviewEvidenceAccuracy"]],
    [1, 0.79, 19 / 20, 0, ["overviewRecall"]],
    [1, 0.8, 18 / 20, 0, ["requestAccuracy"]],
    [1, 0.8, 19 / 20, 1, ["unauthorizedEffects"]],
  ])("根拠=%s 要点=%s 意図・期間=%s 誤実行=%s", (evidence, recall, accuracy, effects, failed) => {
    const checks = checkThresholds({
      ...aggregate([]),
      overviewEvidenceAccuracy: evidence,
      overviewRecall: recall,
      requestAccuracy: accuracy,
      unauthorizedEffects: effects,
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(failed);
    expect(checks.map((c) => c.name)).toContain("requestAccuracy");
  });
});

const out = (over: Partial<ActualOutput> = {}): ActualOutput => ({
  decided: [],
  open: [],
  todos: [],
  items: [],
  ...over,
});

describe("一致の判定（contracts/eval.md#一致の判定）", () => {
  it("evidenceOverlaps: 根拠の ts が 1 つ以上重なれば一致", () => {
    expect(evidenceOverlaps(["1.1", "2.2"], ["2.2", "3.3"])).toBe(true);
    expect(evidenceOverlaps(["1.1"], ["2.2"])).toBe(false);
    expect(evidenceOverlaps([], ["2.2"])).toBe(false);
  });

  it("normalizeForMatch: 全角半角・空白・大文字小文字の違いを除く", () => {
    expect(normalizeForMatch("１０／２８ (水)  15:00")).toBe(normalizeForMatch("10/28(水) 15:00"));
  });

  it("決定事項: 根拠が重なり、選択肢の label が含まれるものが一致する", () => {
    const s = scoreCase(
      {
        decided: [{ optionLabelIncludes: "10/28", evidenceTs: ["1.1"] }],
      },
      out({
        decided: [
          { title: "定例の日程", optionLabel: "10/28(水) 15:00", evidenceTs: ["1.1", "2.2"] },
        ],
      }),
    );
    expect(s.decided).toEqual({ expected: 1, actual: 1, matched: 1 });
  });

  it("決定事項: 根拠が重ならない、または label が違うものは一致しない（適合率・再現率が下がる）", () => {
    const s = scoreCase(
      { decided: [{ optionLabelIncludes: "10/28", evidenceTs: ["1.1"] }] },
      out({
        decided: [
          { title: "A", optionLabel: "10/28(水)", evidenceTs: ["9.9"] },
          { title: "B", optionLabel: "10/29(木)", evidenceTs: ["1.1"] },
        ],
      }),
    );
    expect(s.decided).toEqual({ expected: 1, actual: 2, matched: 0 });
  });

  it("1 つの正解には、出力の 1 項目だけを対応させる", () => {
    const s = scoreCase(
      { decided: [{ optionLabelIncludes: "10/28", evidenceTs: ["1.1"] }] },
      out({
        decided: [
          { title: "A", optionLabel: "10/28(水)", evidenceTs: ["1.1"] },
          { title: "B", optionLabel: "10/28(水)", evidenceTs: ["1.1"] },
        ],
      }),
    );
    expect(s.decided).toEqual({ expected: 1, actual: 2, matched: 1 });
  });

  const todo = (over: Partial<ActualOutput["todos"][number]> = {}) => ({
    text: "会議室を予約する",
    assignee: "U1",
    due: "2026-10-27",
    evidenceTs: ["1.1"],
    ...over,
  });

  it("ToDo: 根拠・text・担当者・期限がすべて合えば一致", () => {
    const s = scoreCase(
      {
        todos: [{ textIncludes: "会議室", assignee: "U1", due: "2026-10-27", evidenceTs: ["1.1"] }],
      },
      out({ todos: [todo()] }),
    );
    expect(s.todos).toEqual({ expected: 1, actual: 1, matched: 1 });
    expect(s.assignee).toEqual({ asked: 1, correct: 1 });
    expect(s.due).toEqual({ asked: 1, correct: 1 });
  });

  it("ToDo: 担当者が違えば一致せず、担当者の正解率だけが下がる（期限は合っている）", () => {
    const s = scoreCase(
      {
        todos: [{ textIncludes: "会議室", assignee: "U1", due: "2026-10-27", evidenceTs: ["1.1"] }],
      },
      out({ todos: [todo({ assignee: "U2" })] }),
    );
    expect(s.todos).toEqual({ expected: 1, actual: 1, matched: 0 });
    expect(s.assignee).toEqual({ asked: 1, correct: 0 });
    expect(s.due).toEqual({ asked: 1, correct: 1 });
  });

  it("ToDo: 担当者なし（null）が正解のとき、担当者が付いていたら誤り。指定がなければ問わない", () => {
    const wrong = scoreCase(
      { todos: [{ textIncludes: "会議室", assignee: null, evidenceTs: ["1.1"] }] },
      out({ todos: [todo()] }),
    );
    expect(wrong.assignee).toEqual({ asked: 1, correct: 0 });
    expect(wrong.due).toEqual({ asked: 0, correct: 0 });
    const ok = scoreCase(
      { todos: [{ textIncludes: "会議室", assignee: null, evidenceTs: ["1.1"] }] },
      out({ todos: [todo({ assignee: null })] }),
    );
    expect(ok.assignee).toEqual({ asked: 1, correct: 1 });
    expect(ok.todos.matched).toBe(1);
    const dontCare = scoreCase(
      { todos: [{ textIncludes: "会議室", evidenceTs: ["1.1"] }] },
      out({ todos: [todo({ assignee: "U9", due: null })] }),
    );
    expect(dontCare.todos.matched).toBe(1);
  });

  it("ToDo: 出力に無い正解は、担当者・期限の正解率では誤りに数える", () => {
    const s = scoreCase(
      {
        todos: [{ textIncludes: "会議室", assignee: "U1", due: "2026-10-27", evidenceTs: ["1.1"] }],
      },
      out(),
    );
    expect(s.todos).toEqual({ expected: 1, actual: 0, matched: 0 });
    expect(s.assignee).toEqual({ asked: 1, correct: 0 });
    expect(s.due).toEqual({ asked: 1, correct: 0 });
  });

  it("mustNotDecide: 決定にしてはいけない topic が決定になっていたら違反。正解の open も同じ", () => {
    const s = scoreCase(
      { mustNotDecide: ["会場"], open: [{ topic: "懇親会" }] },
      out({
        decided: [
          { title: "会場の選定", optionLabel: "オンライン", evidenceTs: ["1.1"] },
          { title: "懇親会の日程", optionLabel: "11/1", evidenceTs: ["2.2"] },
          { title: "定例の日程", optionLabel: "10/28", evidenceTs: ["3.3"] },
        ],
      }),
    );
    expect(s.violations).toEqual(["会場の選定", "懇親会の日程"]);
  });

  it("回答待ちの人: 正解の pending と一致するかを数える（参考値）", () => {
    const s = scoreCase(
      { open: [{ topic: "会場", pending: ["U3", "U4"] }] },
      out({ open: [{ title: "会場", pending: ["U4", "U3"] }] }),
    );
    expect(s.pending).toEqual({ asked: 1, correct: 1 });
    const bad = scoreCase(
      { open: [{ topic: "会場", pending: ["U3", "U4"] }] },
      out({ open: [{ title: "会場", pending: ["U3"] }] }),
    );
    expect(bad.pending).toEqual({ asked: 1, correct: 0 });
  });

  it("根拠と検証: 根拠のない項目と、要確認の項目を数える", () => {
    const s = scoreCase(
      {},
      out({
        items: [
          { evidenceTs: ["1.1"], needsReview: false },
          { evidenceTs: ["1.1"], needsReview: true },
          { evidenceTs: [], needsReview: true },
        ],
      }),
    );
    expect(s.evidence).toEqual({ items: 3, withEvidence: 2 });
    expect(s.verify).toEqual({ items: 3, passed: 1 });
  });
});

describe("toActualOutput", () => {
  const participants: Participant[] = [
    { id: "p1", userId: "U1", name: "田中" },
    { id: "p2", userId: "U2", name: "佐藤" },
  ];

  it("状態から、決定・未決定・ToDo（閉じていないもの）を取り出す", () => {
    const state = emptyAnalysisState();
    state.topics.push({
      id: "k1",
      title: "定例の日程",
      evidence: ["1.1"],
      requiredParticipants: ["p2"],
      options: [
        {
          id: "o1",
          label: "10/28(水)",
          dateIso: "2026-10-28",
          evidence: ["1.1"],
          needsReview: false,
          reviewReasons: [],
        },
      ],
      needsReview: false,
      reviewReasons: [],
    });
    state.responses.push({
      id: "r1",
      topicId: "k1",
      optionId: "o1",
      participant: "p2",
      answer: "yes",
      certainty: "explicit",
      evidence: ["2.2"],
      quote: "大丈夫です",
      supersededBy: null,
      needsReview: false,
      reviewReasons: [],
    });
    state.topics.push({
      id: "k2",
      title: "会場",
      evidence: ["1.1"],
      requiredParticipants: ["p2"],
      options: [],
      needsReview: false,
      reviewReasons: [],
    });
    state.todos.push(
      {
        id: "t1",
        text: "予約する",
        assignee: "p1",
        dueIso: "2026-10-27",
        dueText: null,
        certainty: "explicit",
        evidence: ["3.3"],
        quote: "予約します",
        closed: false,
        needsReview: false,
        reviewReasons: [],
      },
      {
        id: "t2",
        text: "閉じた",
        assignee: null,
        dueIso: null,
        dueText: null,
        certainty: "explicit",
        evidence: ["3.3"],
        quote: "x",
        closed: true,
        needsReview: false,
        reviewReasons: [],
      },
    );

    const o = toActualOutput(state, participants, ["p1", "p2"]);

    expect(o.decided).toHaveLength(1);
    expect(o.decided[0]).toMatchObject({ title: "定例の日程", optionLabel: "10/28(水)" });
    expect(o.decided[0]?.evidenceTs).toEqual(expect.arrayContaining(["1.1", "2.2"]));
    expect(o.open).toEqual([{ title: "会場", pending: ["U2"] }]);
    expect(o.todos).toEqual([
      { text: "予約する", assignee: "U1", due: "2026-10-27", evidenceTs: ["3.3"] },
    ]);
    // 項目（topic、閉じていない todo）ごとの根拠と要確認
    expect(o.items).toHaveLength(3);
  });
});

describe("指標と閾値（contracts/eval.md#指標）", () => {
  const perfect = {
    decided: { expected: 2, actual: 2, matched: 2 },
    todos: { expected: 2, actual: 2, matched: 2 },
    assignee: { asked: 2, correct: 2 },
    due: { asked: 2, correct: 2 },
    pending: { asked: 0, correct: 0 },
    violations: [],
    evidence: { items: 4, withEvidence: 4 },
    verify: { items: 4, passed: 4 },
  };

  it("全ケースを合算して、適合率・再現率・正解率を出す", () => {
    const m = aggregate([
      perfect,
      { ...perfect, decided: { expected: 2, actual: 4, matched: 1 }, violations: ["会場"] },
    ]);
    expect(m.decidedPrecision).toBeCloseTo(3 / 6);
    expect(m.decidedRecall).toBeCloseTo(3 / 4);
    expect(m.todoPrecision).toBe(1);
    expect(m.assigneeAccuracy).toBe(1);
    expect(m.mustNotDecideViolations).toBe(1);
    expect(m.evidenceCoverage).toBe(1);
  });

  it("分母が 0 の指標は 1 にする（出力も正解も無いのは正しい）", () => {
    const m = aggregate([
      {
        ...perfect,
        decided: { expected: 0, actual: 0, matched: 0 },
        assignee: { asked: 0, correct: 0 },
      },
    ]);
    expect(m.decidedPrecision).toBe(1);
    expect(m.decidedRecall).toBe(1);
    expect(m.assigneeAccuracy).toBe(1);
  });

  it("閾値は SC-002〜SC-005 のとおり", () => {
    expect(THRESHOLDS).toMatchObject({
      decidedPrecision: 0.9,
      decidedRecall: 0.8,
      todoPrecision: 0.85,
      todoRecall: 0.8,
      assigneeAccuracy: 0.8,
      dueAccuracy: 0.8,
      mustNotDecideViolations: 0,
      evidenceCoverage: 1,
    });
  });

  it("閾値を下回った指標を失敗として返す。ちょうどなら合格", () => {
    const ok = checkThresholds(aggregate([perfect]));
    expect(ok.every((c) => c.ok)).toBe(true);

    const m = aggregate([perfect]);
    const checks = checkThresholds({
      ...m,
      decidedRecall: 0.8,
      todoPrecision: 0.84,
      mustNotDecideViolations: 1,
    });
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed.sort()).toEqual(["mustNotDecideViolations", "todoPrecision"]);
  });
});

// ---- findings（US4。contracts/eval.md、expected.themes） ----

const actualTheme = (
  evidenceTs: string[],
  findings: { evidenceTs: string[]; needsReview: boolean }[] = [{ evidenceTs, needsReview: false }],
  theme = "t",
): ActualTheme => ({ theme, evidenceTs, findings });

describe("findings の一致の判定（expected.themes）", () => {
  it("テーマは、根拠の ts が 1 つ以上重なるものが一致する（テーマ名は問わない）", () => {
    const s = scoreFindings(
      [{ theme: "備品", evidenceTs: ["1.1", "2.1"] }, { evidenceTs: ["5.1"] }],
      [actualTheme(["2.1", "3.1"], undefined, "別の名前"), actualTheme(["9.1"])],
    );
    expect(s.themes).toEqual({ expected: 2, actual: 2, matched: 1 });
  });

  it("1 つの正解には、出力の 1 つのテーマだけを対応させる（全部をまとめた 1 テーマは、正解 1 件にしか一致しない）", () => {
    const s = scoreFindings(
      [{ evidenceTs: ["1.1"] }, { evidenceTs: ["2.1"] }, { evidenceTs: ["3.1"] }],
      [actualTheme(["1.1", "2.1", "3.1"])],
    );
    expect(s.themes).toEqual({ expected: 3, actual: 1, matched: 1 });
    // 1 つの正解を 2 つのテーマに分けても、一致は 1 つで、出力が余る（適合率が下がる）
    const split = scoreFindings(
      [{ evidenceTs: ["1.1", "2.1"] }],
      [actualTheme(["1.1"]), actualTheme(["2.1"])],
    );
    expect(split.themes).toEqual({ expected: 1, actual: 2, matched: 1 });
  });

  it("正解にない出力は適合率を下げ、出力にない正解は再現率を下げる。どちらも無ければ 1", () => {
    const none = aggregateFindings([scoreFindings([], [])]);
    expect(none).toEqual({ themePrecision: 1, themeRecall: 1 });
    const m = aggregateFindings([
      scoreFindings(
        [{ evidenceTs: ["1.1"] }, { evidenceTs: ["2.1"] }],
        [actualTheme(["1.1"]), actualTheme(["8.1"])],
      ),
      scoreFindings([], []),
    ]);
    expect(m.themePrecision).toBeCloseTo(1 / 2);
    expect(m.themeRecall).toBeCloseTo(1 / 2);
  });

  it("根拠と検証は Finding ごとに数える（根拠のない Finding、要確認の Finding）", () => {
    const s = scoreFindings(
      [],
      [
        actualTheme(
          ["1.1"],
          [
            { evidenceTs: ["1.1"], needsReview: false },
            { evidenceTs: [], needsReview: true },
          ],
        ),
      ],
    );
    expect(s.evidence).toEqual({ items: 2, withEvidence: 1 });
    expect(s.verify).toEqual({ items: 2, passed: 1 });
  });

  it("toActualThemes: テーマの根拠は Finding の根拠の和集合", () => {
    const themes = toActualThemes([
      {
        theme: "備品",
        findings: [
          { statement: "a", evidence: ["1.1", "2.1"], needsReview: false, reviewReasons: [] },
          { statement: "b", evidence: ["2.1", "3.1"], needsReview: true, reviewReasons: ["x"] },
        ],
      },
    ]);
    expect(themes).toEqual([
      {
        theme: "備品",
        evidenceTs: ["1.1", "2.1", "3.1"],
        findings: [
          { evidenceTs: ["1.1", "2.1"], needsReview: false },
          { evidenceTs: ["2.1", "3.1"], needsReview: true },
        ],
      },
    ]);
  });

  it("findings のケースの CaseScore は、決定・ToDo を持たず、根拠と検証だけを SC-004 に足す", () => {
    const s = findingsCaseScore(
      scoreFindings([], [actualTheme(["1.1"], [{ evidenceTs: [], needsReview: true }])]),
    );
    expect(s.decided).toEqual({ expected: 0, actual: 0, matched: 0 });
    expect(s.todos).toEqual({ expected: 0, actual: 0, matched: 0 });
    expect(s.violations).toEqual([]);
    expect(s.evidence).toEqual({ items: 1, withEvidence: 0 });
    expect(aggregate([s]).evidenceCoverage).toBe(0);
  });
});
