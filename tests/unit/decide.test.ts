import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, decideTopic, toSummaryModel } from "../../src/analysis/decide.js";
import type {
  AnalysisState,
  Certainty,
  OptionItem,
  ResponseItem,
  StatementItem,
  TodoItem,
  TopicItem,
} from "../../src/store/types.js";

// ---- 組み立ての補助 ----

const ok = { needsReview: false, reviewReasons: [] as string[] };

/** 2026-10-23 の ts（分を足して前後を作る）。 */
const ts = (minute: number) => `${1792890000 + minute * 60}.000100`;

function option(id: string, label = id): OptionItem {
  return { id, label, dateIso: null, evidence: [ts(0)], ...ok };
}

function topic(required: string[], options = ["o1", "o2"]): TopicItem {
  return {
    id: "k1",
    title: "定例の日程",
    evidence: [ts(0)],
    requiredParticipants: required,
    options: options.map((o) => option(o)),
    ...ok,
  };
}

let seq = 0;
function resp(
  participant: string,
  optionId: string | null,
  answer: ResponseItem["answer"] = "yes",
  certainty: Certainty = "explicit",
  extra: Partial<ResponseItem> = {},
): ResponseItem {
  seq += 1;
  return {
    id: `r${seq}`,
    topicId: "k1",
    optionId,
    participant,
    answer,
    certainty,
    evidence: [ts(seq)],
    quote: "",
    supersededBy: null,
    ...ok,
    ...extra,
  };
}

function stmt(
  optionId: string | null,
  certainty: Certainty,
  minute: number,
  extra: Partial<StatementItem> = {},
): StatementItem {
  seq += 1;
  return {
    id: `s${seq}`,
    topicId: "k1",
    optionId,
    text: "確定",
    certainty,
    evidence: [ts(minute)],
    quote: "",
    ...ok,
    ...extra,
  };
}

function state(
  t: TopicItem,
  responses: ResponseItem[] = [],
  statements: StatementItem[] = [],
): AnalysisState {
  return { topics: [t], responses, statements, todos: [], questions: [] };
}

const SPEAKERS = ["p1", "p2", "p3"];

// ---- D1〜D6 ----

describe("decide: D3 全員の合意", () => {
  it("必要な参加者全員の最新の回答が同じ option に yes（uncertain でない）なら decided", () => {
    const s = state(topic(["p2", "p3"]), [resp("p2", "o1"), resp("p3", "o1", "yes", "implied")]);
    const d = decideTopic(s, s.topics[0] as TopicItem, SPEAKERS);
    expect(d).toMatchObject({ status: "decided", decidedOptionId: "o1", pendingParticipants: [] });
    expect(d.basis.sort()).toEqual(s.responses.map((r) => r.id).sort());
  });

  it("yes の option が人によって違えば open", () => {
    const s = state(topic(["p2", "p3"]), [resp("p2", "o1"), resp("p3", "o2")]);
    expect(decide(s, SPEAKERS).get("k1")?.status).toBe("open");
  });

  it("optionId が null の yes（どれでも）は合意に数えない", () => {
    const s = state(topic(["p2", "p3"]), [resp("p2", "o1"), resp("p3", null)]);
    expect(decide(s, SPEAKERS).get("k1")?.status).toBe("open");
  });

  it("topic に無い option への yes は数えない", () => {
    const s = state(topic(["p2"]), [resp("p2", "o9")]);
    expect(decide(s, SPEAKERS).get("k1")?.status).toBe("open");
  });

  it("supersededBy が null の回答だけを使う（後の no が前の yes を打ち消す）", () => {
    const later = resp("p3", "o1", "no");
    const earlier = resp("p3", "o1", "yes", "explicit", { supersededBy: later.id });
    const s = state(topic(["p2", "p3"]), [resp("p2", "o1"), earlier, later]);
    const d = decide(s, SPEAKERS).get("k1");
    expect(d?.status).toBe("open");
  });
});

describe("decide: D1 必要な参加者", () => {
  it("requiredParticipants が空なら、発言した人全員を使う", () => {
    const s = state(topic([]), [resp("p1", "o1"), resp("p2", "o1")]);
    const d = decide(s, SPEAKERS).get("k1");
    expect(d).toMatchObject({ status: "open", pendingParticipants: ["p3"] });
    s.responses.push(resp("p3", "o1"));
    expect(decide(s, SPEAKERS).get("k1")?.status).toBe("decided");
  });

  it("必要な参加者が 0 人（required も発言者も空）なら決して decided にしない", () => {
    const s = state(topic([]), [resp("p1", "o1")]);
    expect(decide(s, []).get("k1")?.status).toBe("open");
  });
});

describe("decide: D4 あいまいな回答、D5 回答が残っている人", () => {
  it("uncertain の yes は決定にせず、回答待ちに残す", () => {
    const s = state(topic(["p2", "p3"]), [resp("p2", "o1"), resp("p3", "o1", "yes", "uncertain")]);
    expect(decide(s, SPEAKERS).get("k1")).toMatchObject({
      status: "open",
      decidedOptionId: null,
      pendingParticipants: ["p3"],
    });
  });

  it("回答が無い人と maybe の人は回答待ち、no の人は回答済み", () => {
    const s = state(topic(["p1", "p2", "p3"]), [resp("p2", "o1", "no"), resp("p3", "o1", "maybe")]);
    expect(decide(s, SPEAKERS).get("k1")?.pendingParticipants).toEqual(["p1", "p3"]);
  });
});

describe("decide: D2 明示的な確定", () => {
  it("explicit で optionId を持つ発言があれば、回答がなくても decided", () => {
    const s = state(topic(["p2", "p3"]), [], [stmt("o2", "explicit", 5)]);
    expect(decide(s, SPEAKERS).get("k1")).toMatchObject({
      status: "decided",
      decidedOptionId: "o2",
      pendingParticipants: [],
    });
  });

  it("implied や uncertain の確定の発言では決めない", () => {
    const s = state(topic(["p2"]), [], [stmt("o1", "implied", 5), stmt("o2", "uncertain", 6)]);
    expect(decide(s, SPEAKERS).get("k1")?.status).toBe("open");
  });

  it("確定の後に別の option の explicit があれば、最新に従う", () => {
    const s = state(topic(["p2"]), [], [stmt("o1", "explicit", 5), stmt("o2", "explicit", 9)]);
    expect(decide(s, SPEAKERS).get("k1")?.decidedOptionId).toBe("o2");
  });

  it("並びではなく発言の時刻で最新を決める", () => {
    const s = state(topic(["p2"]), [], [stmt("o2", "explicit", 9), stmt("o1", "explicit", 5)]);
    expect(decide(s, SPEAKERS).get("k1")?.decidedOptionId).toBe("o2");
  });

  it("確定の後の取り消し（optionId が null）で open に戻り、取り消し前の合意でも決めない", () => {
    const s = state(
      topic(["p2", "p3"]),
      [resp("p2", "o1"), resp("p3", "o1")],
      [stmt("o1", "explicit", 50), stmt(null, "explicit", 60)],
    );
    const d = decide(s, SPEAKERS).get("k1");
    expect(d).toMatchObject({ status: "open", pendingParticipants: ["p2", "p3"] });
  });

  it("確定の後の、別の option への explicit でない変更でも、その確定は無効になる", () => {
    const s = state(topic(["p2"]), [], [stmt("o1", "explicit", 5), stmt("o2", "implied", 9)]);
    expect(decide(s, SPEAKERS).get("k1")?.status).toBe("open");
  });

  it("確定の後の、同じ option への発言は確定を変えない", () => {
    const s = state(topic(["p2"]), [], [stmt("o1", "explicit", 5), stmt("o1", "uncertain", 9)]);
    expect(decide(s, SPEAKERS).get("k1")?.decidedOptionId).toBe("o1");
  });

  it("取り消しの後の回答で全員が合意すれば decided（D3）", () => {
    const s = state(topic(["p2"]), [], [stmt("o1", "explicit", 5), stmt(null, "explicit", 6)]);
    s.responses.push(resp("p2", "o2", "yes", "explicit", { evidence: [ts(7)] }));
    expect(decide(s, SPEAKERS).get("k1")).toMatchObject({
      status: "decided",
      decidedOptionId: "o2",
    });
  });
});

describe("decide: D6 要確認の伝播", () => {
  it("決定の根拠の回答が needsReview なら topic も needsReview", () => {
    const s = state(topic(["p2"]), [resp("p2", "o1", "yes", "explicit", { needsReview: true })]);
    expect(decide(s, SPEAKERS).get("k1")).toMatchObject({ status: "decided", needsReview: true });
  });

  it("決定の根拠の発言が needsReview なら topic も needsReview", () => {
    const s = state(topic(["p2"]), [], [stmt("o1", "explicit", 5, { needsReview: true })]);
    expect(decide(s, SPEAKERS).get("k1")?.needsReview).toBe(true);
  });

  it("根拠にならない項目の needsReview は伝播しない", () => {
    const s = state(
      topic(["p2"]),
      [resp("p2", "o1")],
      [stmt("o2", "implied", 1, { needsReview: true })],
    );
    expect(decide(s, SPEAKERS).get("k1")).toMatchObject({ status: "decided", needsReview: false });
  });
});

// ---- 性質のテスト ----

const PARTICIPANTS = ["p1", "p2", "p3", "p4"];
const OPTIONS = ["o1", "o2", "o3"];

const arbResponse = fc.record({
  participant: fc.constantFrom(...PARTICIPANTS),
  optionId: fc.option(fc.constantFrom(...OPTIONS, "o9"), { nil: null }),
  answer: fc.constantFrom("yes" as const, "no" as const, "maybe" as const),
  certainty: fc.constantFrom("explicit" as const, "implied" as const, "uncertain" as const),
  minute: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }),
  superseded: fc.boolean(),
  needsReview: fc.boolean(),
});

const arbStatement = fc.record({
  optionId: fc.option(fc.constantFrom(...OPTIONS), { nil: null }),
  certainty: fc.constantFrom("explicit" as const, "implied" as const, "uncertain" as const),
  minute: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }),
});

const arbState = fc.record({
  required: fc.subarray(PARTICIPANTS),
  speakers: fc.subarray(PARTICIPANTS),
  responses: fc.array(arbResponse, { maxLength: 12 }),
  statements: fc.array(arbStatement, { maxLength: 4 }),
});

function buildState(
  g: Omit<typeof arbState extends fc.Arbitrary<infer T> ? T : never, "speakers">,
): AnalysisState {
  const responses: ResponseItem[] = g.responses.map((r, i) => ({
    id: `r${i + 1}`,
    topicId: "k1",
    optionId: r.optionId,
    participant: r.participant,
    answer: r.answer,
    certainty: r.certainty,
    evidence: r.minute === null ? [] : [ts(r.minute)],
    quote: "",
    // supersededBy は任意（壊れた状態も含めて試す）
    supersededBy: r.superseded ? "r999" : null,
    needsReview: r.needsReview,
    reviewReasons: [],
  }));
  const statements: StatementItem[] = g.statements.map((s, i) => ({
    id: `s${i + 1}`,
    topicId: "k1",
    optionId: s.optionId,
    text: "",
    certainty: s.certainty,
    evidence: s.minute === null ? [] : [ts(s.minute)],
    quote: "",
    ...ok,
  }));
  return state(topic(g.required, OPTIONS), responses, statements);
}

/** テスト側の独立した判定: p の最新の回答が、すべて option に対する有効な yes か。 */
function hasValidYes(s: AnalysisState, p: string, optionId: string): boolean {
  const latest = s.responses.filter(
    (r) => r.topicId === "k1" && r.participant === p && r.supersededBy === null,
  );
  return (
    latest.length > 0 &&
    latest.every(
      (r) => r.answer === "yes" && r.certainty !== "uncertain" && r.optionId === optionId,
    )
  );
}

describe("decide の性質", () => {
  it("SC-005: explicit の確定がなく、必要な参加者に有効な yes がない人がいれば、決して decided にならない", () => {
    fc.assert(
      fc.property(arbState, (g) => {
        const s = buildState(g);
        const d = decide(s, g.speakers).get("k1");
        if (d === undefined) return false;
        const hasExplicit = s.statements.some(
          (st) => st.certainty === "explicit" && st.optionId !== null,
        );
        const required = g.required.length > 0 ? g.required : g.speakers;
        if (d.status !== "decided") return d.decidedOptionId === null;
        if (d.decidedOptionId === null) return false;
        if (hasExplicit) {
          // explicit の確定のどれか、または全員の合意に一致する
          const fromStatement = s.statements.some(
            (st) => st.certainty === "explicit" && st.optionId === d.decidedOptionId,
          );
          const fromConsensus =
            required.length > 0 &&
            required.every((p) => hasValidYes(s, p, d.decidedOptionId as string));
          return fromStatement || fromConsensus;
        }
        const optionId = d.decidedOptionId;
        return required.length > 0 && required.every((p) => hasValidYes(s, p, optionId));
      }),
      { numRuns: 2000 },
    );
  });

  it("decided なら回答待ちは空、open なら回答待ちは必要な参加者の部分集合", () => {
    fc.assert(
      fc.property(arbState, (g) => {
        const s = buildState(g);
        const d = decide(s, g.speakers).get("k1");
        const required = g.required.length > 0 ? g.required : g.speakers;
        if (d === undefined) return false;
        if (d.status === "decided") return d.pendingParticipants.length === 0;
        return d.pendingParticipants.every((p) => required.includes(p));
      }),
    );
  });

  it("D2: explicit の発言だけの列では、時刻が最新の発言に従う（null なら決めない）", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.constantFrom(...OPTIONS), { nil: null }), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.boolean(),
        (optionIds, reversed) => {
          const list = optionIds.map((o, i) => stmt(o, "explicit", i));
          const s = state(topic(["p2"], OPTIONS), [], reversed ? [...list].reverse() : list);
          const d = decide(s, SPEAKERS).get("k1");
          const last = optionIds[optionIds.length - 1] ?? null;
          return last === null
            ? d?.status === "open"
            : d?.status === "decided" && d.decidedOptionId === last;
        },
      ),
    );
  });
});

// ---- 表示用のモデル ----

describe("toSummaryModel", () => {
  const participants = [
    { id: "p1", userId: "U1", name: "田中" },
    { id: "p2", userId: "U2", name: "佐藤" },
    { id: "p3", userId: "U3", name: "鈴木" },
  ];
  const todo = (id: string, closed: boolean): TodoItem => ({
    id,
    text: `作業 ${id}`,
    assignee: "p2",
    dueIso: null,
    dueText: null,
    certainty: "explicit",
    evidence: [ts(1)],
    quote: "",
    closed,
    ...ok,
  });

  it("判定の結果、表示名、決まった option の label に変える", () => {
    const t = topic(["p2", "p3"]);
    (t.options[0] as OptionItem).label = "10/28(水) 15:00";
    const s = state(t, [resp("p2", "o1")]);
    const open = toSummaryModel(s, participants);
    expect(open.topics[0]).toMatchObject({
      id: "k1",
      status: "open",
      decision: null,
      options: ["10/28(水) 15:00", "o2"],
      pendingParticipants: ["鈴木"],
    });
    s.responses.push(resp("p3", "o1"));
    const decided = toSummaryModel(s, participants);
    expect(decided.topics[0]).toMatchObject({
      status: "decided",
      decision: "10/28(水) 15:00",
      options: [],
      pendingParticipants: [],
    });
  });

  it("完了した ToDo と問いは、done の印があるときだけ含める", () => {
    const s: AnalysisState = {
      topics: [],
      responses: [],
      statements: [],
      todos: [todo("t1", false), todo("t2", true), todo("t3", true)],
      questions: [
        { id: "q1", text: "?", evidence: [ts(1)], quote: "", closed: true, ...ok },
        { id: "q2", text: "?", evidence: [ts(1)], quote: "", closed: false, ...ok },
      ],
    };
    const m = toSummaryModel(
      s,
      participants,
      new Map([
        ["t2", "done"],
        ["q1", "done"],
      ]),
    );
    expect(m.todos.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(m.todos[0]?.assignee).toBe("佐藤");
    expect(m.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
  });
});
