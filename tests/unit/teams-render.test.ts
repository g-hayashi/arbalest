import { describe, expect, it } from "vitest";
import type { SummaryModel } from "../../src/slack/render.js";
import {
  renderTeamsFindings,
  renderTeamsSummary,
  TEAMS_MESSAGE_LIMIT,
} from "../../src/teams/render.js";

const url = "https://teams.microsoft.com/l/message/19%3Atest%40thread.tacv2/123?groupId=team";
const empty = (): SummaryModel => ({ overview: [], topics: [], todos: [], questions: [] });
const options = {
  links: new Map([["1.000000", url]]),
  count: 2,
  firstTs: "1.000000",
  lastTs: "2.000000",
};

describe("Teams の根拠付き表示", () => {
  it("概要・決定・未決定・ToDo・問いと取得範囲、未対応操作を表示する", () => {
    const base = { evidence: ["1.000000"], needsReview: false };
    const model: SummaryModel = {
      overview: [{ ...base, id: "v1", text: "資料共有" }],
      topics: [
        {
          ...base,
          id: "k1",
          title: "会議",
          status: "decided",
          decision: "水曜",
          options: [],
          pendingParticipants: [],
        },
        {
          ...base,
          id: "k2",
          title: "会場",
          status: "open",
          decision: null,
          options: ["本社"],
          pendingParticipants: ["佐藤"],
        },
      ],
      todos: [
        { ...base, id: "t1", text: "予約", assignee: "田中", dueIso: "2026-10-28", dueText: null },
      ],
      questions: [{ ...base, id: "q1", text: "参加人数は？" }],
    };
    const text = renderTeamsSummary(model, options).join("\n");
    for (const expected of [
      "会話の概要",
      "決定事項",
      "未決定事項",
      "水曜",
      "本社",
      "佐藤",
      "田中",
      "2026-10-28",
      "未解決の問い",
      "投稿2件",
      "1970-01-01",
      "ToDo の登録・完了・リマインド",
      "外部記録",
      "未対応",
      url,
    ])
      expect(text).toContain(expected);
  });

  it("LLM本文・表示名のMarkdown/HTML/メンションを無効化し、取得mapのリンクだけを使う", () => {
    const model = empty();
    model.todos.push({
      id: "t1",
      text: "[偽](https://evil.test) <at>全員</at> **太字**",
      assignee: "@everyone [人](url)",
      dueIso: null,
      dueText: null,
      evidence: ["1.000000", "missing"],
      needsReview: false,
    });
    const text = renderTeamsSummary(model, options).join("\n");
    expect(text).not.toContain("[偽](https://evil.test)");
    expect(text).not.toContain("<at>");
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("**太字**");
    expect(text).toContain(url);
    expect(text).toContain("要確認");
  });

  it("空根拠・欠損・不正URL・検証失敗は要確認にする", () => {
    const model = empty();
    model.questions = [
      { id: "q1", text: "根拠なし", evidence: [], needsReview: false },
      { id: "q2", text: "不明", evidence: ["missing"], needsReview: false },
      { id: "q3", text: "不正", evidence: ["bad"], needsReview: false },
      { id: "q4", text: "引用不一致", evidence: ["1.000000"], needsReview: true },
    ];
    const text = renderTeamsSummary(model, {
      ...options,
      links: new Map([...options.links, ["bad", "javascript:alert(1)"]]),
    }).join("\n");
    expect(text.match(/要確認/g)?.length).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain("javascript:");
  });

  it("UTF-16上限で行単位に分割し、過大な1項目は根拠と省略表示を保つ", () => {
    const model = empty();
    model.questions = Array.from({ length: 40 }, (_, i) => ({
      id: `q${i}`,
      text: `項目${i} ${"😀".repeat(160)}`,
      evidence: ["1.000000"],
      needsReview: false,
    }));
    model.questions.push({
      id: "huge",
      text: `巨大${"<&😀".repeat(10000)}`,
      evidence: ["1.000000"],
      needsReview: false,
    });
    const messages = renderTeamsSummary(model, options);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(TEAMS_MESSAGE_LIMIT);
      expect(message).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
      expect(message).not.toMatch(/&(?:amp|lt|gt|#\d*)?$/);
    }
    const lines = messages.join("\n").split("\n");
    expect(lines.find((line) => line.includes("巨大"))).toContain("省略");
    expect(lines.find((line) => line.includes("巨大"))).toContain(url);
    for (let i = 0; i < 40; i++)
      expect(lines.filter((line) => line.includes(`項目${i} `))).toHaveLength(1);
  });

  it("空の取得でも件数と未対応の説明を返信する", () => {
    const text = renderTeamsSummary(empty(), {
      links: new Map(),
      count: 0,
      firstTs: null,
      lastTs: null,
    }).join("\n");
    expect(text).toContain("投稿0件");
    expect(text).toContain("未対応");
  });

  it("取得mapのURL自体が過大でも上限を守り、リンクを要確認にする", () => {
    const model = empty();
    model.questions = [{ id: "q1", text: "確認", evidence: ["huge"], needsReview: false }];
    const messages = renderTeamsSummary(model, {
      ...options,
      links: new Map([["huge", `${url}&value=${"a".repeat(10000)}`]]),
    });
    expect(messages.join("\n")).toContain("要確認");
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(TEAMS_MESSAGE_LIMIT);
  });
});

describe("Teams Findings の表示", () => {
  const period = {
    start: "2026-10-19T03:00:00.000Z",
    end: "2026-10-26T03:00:00.000Z",
    label: "直近7日",
    clamped: false,
  };

  it("テーマと根拠、対象期間と取得件数、未対応操作を表示する", () => {
    const text = renderTeamsFindings(
      [
        {
          theme: "共有手順",
          findings: [
            {
              statement: "事前共有が定着した",
              evidence: ["1.000000"],
              needsReview: false,
              reviewReasons: [],
            },
          ],
        },
      ],
      { ...options, period },
    ).join("\n");
    for (const value of [
      "Findings",
      "共有手順",
      "事前共有が定着した",
      "直近7日",
      period.start,
      period.end,
      "以上",
      "未満",
      "投稿2件",
      url,
      "未対応",
    ])
      expect(text).toContain(value);
  });

  it("テーマ・本文の装飾を無効化し、欠損根拠を要確認にする", () => {
    const text = renderTeamsFindings(
      [
        {
          theme: "<at>@全員</at> **見出し**",
          findings: [
            {
              statement: "[偽](https://evil.test)",
              evidence: ["missing"],
              needsReview: false,
              reviewReasons: [],
            },
          ],
        },
      ],
      { ...options, period },
    ).join("\n");
    expect(text).toContain("要確認");
    expect(text).not.toContain("<at>");
    expect(text).not.toContain("@全員");
    expect(text).not.toContain("**見出し**");
    expect(text).not.toContain("[偽](https://evil.test)");
  });

  it("長いテーマと本文を安全に省略・分割し、90日制限と空結果を表示する", () => {
    const messages = renderTeamsFindings(
      [
        {
          theme: "😀".repeat(10000),
          findings: Array.from({ length: 40 }, () => ({
            statement: `学び${"あ".repeat(500)}`,
            evidence: ["1.000000"],
            needsReview: false,
            reviewReasons: [],
          })),
        },
      ],
      { ...options, period },
    );
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(TEAMS_MESSAGE_LIMIT);
    expect(messages.join("\n")).toContain("省略");
    const text = renderTeamsFindings([], {
      links: new Map(),
      count: 0,
      firstTs: null,
      lastTs: null,
      period: { ...period, clamped: true },
    }).join("\n");
    expect(text).toContain("投稿0件");
    expect(text).toContain("90 日に制限");
    expect(text).toContain("見つかりませんでした");
  });
});
