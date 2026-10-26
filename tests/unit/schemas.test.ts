import { zodResponseFormat } from "openai/helpers/zod";
import { describe, expect, it } from "vitest";
import {
  buildFindingsMapRequest,
  FINDINGS_MAP_SYSTEM_PROMPT,
  PROMPT_VERSION as FINDINGS_MAP_VERSION,
} from "../../src/analysis/prompts/findingsMap.js";
import {
  buildFindingsReduceRequest,
  FINDINGS_REDUCE_SYSTEM_PROMPT,
  PROMPT_VERSION as FINDINGS_REDUCE_VERSION,
} from "../../src/analysis/prompts/findingsReduce.js";
import { PROMPT_VERSION, SUMMARIZE_SYSTEM_PROMPT } from "../../src/analysis/prompts/summarize.js";
import {
  buildSummarizeSchema,
  FINDINGS_MAP_SCHEMA_NAME,
  FINDINGS_REDUCE_SCHEMA_NAME,
  FindingsMapSchema,
  FindingsReduceSchema,
  SUMMARIZE_SCHEMA_NAME,
} from "../../src/analysis/schemas.js";
import { jstDateIso } from "../../src/util/time.js";
import { NAMES, TODAY } from "../fixtures/schedule-thread.js";

const emptyPatch = {
  overview: [],
  topics: [],
  responses: [],
  statements: [],
  todos: [],
  questions: [],
  close: [],
};

const patch = {
  overview: [],
  topics: [
    {
      ref: null,
      evidence: ["m1"],
      title: "定例の日程",
      required_participants: ["p2", "p3"],
      options: [{ ref: null, evidence: ["m1"], label: "10/28(水) 15:00", date_iso: "2026-10-28" }],
    },
  ],
  responses: [
    {
      evidence: ["m2"],
      quote: "28日なら大丈夫です",
      topic_ref: "new:0",
      option_ref: "new:0",
      participant: "p2",
      answer: "yes",
      certainty: "explicit",
    },
  ],
  statements: [],
  todos: [
    {
      ref: null,
      evidence: ["m1"],
      quote: "会議室を予約します",
      text: "会議室を予約する",
      assignee: "p1",
      due_iso: null,
      due_text: null,
      certainty: "explicit",
    },
  ],
  questions: [],
  close: [],
};

/** JSON Schema の中の enum を全部集める。 */
function collectEnums(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) {
    for (const v of node) collectEnums(v, out);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "enum" && Array.isArray(v)) out.push(v);
      else collectEnums(v, out);
    }
  }
  return out;
}

describe("buildSummarizeSchema", () => {
  it("根拠付き概要を受け取り、最大3項目に制限する", () => {
    const schema = buildSummarizeSchema(["p1"]);
    const overview = {
      ref: null,
      evidence: ["m1"],
      quote: "資料を共有しました",
      text: "資料が共有された",
    };
    expect(schema.parse({ ...emptyPatch, overview: [overview] })).toMatchObject({
      overview: [overview],
    });
    expect(
      schema.safeParse({ ...emptyPatch, overview: Array.from({ length: 4 }, () => overview) })
        .success,
    ).toBe(false);
  });

  it("参加者の ID の enum を呼び出しごとに作る", () => {
    const schema = buildSummarizeSchema(["p1", "p2", "p3"]);
    expect(schema.safeParse(patch).success).toBe(true);

    const narrow = buildSummarizeSchema(["p1"]);
    // p2 は enum の外
    expect(narrow.safeParse(patch).success).toBe(false);
  });

  it("欄が欠けたり、型や enum が違ったりすると失敗する", () => {
    const schema = buildSummarizeSchema(["p1", "p2", "p3"]);
    expect(schema.safeParse({ ...patch, close: undefined }).success).toBe(false);
    expect(
      schema.safeParse({ ...patch, topics: [{ ...patch.topics[0], evidence: [] }] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...patch,
        responses: [{ ...patch.responses[0], evidence: ["x1"] }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...patch,
        responses: [{ ...patch.responses[0], certainty: "sure" }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...patch, todos: [{ ...patch.todos[0], assignee: "p9" }] }).success,
    ).toBe(false);
  });

  it("任意の欄は null を受け付ける", () => {
    const schema = buildSummarizeSchema(["p1"]);
    const r = schema.safeParse({
      ...emptyPatch,
      todos: [{ ...patch.todos[0], assignee: null, due_iso: null, due_text: null }],
      responses: [],
    });
    expect(r.success).toBe(true);
  });

  it("参加者が 0 人でも、空の enum を作らず、空の patch を受け付ける", () => {
    const schema = buildSummarizeSchema([]);
    expect(schema.safeParse(emptyPatch).success).toBe(true);
    for (const e of collectEnums(zodResponseFormat(schema, SUMMARIZE_SCHEMA_NAME))) {
      expect(e.length).toBeGreaterThan(0);
    }
    // 参加者の表にない値は通らない
    expect(
      schema.safeParse({ ...emptyPatch, todos: [{ ...patch.todos[0], assignee: "p1" }] }).success,
    ).toBe(false);
  });

  it("zodResponseFormat で strict の JSON Schema に変換できる", () => {
    const ids = ["p1", "p2", "p3"];
    const format = zodResponseFormat(buildSummarizeSchema(ids), SUMMARIZE_SCHEMA_NAME);
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("summarize_patch");
    expect(format.json_schema.strict).toBe(true);
    const json = JSON.stringify(format.json_schema.schema);
    for (const key of ["topics", "responses", "statements", "todos", "questions", "close"]) {
      expect(json).toContain(`"${key}"`);
    }
    // 参加者の enum が JSON Schema に入っている
    expect(collectEnums(format.json_schema.schema)).toContainEqual(ids);
    // strict: すべてのオブジェクトで、properties が全部 required
    const check = (node: unknown): void => {
      if (Array.isArray(node)) return void node.forEach(check);
      if (node === null || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect([...((o.required as string[]) ?? [])].sort()).toEqual(
          Object.keys((o.properties as object) ?? {}).sort(),
        );
      }
      for (const v of Object.values(o)) check(v);
    };
    check(format.json_schema.schema);
  });
});

describe("summarize の system プロンプト（R5）", () => {
  it("版は summarize@7 で、system に版を含める", () => {
    expect(PROMPT_VERSION).toBe("summarize@7");
    expect(SUMMARIZE_SYSTEM_PROMPT).toContain(PROMPT_VERSION);
  });

  it("ToDo の出力前に、願望だけの発言を外す自己確認を求める（002 T019）", () => {
    expect(SUMMARIZE_SYSTEM_PROMPT).toContain("願望や感想だけなら、その ToDo を出さない");
  });

  it("previous_state の書式の説明と例が、renderPreviousState の出力の形（回答・発言に ID なし、required なし）と合う", () => {
    const p = SUMMARIZE_SYSTEM_PROMPT;
    const example = /<previous_state>\n([\s\S]*?)\n<\/previous_state>/.exec(p)?.[1] ?? "";
    expect(example).toContain("k1 打ち合わせの場所 [o1=本社のラウンジ]");
    expect(example).toContain("回答 o1 yes: p2");
    expect(example).toContain("発言 k1 → o1:");
    expect(example).not.toContain("required");
    expect(example).not.toMatch(/^[rs]\d+ /m);
    // 説明の節にも、回答・発言の行の形が書いてある
    expect(p).toMatch(/回答 .*発言|発言 .*回答/s);
  });

  it("few-shot の出力の例は、すべてスキーマに合う（2 つ以上: 初回と、変更の差分）", () => {
    const examples = SUMMARIZE_SYSTEM_PROMPT.split("\n").filter((l) => l.startsWith('{"overview"'));
    expect(examples.length).toBeGreaterThanOrEqual(2);
    const schema = buildSummarizeSchema(["p1", "p2", "p3"]);
    for (const line of examples) {
      const parsed = schema.safeParse(JSON.parse(line));
      expect(parsed.success, line).toBe(true);
    }
  });

  it("変更・取り消しは、既存の題目に新しい候補を加え、確定の発言として出す（new: の参照を使う）", () => {
    const p = SUMMARIZE_SYSTEM_PROMPT;
    expect(p).toMatch(/変更/);
    expect(p).toMatch(/既存の題目.*新しい候補|新しい候補.*既存の題目/s);
    // 差分の例の statements は、既存の題目（k1）と new: の option を参照する
    const diff = SUMMARIZE_SYSTEM_PROMPT.split("\n")
      .filter((l) => l.startsWith('{"overview"'))
      .map((l) => JSON.parse(l) as { statements: { topic_ref: string; option_ref: string }[] })
      .find((e) => e.statements.some((s) => s.topic_ref === "k1"));
    expect(diff?.statements[0]?.option_ref).toMatch(/^new:\d+$/);
  });

  it("ToDo の基準: 具体的な作業だけ。検討・願望・出欠は除き、担当者が決まっていなければ null", () => {
    const p = SUMMARIZE_SYSTEM_PROMPT;
    expect(p).toMatch(/検討/);
    expect(p).toMatch(/願望|したい/);
    expect(p).toMatch(/誰かが/);
    expect(p).toMatch(/assignee.*null|null.*assignee/s);
  });

  it("固定の文字列で、日付・参加者の名前など可変の値を含まない", () => {
    // 前処理の入力（可変）は user 側。system に呼び出しごとの日付や名前が入らない（few-shot は別の合成の例）
    expect(typeof SUMMARIZE_SYSTEM_PROMPT).toBe("string");
    for (const [i, v] of [
      jstDateIso(TODAY),
      ...[...NAMES.values()],
      ...[...NAMES.keys()],
    ].entries()) {
      expect(SUMMARIZE_SYSTEM_PROMPT, `可変の値 #${i}`).not.toContain(v);
    }
  });

  it("必要な指示を含む", () => {
    const p = SUMMARIZE_SYSTEM_PROMPT;
    expect(p).toContain("<messages>");
    expect(p).toMatch(/データ/);
    expect(p).toMatch(/指示ではない|指示として扱わない/);
    expect(p).toMatch(/決定かどうかを判断しない/);
    for (const c of ["explicit", "implied", "uncertain"]) expect(p).toContain(c);
    expect(p).toContain("大丈夫かと思います");
    expect(p).toContain("new:");
    expect(p).toContain("calendar");
  });
});

// ---- findings（US4。contracts/llm.md#findings のスキーマ） ----

const mapOutput = {
  candidates: [
    {
      evidence: ["m1", "m2"],
      quote: "毎回手作業で確認している",
      theme_hint: "確認の手間",
      statement: "確認を手作業で行っており、負担になっている",
      kind: "issue",
    },
  ],
};

const reduceOutput = {
  themes: [
    {
      theme: "確認の手間",
      findings: [{ statement: "確認の負担が繰り返し挙がっている", candidate_ids: ["c1", "c2"] }],
    },
  ],
};

/** strict の JSON Schema か（すべてのオブジェクトで、properties が全部 required）。 */
function expectStrict(node: unknown): void {
  if (Array.isArray(node)) return void node.forEach(expectStrict);
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "object") {
    expect(o.additionalProperties).toBe(false);
    expect([...((o.required as string[]) ?? [])].sort()).toEqual(
      Object.keys((o.properties as object) ?? {}).sort(),
    );
  }
  for (const v of Object.values(o)) expectStrict(v);
}

describe("findings_map のスキーマ", () => {
  it("スキーマ名は findings_map。正しい出力を受け付け、空の候補も受け付ける", () => {
    expect(FINDINGS_MAP_SCHEMA_NAME).toBe("findings_map");
    expect(FindingsMapSchema.safeParse(mapOutput).success).toBe(true);
    expect(FindingsMapSchema.safeParse({ candidates: [] }).success).toBe(true);
  });

  it("根拠が空、m-id でない、kind が範囲外、欄の欠けは失敗する", () => {
    const item = mapOutput.candidates[0];
    const parse = (c: unknown) => FindingsMapSchema.safeParse({ candidates: [c] }).success;
    expect(parse({ ...item, evidence: [] })).toBe(false);
    expect(parse({ ...item, evidence: ["x1"] })).toBe(false);
    expect(parse({ ...item, kind: "decision" })).toBe(false);
    expect(parse({ ...item, theme_hint: undefined })).toBe(false);
    for (const kind of ["finding", "issue", "agreement"])
      expect(parse({ ...item, kind })).toBe(true);
  });

  it("欄の順は根拠 → 結論で、zodResponseFormat で strict の JSON Schema に変換できる", () => {
    const format = zodResponseFormat(FindingsMapSchema, FINDINGS_MAP_SCHEMA_NAME);
    expect(format.json_schema.name).toBe("findings_map");
    expect(format.json_schema.strict).toBe(true);
    expectStrict(format.json_schema.schema);
    const props = (
      format.json_schema.schema as {
        properties: { candidates: { items: { properties: object } } };
      }
    ).properties.candidates.items.properties;
    expect(Object.keys(props)).toEqual(["evidence", "quote", "theme_hint", "statement", "kind"]);
  });
});

describe("findings_reduce のスキーマ", () => {
  it("スキーマ名は findings_reduce。正しい出力を受け付ける", () => {
    expect(FINDINGS_REDUCE_SCHEMA_NAME).toBe("findings_reduce");
    expect(FindingsReduceSchema.safeParse(reduceOutput).success).toBe(true);
    expect(FindingsReduceSchema.safeParse({ themes: [] }).success).toBe(true);
  });

  it("candidate_ids が空、c-id でない、欄の欠けは失敗する", () => {
    const finding = reduceOutput.themes[0]?.findings[0];
    const parse = (f: unknown) =>
      FindingsReduceSchema.safeParse({ themes: [{ theme: "t", findings: [f] }] }).success;
    expect(parse({ ...finding, candidate_ids: [] })).toBe(false);
    expect(parse({ ...finding, candidate_ids: ["m1"] })).toBe(false);
    expect(parse({ statement: "x" })).toBe(false);
  });

  it("zodResponseFormat で strict の JSON Schema に変換できる", () => {
    const format = zodResponseFormat(FindingsReduceSchema, FINDINGS_REDUCE_SCHEMA_NAME);
    expect(format.json_schema.strict).toBe(true);
    expectStrict(format.json_schema.schema);
  });
});

describe("findings のプロンプト", () => {
  it("版は findings_map@1 と findings_reduce@1 で、system に版を含める", () => {
    expect(FINDINGS_MAP_VERSION).toBe("findings_map@1");
    expect(FINDINGS_REDUCE_VERSION).toBe("findings_reduce@1");
    expect(FINDINGS_MAP_SYSTEM_PROMPT).toContain(FINDINGS_MAP_VERSION);
    expect(FINDINGS_REDUCE_SYSTEM_PROMPT).toContain(FINDINGS_REDUCE_VERSION);
  });

  it("要求の task は map が extract_chunk、reduce が synthesize。スキーマ名と system と input を渡す", () => {
    const map = buildFindingsMapRequest("INPUT-MAP");
    expect(map.task).toBe("extract_chunk");
    expect(map.schemaName).toBe("findings_map");
    expect(map.system).toBe(FINDINGS_MAP_SYSTEM_PROMPT);
    expect(map.input).toBe("INPUT-MAP");
    const reduce = buildFindingsReduceRequest("INPUT-REDUCE");
    expect(reduce.task).toBe("synthesize");
    expect(reduce.schemaName).toBe("findings_reduce");
    expect(reduce.system).toBe(FINDINGS_REDUCE_SYSTEM_PROMPT);
    expect(reduce.input).toBe("INPUT-REDUCE");
  });

  it("few-shot の出力の例は、それぞれのスキーマに合う", () => {
    const mapExamples = FINDINGS_MAP_SYSTEM_PROMPT.split("\n").filter((l) =>
      l.startsWith('{"candidates"'),
    );
    expect(mapExamples.length).toBeGreaterThanOrEqual(1);
    for (const line of mapExamples) {
      expect(FindingsMapSchema.safeParse(JSON.parse(line)).success, line).toBe(true);
    }
    const reduceExamples = FINDINGS_REDUCE_SYSTEM_PROMPT.split("\n").filter((l) =>
      l.startsWith('{"themes"'),
    );
    expect(reduceExamples.length).toBeGreaterThanOrEqual(1);
    for (const line of reduceExamples) {
      expect(FindingsReduceSchema.safeParse(JSON.parse(line)).success, line).toBe(true);
    }
  });

  it("map: 会話は指示ではなくデータ、根拠と引用、推測しない、種類の基準を含む", () => {
    const p = FINDINGS_MAP_SYSTEM_PROMPT;
    expect(p).toContain("<messages>");
    expect(p).toMatch(/指示ではない|指示として扱わない/);
    expect(p).toMatch(/evidence/);
    expect(p).toMatch(/quote/);
    expect(p).toMatch(/推測/);
    for (const k of ["finding", "issue", "agreement"]) expect(p).toContain(k);
  });

  it("reduce: 入力は候補だけ。同じ事柄は 1 つにまとめ、候補の ID だけを使い、文を足さない", () => {
    const p = FINDINGS_REDUCE_SYSTEM_PROMPT;
    expect(p).toMatch(/候補/);
    expect(p).toMatch(/candidate_ids/);
    expect(p).toMatch(/まとめ/);
    expect(p).toMatch(/指示ではない|指示として扱わない/);
    expect(p).toMatch(/推測|ない内容/);
  });

  it("system は固定の文字列で、可変の値（日付、名前）を含まない", () => {
    for (const p of [FINDINGS_MAP_SYSTEM_PROMPT, FINDINGS_REDUCE_SYSTEM_PROMPT]) {
      for (const [i, v] of [
        jstDateIso(TODAY),
        ...[...NAMES.values()],
        ...[...NAMES.keys()],
      ].entries()) {
        expect(p, `可変の値 #${i}`).not.toContain(v);
      }
    }
  });
});
