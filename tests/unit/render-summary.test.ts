import { describe, expect, it } from "vitest";
import {
  EMPTY_SUMMARY_TEXT,
  renderSummary,
  renderSummaryDelta,
  type SummaryMessage,
  type SummaryModel,
} from "../../src/slack/render.js";

const permalink = (ts: string) => `https://example.slack.com/archives/C1/p${ts.replace(".", "")}`;
const link = (ts: string, label = "根拠") => `<${permalink(ts)}|${label}>`;

function emptyModel(): SummaryModel {
  return { topics: [], todos: [], questions: [] };
}

/** 全ブロックの本文をつなぐ。 */
function allText(messages: SummaryMessage[]): string {
  return messages
    .flatMap((m) =>
      m.blocks.map((b) =>
        b.type === "section"
          ? b.text.text
          : b.type === "context"
            ? b.elements.map((e) => e.text).join("\n")
            : "",
      ),
    )
    .join("\n");
}

/** actions ブロック（canvas のボタン）の URL をすべて集める。 */
function buttonUrls(messages: SummaryMessage[]): string[] {
  return messages.flatMap((m) =>
    m.blocks.flatMap((b) => (b.type === "actions" ? b.elements.map((e) => e.url) : [])),
  );
}

const sample: SummaryModel = {
  topics: [
    {
      id: "k1",
      title: "定例の日程",
      status: "decided",
      decision: "10/28(水) 15:00",
      options: ["10/28(水) 15:00", "10/29(木) 10:00"],
      pendingParticipants: [],
      evidence: ["1729746180.000100"],
      needsReview: false,
    },
    {
      id: "k2",
      title: "会場",
      status: "open",
      decision: null,
      options: ["オンライン", "対面"],
      pendingParticipants: ["鈴木", "高橋"],
      evidence: ["1729746200.000100"],
      needsReview: false,
    },
  ],
  todos: [
    {
      id: "t1",
      text: "会議室を予約する",
      assignee: "田中",
      dueIso: "2026-10-27",
      dueText: "来週月曜",
      evidence: ["1729746300.000100"],
      needsReview: false,
    },
  ],
  questions: [
    { id: "q1", text: "予算の上限は?", evidence: ["1729746400.000100"], needsReview: false },
  ],
};

describe("renderSummary: 基本の形", () => {
  it("見出し・分類・項目・根拠のリンクを contracts の形で出す", () => {
    const out = renderSummary(sample, { permalink });
    expect(out).toHaveLength(1);
    const text = allText(out);
    expect(text).toContain("📋 調整のまとめ");
    expect(text).not.toContain("前回から");
    expect(text).toContain("*決定事項*");
    expect(text).toContain(`• 定例の日程: 10/28(水) 15:00  ${link("1729746180.000100")}`);
    expect(text).toContain("*未決定事項*");
    expect(text).toContain(
      `• 会場: オンライン / 対面 — 回答待ち: @鈴木, @高橋  ${link("1729746200.000100")}`,
    );
    expect(text).toContain("*ToDo*");
    expect(text).toContain(
      `• 会議室を予約する — @田中 / 期限 10/27(火)  ${link("1729746300.000100")}`,
    );
    expect(text).toContain("*未解決の問い*");
    expect(text).toContain(`• 予算の上限は?  ${link("1729746400.000100")}`);
    expect(text).not.toContain("⚠️");
    expect(out[0]?.text).toContain("調整のまとめ");
  });

  it("担当者なし・期限なし・期限が日付に直せないとき", () => {
    const model: SummaryModel = {
      ...emptyModel(),
      todos: [
        {
          id: "t1",
          text: "A",
          assignee: null,
          dueIso: null,
          dueText: null,
          evidence: ["1.1"],
          needsReview: false,
        },
        {
          id: "t2",
          text: "B",
          assignee: "田中",
          dueIso: null,
          dueText: "来月のどこか",
          evidence: ["1.2"],
          needsReview: false,
        },
      ],
    };
    const text = allText(renderSummary(model, { permalink }));
    expect(text).toContain("• A — 担当未定  ");
    expect(text).toContain("• B — @田中 / 期限 来月のどこか  ");
  });

  it("根拠が複数ならリンクを並べる", () => {
    const model: SummaryModel = {
      ...emptyModel(),
      questions: [{ id: "q1", text: "Q", evidence: ["1.1", "2.2", "3.3"], needsReview: false }],
    };
    const text = allText(renderSummary(model, { permalink }));
    expect(text).toContain(`${link("1.1", "1")} ${link("2.2", "2")} ${link("3.3", "3")}`);
  });

  it("空の分類の見出しは出さない", () => {
    const model: SummaryModel = { ...emptyModel(), questions: sample.questions };
    const text = allText(renderSummary(model, { permalink }));
    expect(text).toContain("*未解決の問い*");
    expect(text).not.toContain("*決定事項*");
    expect(text).not.toContain("*ToDo*");
  });
});

describe("renderSummary: 空のとき", () => {
  it("調整項目がなくても根拠付き概要と読み込み範囲を先に出す", () => {
    const model = {
      ...emptyModel(),
      overview: [{ id: "v1", text: "資料が共有された", evidence: ["1.1"], needsReview: false }],
    };
    const opts = {
      permalink,
      scope: {
        kind: "thread" as const,
        count: 2,
        firstTs: "1792717200.000000",
        lastTs: "1792720800.000000",
      },
    };
    const out = renderSummary(model, opts);
    const text = allText(out);
    expect(text).toContain("*会話の概要*");
    expect(text).toContain(`資料が共有された  ${link("1.1")}`);
    expect(text).toContain("スレッド / 投稿2件");
    expect(text).toContain("JST");
    expect(text).toContain(EMPTY_SUMMARY_TEXT);
    expect(text.indexOf("会話の概要")).toBeLessThan(text.indexOf(EMPTY_SUMMARY_TEXT));
    expect(out[0]?.text).toContain("資料が共有された");
  });

  it("取得0件なら概要と投稿時刻を作らず、対象範囲と0件を表示する", () => {
    const text = allText(
      renderSummary(emptyModel(), {
        permalink,
        scope: { kind: "channel", count: 0, firstTs: null, lastTs: null, days: 7 },
      } as Parameters<typeof renderSummary>[1]),
    );
    expect(text).toContain("直近7日 / 投稿0件");
    expect(text).not.toContain("*会話の概要*");
    expect(text).not.toContain("最初");
  });

  it("まとめる調整事項は見つかりませんでした、と返す", () => {
    const out = renderSummary(emptyModel(), { permalink });
    expect(out).toHaveLength(1);
    expect(EMPTY_SUMMARY_TEXT).toBe("まとめる調整事項は見つかりませんでした");
    expect(allText(out)).toContain("まとめる調整事項は見つかりませんでした");
    expect(out[0]?.text).toContain("まとめる調整事項は見つかりませんでした");
  });
});

describe("renderSummary: 差分の印", () => {
  it("🆕 ✏️ ✅ と、見出しの件数を出す", () => {
    const marks = new Map([
      ["k1", "new" as const],
      ["k2", "changed" as const],
      ["t1", "done" as const],
      ["q1", "new" as const],
    ]);
    const text = allText(renderSummary(sample, { permalink, marks }));
    expect(text).toContain("📋 調整のまとめ（前回から: 追加 2 / 変更 1 / 完了 1）");
    expect(text).toMatch(/定例の日程.*根拠> {2}🆕/);
    expect(text).toMatch(/会場.*根拠> {2}✏️/);
    expect(text).toMatch(/会議室を予約する.*根拠> {2}✅/);
    expect(text).toMatch(/予算の上限は\?.*根拠> {2}🆕/);
  });

  it("印がなければ「変更なし」", () => {
    const text = allText(renderSummary(sample, { permalink, marks: new Map() }));
    expect(text).toContain("（前回から: 変更なし）");
    expect(text).not.toMatch(/🆕|✏️|✅/);
  });

  it("印がなくても、まとめが変わっていれば「概要を更新」。印があるときの表記は変えない", () => {
    const none = allText(
      renderSummary(sample, { permalink, marks: new Map(), summaryChanged: true }),
    );
    expect(none).toContain("（前回から: 概要を更新）");
    expect(none).not.toContain("変更なし");
    const counted = allText(
      renderSummary(sample, {
        permalink,
        marks: new Map([["k1", "changed"]]),
        summaryChanged: true,
      }),
    );
    expect(counted).toContain("（前回から: 追加 0 / 変更 1 / 完了 0）");
    const unchanged = allText(
      renderSummary(sample, { permalink, marks: new Map(), summaryChanged: false }),
    );
    expect(unchanged).toContain("（前回から: 変更なし）");
  });

  it("表示しない項目（完了して消えた ToDo など）の印も件数に数える", () => {
    const marks = new Map([["t9", "done" as const]]);
    const text = allText(renderSummary(sample, { permalink, marks }));
    expect(text).toContain("完了 1");
  });
});

describe("renderSummary: 要確認", () => {
  it("要確認の項目に ⚠️ を付け、末尾に説明を 1 回だけ出す", () => {
    const model: SummaryModel = {
      ...sample,
      topics: sample.topics.map((t) => ({ ...t, needsReview: t.id === "k1" })),
      todos: sample.todos.map((t) => ({ ...t, needsReview: true })),
    };
    const out = renderSummary(model, { permalink });
    const text = allText(out);
    expect(text).toMatch(/定例の日程.*根拠> ⚠️/);
    expect(text).toMatch(/会議室を予約する.*根拠> ⚠️/);
    expect(text.match(/根拠を確かめられなかった項目には ⚠️ を付けています/g)).toHaveLength(1);
    expect(text).toContain("⚠️ 要確認: 根拠を確かめられなかった項目には ⚠️ を付けています");
    // 最後のメッセージの最後のブロック
    const last = out[out.length - 1]?.blocks.at(-1);
    expect(last?.type).toBe("context");
  });

  it("根拠が 0 件のまま残った項目は、リンクの代わりに「根拠なし」と出し、⚠️ を付ける（SC-004）", () => {
    const model: SummaryModel = {
      topics: sample.topics.map((t) => ({ ...t, evidence: [], needsReview: t.id === "k1" })),
      todos: sample.todos.map((t) => ({ ...t, evidence: [], needsReview: true })),
      questions: [{ id: "q1", text: "予算の上限は?", evidence: [], needsReview: true }],
    };
    const text = allText(renderSummary(model, { permalink }));
    expect(text).toContain("• 定例の日程: 10/28(水) 15:00  根拠なし ⚠️");
    expect(text).toContain("• 予算の上限は?  根拠なし ⚠️");
    expect(text).toMatch(/会議室を予約する.*根拠なし ⚠️/);
    expect(text).not.toContain("|根拠>");
    expect(text).not.toContain("|1>");
    // 差分の印との順番は ⚠️ → 印
    const withMark = allText(renderSummary(model, { permalink, marks: new Map([["q1", "new"]]) }));
    expect(withMark).toContain("根拠なし ⚠️  🆕");
  });

  it("要確認がなければ説明を出さない", () => {
    expect(allText(renderSummary(sample, { permalink }))).not.toContain("要確認");
  });

  it("要確認と差分の印が両方あれば、⚠️ → 印の順", () => {
    const model: SummaryModel = {
      ...emptyModel(),
      questions: [{ id: "q1", text: "Q", evidence: ["1.1"], needsReview: true }],
    };
    const text = allText(renderSummary(model, { permalink, marks: new Map([["q1", "new"]]) }));
    expect(text).toContain("根拠> ⚠️  🆕");
  });
});

describe("renderSummary: エスケープ", () => {
  it("本文の <, >, & と、メンションになる記法を無害にする", () => {
    const model: SummaryModel = {
      ...emptyModel(),
      questions: [
        {
          id: "q1",
          text: "<!channel> A&B <@U123> <https://x|y>",
          evidence: ["1.1"],
          needsReview: false,
        },
      ],
      todos: [
        {
          id: "t1",
          text: "x",
          assignee: "<!here>",
          dueIso: null,
          dueText: "<b>",
          evidence: ["1.1"],
          needsReview: false,
        },
      ],
    };
    const text = allText(renderSummary(model, { permalink }));
    expect(text).toContain("&lt;!channel&gt; A&amp;B &lt;@U123&gt; &lt;https://x|y&gt;");
    expect(text).toContain("@&lt;!here&gt;");
    expect(text).toContain("期限 &lt;b&gt;");
    expect(text).not.toContain("<!channel>");
  });
});

describe("renderSummary: 分割（50 ブロック、3,000 文字）", () => {
  const bigTodos = (n: number, len: number): SummaryModel => ({
    ...emptyModel(),
    todos: Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`,
      text: `${"あ".repeat(len)}${i}`,
      assignee: "田中",
      dueIso: null,
      dueText: null,
      evidence: ["1.1"],
      needsReview: i % 2 === 0,
    })),
  });

  it("1 つの section の本文は 3,000 文字以内で、項目の途中で切らない", () => {
    const out = renderSummary(bigTodos(60, 200), { permalink });
    const sections = out.flatMap((m) => m.blocks).filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expect(s.text.text.length).toBeLessThanOrEqual(3000);
      for (const line of s.text.text.split("\n").filter((l) => l.startsWith("•"))) {
        expect(line).toMatch(/\|根拠>/); // 行が途中で切れていない
      }
    }
    const text = allText(out);
    for (let i = 0; i < 60; i++) expect(text).toContain(`${"あ".repeat(200)}${i} —`);
  });

  it("続きの section には分類の見出しを付け直す", () => {
    const out = renderSummary(bigTodos(60, 200), { permalink });
    const sections = out.flatMap((m) => m.blocks).filter((b) => b.type === "section");
    const todoSections = sections.filter((s) => s.text.text.includes("• "));
    expect(todoSections.length).toBeGreaterThan(1);
    expect(todoSections[0]?.text.text.startsWith("*ToDo*")).toBe(true);
    expect(todoSections[1]?.text.text.startsWith("*ToDo（続き）*")).toBe(true);
  });

  it("1 つのメッセージは 50 ブロック以内。超えたら続きの返信に分ける", () => {
    // 1 section あたり約 13 件。800 件なら約 60 section
    const out = renderSummary(bigTodos(800, 200), { permalink });
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) {
      expect(m.blocks.length).toBeLessThanOrEqual(50);
      expect(m.blocks.length).toBeGreaterThan(0);
    }
    expect(allText([out[0] as SummaryMessage])).toContain("📋 調整のまとめ");
    expect(allText([out[1] as SummaryMessage]).startsWith("📋 調整のまとめ（続き）")).toBe(true);
    const text = allText(out);
    for (let i = 0; i < 800; i += 37) expect(text).toContain(`${"あ".repeat(200)}${i} —`);
    expect(text.match(/要確認: 根拠を確かめられなかった/g)).toHaveLength(1);
  });

  it("1 行だけで 3,000 文字を超える項目は、行の途中で切って省略する", () => {
    const model: SummaryModel = {
      ...emptyModel(),
      questions: [{ id: "q1", text: "い".repeat(5000), evidence: ["1.1"], needsReview: false }],
    };
    const out = renderSummary(model, { permalink });
    for (const b of out.flatMap((m) => m.blocks)) {
      if (b.type === "section") expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(allText(out)).toContain("…");
    expect(allText(out)).toContain("|根拠>");
  });

  it("どの見出し（「（続き）」付き）でも、長すぎる項目を含む section が 3,000 文字を超えない", () => {
    const long = "い".repeat(5000);
    const base = { evidence: ["1.1"], needsReview: false };
    const topic = (id: string, status: "decided" | "open"): SummaryModel["topics"][number] => ({
      ...base,
      id,
      title: long,
      status,
      decision: status === "decided" ? long : null,
      options: [],
      pendingParticipants: [],
    });
    const model: SummaryModel = {
      topics: [
        topic("k1", "decided"),
        topic("k2", "decided"),
        topic("k3", "open"),
        topic("k4", "open"),
      ],
      todos: ["t1", "t2"].map((id) => ({
        ...base,
        id,
        text: long,
        assignee: "田中",
        dueIso: null,
        dueText: null,
      })),
      questions: ["q1", "q2"].map((id) => ({ ...base, id, text: long })),
    };
    const out = renderSummary(model, { permalink, marks: new Map([["k1", "changed"]]) });
    const sections = out.flatMap((m) => m.blocks).filter((b) => b.type === "section");
    // 4 つの分類のそれぞれで、続きの section ができている
    for (const title of ["決定事項", "未決定事項", "ToDo", "未解決の問い"]) {
      expect(sections.some((s) => s.text.text.startsWith(`*${title}（続き）*`))).toBe(true);
    }
    for (const s of sections) expect(s.text.text.length).toBeLessThanOrEqual(3000);
  });

  it("純粋: 同じ入力から同じ出力。入力を書き換えない", () => {
    const frozen = structuredClone(sample);
    const a = renderSummary(sample, { permalink });
    const b = renderSummary(sample, { permalink });
    expect(a).toEqual(b);
    expect(sample).toEqual(frozen);
  });
});

describe("renderSummaryDelta: まとめに変更がない再実行の簡素な返信", () => {
  const CANVAS = "https://example.slack.com/docs/T1/F1";
  const todoLine = `• 会議室を予約する — @田中 / 期限 10/27(火)  ${link("1729746300.000100")}  ✏️`;

  it("ToDo の変化と canvas の更新だけなら、短い見出しと変化した ToDo の行と canvas のリンクにする", () => {
    const out = renderSummaryDelta(sample, {
      permalink,
      marks: new Map([["t1", "changed"]]),
      canvas: { action: "updated", link: CANVAS },
    });
    expect(out).toHaveLength(1);
    const text = allText(out);
    expect(text).toContain("📋 まとめに変更はありません。ToDo: 変更 1件 / canvas: 更新");
    expect(text).toContain("*ToDo*");
    expect(text).toContain(todoLine);
    // canvas へのリンクは本文ではなく URL ボタンにする（本文の URL は Slack が展開するため）
    expect(text).not.toContain(CANVAS);
    expect(out.map((m) => m.text).join("\n")).not.toContain(CANVAS);
    expect(buttonUrls(out)).toEqual([CANVAS]);
    expect(out[0]?.blocks.at(-1)).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "canvas を開く" },
          url: CANVAS,
          action_id: "canvas_open",
        },
      ],
    });
    // 全文を再掲しない
    expect(text).not.toContain("定例の日程");
    expect(text).not.toContain("予算の上限");
    expect(text).not.toContain("調整のまとめ");
    expect(text).not.toContain("取得範囲");
  });

  it("まとめの印が付いていない ToDo は載せず、件数にも数えない", () => {
    const out = renderSummaryDelta(
      {
        ...sample,
        todos: [
          ...sample.todos,
          { ...(sample.todos[0] as SummaryModel["todos"][number]), id: "t2" },
        ],
      },
      {
        permalink,
        marks: new Map([["t1", "new"]]),
        canvas: { action: "inserted", link: CANVAS },
      },
    );
    const text = allText(out);
    expect(text).toContain("ToDo: 変更 1件 / canvas: 作成");
    expect(text.match(/会議室を予約する/g)).toHaveLength(1);
  });

  it("ToDo の変化がなく canvas を新規作成したときは、canvas の作成を示す", () => {
    const out = renderSummaryDelta(sample, {
      permalink,
      marks: new Map(),
      canvas: { action: "inserted", link: CANVAS },
    });
    const text = allText(out);
    expect(text).toContain("📋 まとめに変更はありません。canvas: 作成");
    expect(text).not.toContain("*ToDo*");
    expect(text).not.toContain(CANVAS);
    expect(buttonUrls(out)).toEqual([CANVAS]);
  });

  it("まとめ・ToDo・canvas のどれにも変化がなければ、「前回から変更はありません。」と canvas のリンクだけ", () => {
    const out = renderSummaryDelta(sample, {
      permalink,
      marks: new Map(),
      canvas: { action: "updated", link: CANVAS },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.blocks.map((b) => (b.type === "section" ? b.text.text : b.type))).toEqual([
      "📋 前回から変更はありません。",
      "actions",
    ]);
    expect(buttonUrls(out)).toEqual([CANVAS]);
    expect(allText(out)).not.toContain(CANVAS);
    expect(allText(out)).not.toContain("ToDo");
  });

  it("canvas がなければ「前回から変更はありません。」だけ。補足があれば添える", () => {
    const plain = renderSummaryDelta(sample, { permalink, marks: new Map() });
    expect(allText(plain)).toBe("📋 前回から変更はありません。");
    const noted = renderSummaryDelta(sample, {
      permalink,
      marks: new Map(),
      executionNotes: ["canvas: 更新失敗"],
    });
    expect(allText(noted)).toBe("📋 前回から変更はありません。\ncanvas: 更新失敗");
  });

  it("ToDo が多くても 50 ブロックを超えず、続きの返信に分ける", () => {
    const base = sample.todos[0] as SummaryModel["todos"][number];
    const todos = Array.from({ length: 400 }, (_, i) => ({
      ...base,
      id: `t${i + 1}`,
      text: "あ".repeat(400),
    }));
    const out = renderSummaryDelta(
      { ...sample, todos },
      {
        permalink,
        marks: new Map(todos.map((t) => [t.id, "new" as const])),
        canvas: { action: "updated", link: CANVAS },
      },
    );
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) expect(m.blocks.length).toBeLessThanOrEqual(50);
    expect(allText(out)).toContain("ToDo: 変更 400件");
    expect(allText(out).match(/• /g)).toHaveLength(400);
    // 分割されても、ボタンは最後のメッセージに 1 つだけ
    expect(buttonUrls(out)).toEqual([CANVAS]);
    expect(buttonUrls([out.at(-1) as SummaryMessage])).toEqual([CANVAS]);
    expect(out.map((m) => m.text).join("\n")).not.toContain(CANVAS);
  });
});

describe("renderSummary: canvas のボタン", () => {
  const CANVAS = "https://example.slack.com/docs/T1/F1";

  it("canvasUrl を渡すと、URL ボタンを付ける。本文と text に URL を含めない", () => {
    const out = renderSummary(sample, { permalink, canvasUrl: CANVAS });
    expect(buttonUrls(out)).toEqual([CANVAS]);
    expect(allText(out)).not.toContain(CANVAS);
    expect(out.map((m) => m.text).join("\n")).not.toContain(CANVAS);
    expect(out.map((m) => m.text).join("\n")).not.toContain("canvas を開く");
  });

  it("canvasUrl がなければボタンは付かない", () => {
    expect(buttonUrls(renderSummary(sample, { permalink }))).toEqual([]);
  });

  it("分割されても、ボタンは最後のメッセージに 1 つだけ", () => {
    const base = sample.todos[0] as SummaryModel["todos"][number];
    const todos = Array.from({ length: 400 }, (_, i) => ({
      ...base,
      id: `t${i + 1}`,
      text: "あ".repeat(400),
    }));
    const out = renderSummary({ ...sample, todos }, { permalink, canvasUrl: CANVAS });
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) expect(m.blocks.length).toBeLessThanOrEqual(50);
    expect(buttonUrls(out)).toEqual([CANVAS]);
    expect(buttonUrls([out.at(-1) as SummaryMessage])).toEqual([CANVAS]);
  });
});
