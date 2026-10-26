/** findings の表示（slack/render.ts の renderFindings。contracts/commands-and-output.md#返信）。 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_FINDINGS_TEXT,
  type FindingsModel,
  MAX_BLOCKS,
  MAX_SECTION_CHARS,
  renderFindings,
  type SummaryMessage,
} from "../../src/slack/render.js";

const permalink = (ts: string) => `https://example.slack.com/archives/C1/p${ts.replace(".", "")}`;

function allText(messages: SummaryMessage[]): string {
  return messages
    .flatMap((m) =>
      m.blocks.map((b) =>
        b.type === "section" ? b.text.text : b.elements.map((e) => e.text).join("\n"),
      ),
    )
    .join("\n");
}

const model = (over: Partial<FindingsModel> = {}): FindingsModel => ({
  channelId: "C1",
  days: 30,
  clamped: false,
  themes: [
    {
      theme: "会場の選定",
      findings: [
        {
          statement: "オンライン開催の要望が繰り返し出ている",
          evidence: ["1792717200.000100", "1792717260.000200", "1792717320.000300"],
          needsReview: false,
        },
      ],
    },
  ],
  ...over,
});

describe("renderFindings", () => {
  it("確定期間と取得件数・最初と最後をJSTで示し、履歴上限を区別する", () => {
    const text = allText(
      renderFindings(
        model({
          period: {
            start: "2026-10-11T15:00:00.000Z",
            end: "2026-10-18T15:00:00.000Z",
            label: "先週",
            clamped: false,
          },
          scope: { count: 2, firstTs: "1791760000.000000", lastTs: "1791800000.000000" },
        }),
        { permalink },
      ),
    );
    expect(text).toContain("先週");
    expect(text).toContain("対象期間: 2026/10/12 00:00以上〜2026/10/19 00:00未満 JST");
    expect(text).toContain("投稿2件 / 最初");
    expect(text).toContain("/ 最後");
    expect(text).toContain("最大90日");
    expect(text).not.toContain("直近 30 日");
  });

  it("投稿0件では投稿時刻を出さず、確定期間と90日への制限を表示する", () => {
    const text = allText(
      renderFindings(
        model({
          period: {
            start: "2026-07-27T09:00:00.000Z",
            end: "2026-10-25T09:00:00.000Z",
            label: "直近90日",
            clamped: true,
          },
          scope: { count: 0, firstTs: null, lastTs: null },
          themes: [],
        }),
        { permalink },
      ),
    );
    expect(text).toContain("投稿0件");
    expect(text).toContain("90 日に制限");
    expect(text).toContain("対象期間:");
    expect(text).not.toContain("最初");
    expect(text).not.toContain("最後");
  });

  it("見出し（チャネル、期間）、テーマの見出し、根拠のリンク（番号付き）を出す", () => {
    const messages = renderFindings(model(), { permalink });
    expect(messages).toHaveLength(1);
    const text = allText(messages);
    expect(text).toContain("🔎 Findings（<#C1>、直近 30 日）");
    expect(text).toContain("*テーマ: 会場の選定*");
    expect(text).toContain(
      `• オンライン開催の要望が繰り返し出ている  <${permalink("1792717200.000100")}|1> <${permalink("1792717260.000200")}|2> <${permalink("1792717320.000300")}|3>`,
    );
    expect(messages[0]?.text).toContain("Findings");
    expect(text).not.toContain("制限");
  });

  it("根拠が 1 つなら「根拠」、0 件なら「根拠なし」と ⚠️、4 件以上でもリンクは 3 つまで。⚠️ があれば要確認の注記", () => {
    const text = allText(
      renderFindings(
        model({
          themes: [
            {
              theme: "t",
              findings: [
                { statement: "一つ", evidence: ["1792717200.000100"], needsReview: false },
                { statement: "なし", evidence: [], needsReview: true },
                {
                  statement: "多い",
                  evidence: ["1.1", "2.1", "3.1", "4.1", "5.1"].map((s) => `179271${s}`),
                  needsReview: false,
                },
              ],
            },
          ],
        }),
        { permalink },
      ),
    );
    expect(text).toMatch(/• 一つ {2}<[^>]+\|根拠>/);
    expect(text).toMatch(/• なし {2}根拠なし ⚠️/);
    const many = text.split("\n").find((l) => l.startsWith("• 多い")) ?? "";
    expect(many.match(/\|\d>/g)).toHaveLength(3);
    expect(text).toContain("要確認");
  });

  it("clamped なら、90 日に制限した旨を見出しに添える", () => {
    const text = allText(renderFindings(model({ days: 90, clamped: true }), { permalink }));
    expect(text).toContain("直近 90 日");
    expect(text).toMatch(/90 日に制限/);
  });

  it("テーマも Finding もなければ、見つからなかったと返信する", () => {
    const messages = renderFindings(model({ themes: [] }), { permalink });
    expect(allText(messages)).toContain(EMPTY_FINDINGS_TEXT);
    expect(messages[0]?.text).toContain(EMPTY_FINDINGS_TEXT);
  });

  it("AI の文字列の & < > を置き換え、メンションやリンクの記法を無効にする", () => {
    const text = allText(
      renderFindings(
        model({
          themes: [
            {
              theme: "<!channel> & テーマ",
              findings: [
                { statement: "<!here> と <https://x|y>", evidence: ["1.1"], needsReview: false },
              ],
            },
          ],
        }),
        { permalink },
      ),
    );
    expect(text).toContain("*テーマ: &lt;!channel&gt; &amp; テーマ*");
    expect(text).toContain("&lt;!here&gt; と &lt;https://x|y&gt;");
    expect(text).not.toContain("<!here>");
  });

  it("1 つの section は 3,000 文字以内（Finding が多いテーマは「（続き）」に分け、長すぎる文は切る）", () => {
    const findings = Array.from({ length: 80 }, (_, i) => ({
      statement: `${"あ".repeat(100)}${i}`,
      evidence: ["1792717200.000100"],
      needsReview: false,
    }));
    findings.push({
      statement: "い".repeat(5000),
      evidence: ["1792717200.000100"],
      needsReview: false,
    });
    const messages = renderFindings(model({ themes: [{ theme: "多い", findings }] }), {
      permalink,
    });
    const sections = messages
      .flatMap((m) => m.blocks)
      .flatMap((b) => (b.type === "section" ? [b.text.text] : []));
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    expect(sections.some((s) => s.startsWith("*テーマ: 多い（続き）*"))).toBe(true);
    // 切った文にもリンクが残る
    const last = sections.at(-1) ?? "";
    expect(last).toMatch(/…\s+<[^>]+\|根拠>/);
  });

  it("50 ブロックを超えたら、続きの返信に分ける（各返信の先頭に見出し）", () => {
    const themes = Array.from({ length: 120 }, (_, i) => ({
      theme: `テーマ${i}`,
      findings: [{ statement: `文${i}`, evidence: ["1792717200.000100"], needsReview: false }],
    }));
    const messages = renderFindings(model({ themes }), { permalink });
    expect(messages.length).toBeGreaterThan(2);
    for (const m of messages) expect(m.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(messages[0]?.text).toContain("🔎 Findings");
    expect(messages[1]?.text).toContain("🔎 Findings（続き）");
    // すべてのテーマが出る
    const text = allText(messages);
    for (let i = 0; i < 120; i++) expect(text).toContain(`*テーマ: テーマ${i}*`);
  });
});
