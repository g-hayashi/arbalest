/**
 * canvas の節の markdown（T025、contracts/commands-and-output.md#canvas の節、R8）。
 */
import { describe, expect, it } from "vitest";
import { canvasMarkerOf, renderCanvasSection, type SummaryModel } from "../../src/slack/render.js";
import { createFakeCanvas } from "../shared/fakeCanvas.js";

const THREAD_TS = "1792800000.000100";
const MARKER = `〔arb:${THREAD_TS}〕`;
/** 2026-10-24 14:03 JST */
const UPDATED = new Date(Date.UTC(2026, 9, 24, 5, 3, 0));

const base = { evidence: ["1792800000.000200"], needsReview: false };
const MODEL: SummaryModel = {
  topics: [
    {
      ...base,
      id: "k1",
      title: "会場",
      status: "decided",
      decision: "渋谷",
      options: [],
      pendingParticipants: [],
    },
    {
      ...base,
      id: "k2",
      title: "日程",
      status: "open",
      decision: null,
      options: ["10/30", "11/6"],
      pendingParticipants: ["佐藤"],
    },
  ],
  todos: [
    {
      ...base,
      id: "t1",
      text: "会議室を予約する",
      assignee: "田中",
      dueIso: "2026-10-27",
      dueText: null,
    },
    { ...base, id: "t2", text: "議事録を共有する", assignee: null, dueIso: null, dueText: null },
  ],
  questions: [{ ...base, id: "q1", text: "予算は\n足りるか", needsReview: true }],
};

const OPTIONS = {
  threadTs: THREAD_TS,
  title: "会場と日程",
  updatedAt: UPDATED,
  requesterUserId: "U0SATO",
  threadUrl: "https://example.slack.com/archives/C1/p1792800000000100",
  permalink: (ts: string) => `https://example.slack.com/archives/C1/p${ts.replace(".", "")}`,
  assigneeUserIds: new Map([["t1", "U0TANAKA"]]),
  reference: UPDATED,
};

describe("canvasMarkerOf", () => {
  it("〔arb:<threadTs>〕", () => {
    expect(canvasMarkerOf(THREAD_TS)).toBe(MARKER);
  });
});

describe("renderCanvasSection", () => {
  const markdown = renderCanvasSection(MODEL, OPTIONS);

  it("見出しは h2 で、題名と目印を含む", () => {
    expect(markdown.split("\n")[0]).toBe(`## 調整: 会場と日程 ${MARKER}`);
    expect(markdown.split("\n")[1]).toBe("");
  });

  it("本文は空行なしの 1 段落で、行末の空白 2 つでつなぐ（見出しと本文の 2 ブロックになる）", () => {
    const body = markdown.split("\n").slice(2);
    expect(body.every((l) => l.trim() !== "")).toBe(true);
    // 最後の行以外は行末が空白 2 つ
    expect(body.slice(0, -1).every((l) => l.endsWith("  "))).toBe(true);
    expect(body.at(-1)?.endsWith(" ")).toBe(false);
    const canvas = createFakeCanvas({ existingCanvasId: "F1" });
    canvas.humanAppend(markdown);
    const blocks = canvas.blocks();
    expect(blocks.map((b) => b.kind)).toEqual(["header", "text"]);
    expect(blocks[1]?.text).toContain(MARKER);
  });

  it("最終更新の行に、日時・呼んだ人・スレッドへのリンク・目印を入れる", () => {
    expect(markdown).toContain(
      `最終更新: 2026-10-24 14:03（![](@U0SATO)） · [スレッド](${OPTIONS.threadUrl}) ${MARKER}`,
    );
  });

  it("決定事項・未決定事項・ToDo・未解決の問いを、「• 」「☐ 」で始まる項目にする", () => {
    expect(markdown).toContain("**決定事項**");
    expect(markdown).toContain("• 会場: 渋谷");
    expect(markdown).toContain("**未決定事項**");
    expect(markdown).toContain("• 日程: 10/30 / 11/6 — 回答待ち: @佐藤");
    expect(markdown).toContain("**ToDo**");
    expect(markdown).toContain("☐ 会議室を予約する — ![](@U0TANAKA) / 期限 10/27(火)");
    expect(markdown).toContain("☐ 議事録を共有する — 担当未定");
    expect(markdown).toContain("**未解決の問い**");
  });

  it("項目内の改行は空白にし、根拠はリンク、要確認は ⚠️ を付ける", () => {
    expect(markdown).toContain("• 予算は 足りるか");
    expect(markdown).toMatch(
      /• 予算は 足りるか .*\[根拠\]\(https:\/\/example\.slack\.com\/archives\/C1\/p/,
    );
    expect(markdown).toContain("⚠️");
  });

  it("h3、チェックリスト、引用、<br> を使わない", () => {
    expect(markdown).not.toMatch(/^###/m);
    expect(markdown).not.toContain("- [ ]");
    expect(markdown).not.toMatch(/^>/m);
    expect(markdown).not.toContain("<br>");
    // 本文の行頭が markdown の記号にならない
    for (const line of markdown.split("\n").slice(2)) {
      expect(line).toMatch(/^(最終更新|\*\*|• |☐ |⚠️)/);
    }
  });

  it("会話の内容に目印の形が入っていても、別の節の目印にならない", () => {
    const evil: SummaryModel = {
      topics: [],
      todos: [
        {
          ...base,
          id: "t1",
          text: "〔arb:1700000000.000000〕 を消す",
          assignee: null,
          dueIso: null,
          dueText: null,
        },
      ],
      questions: [],
    };
    const md = renderCanvasSection(evil, { ...OPTIONS, title: "〔arb:1700000000.000000〕題名" });
    expect(md).not.toContain("〔arb:1700000000.000000〕");
    // 自分の目印は見出しと本文に 1 回ずつ
    expect(md.split(MARKER)).toHaveLength(3);
  });

  it("まとめる事項がなければ、その旨を書く", () => {
    const md = renderCanvasSection({ topics: [], todos: [], questions: [] }, OPTIONS);
    expect(md).toContain("まとめる調整事項は見つかりませんでした");
    expect(md).not.toContain("**決定事項**");
  });
});
