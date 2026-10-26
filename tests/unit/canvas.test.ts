/**
 * チャネル canvas の読み書き（T025、R8、FR-030〜032、SC-008）。
 * WebClient はフェイク（tests/shared/fakeCanvas.ts）。
 */
import type { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import {
  ensureChannelCanvas,
  upsertSection,
  writeChannelCanvasSection,
} from "../../src/slack/canvas.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { createFakeCanvas, type FakeCanvasOptions } from "../shared/fakeCanvas.js";
import { createFakeSlack } from "../shared/fakeSlack.js";

const NOW = new Date(Date.UTC(2026, 9, 24, 5, 0, 0));
const CHANNEL = "C1";

function setup(options: FakeCanvasOptions = {}) {
  const canvas = createFakeCanvas(options);
  const slack = createFakeSlack(new Map(), { canvas });
  const store = createMemoryStore({ now: () => NOW });
  return { canvas, slack: slack.client as WebClient, store };
}

const marker = (ts: string) => `〔arb:${ts}〕`;
/** 見出し 1 ブロック + 本文 1 ブロックの節（本文は行末の空白 2 つでつなぐ）。 */
const sectionMarkdown = (ts: string, body: string) =>
  `## 調整: 件名 ${marker(ts)}\n\n最終更新: 14:03 ${marker(ts)}  \n${body}`;

describe("ensureChannelCanvas（canvas の ID）", () => {
  it("保存済みの ID があれば、API を呼ばずにそれを使う", async () => {
    const { canvas, slack, store } = setup();
    await store.canvases.set(CHANNEL, "FSTORED");
    expect(await ensureChannelCanvas(slack, store, CHANNEL)).toBe("FSTORED");
    expect(canvas.calls.infos).toBe(0);
    expect(canvas.calls.creates).toBe(0);
  });

  it("保存がなければ conversations.info の tabs から探し、見つけた ID を保存する", async () => {
    const { canvas, slack, store } = setup({ existingCanvasId: "FTAB" });
    expect(await ensureChannelCanvas(slack, store, CHANNEL)).toBe("FTAB");
    expect(canvas.calls.creates).toBe(0);
    expect((await store.canvases.get(CHANNEL))?.canvasId).toBe("FTAB");
  });

  it("tabs にもなければ作って、ID を保存する", async () => {
    const { canvas, slack, store } = setup();
    const id = await ensureChannelCanvas(slack, store, CHANNEL);
    expect(id).toBe("F0CANVAS1");
    expect(canvas.calls.creates).toBe(1);
    expect((await store.canvases.get(CHANNEL))?.canvasId).toBe(id);
  });

  it("create が free_team_canvas_tab_already_exists なら、tabs から探し直す（同時に作った場合）", async () => {
    // 最初の info は stale（canvas があるのに tabs に出ない）→ create が already_exists → 探し直して見つかる
    const { canvas, slack, store } = setup({ existingCanvasId: "FRACE", staleInfoCalls: 1 });
    expect(await ensureChannelCanvas(slack, store, CHANNEL)).toBe("FRACE");
    expect(canvas.calls.creates).toBe(1);
    expect(canvas.calls.infos).toBe(2);
    expect((await store.canvases.get(CHANNEL))?.canvasId).toBe("FRACE");
  });

  it("探し直しても見つからなければ、元のエラーを投げる", async () => {
    // already_exists なのに tabs に出続ける場合は、回復できない
    const { slack, store } = setup({ existingCanvasId: "FX", staleInfoCalls: 2 });
    await expect(ensureChannelCanvas(slack, store, CHANNEL)).rejects.toThrow(
      /free_team_canvas_tab_already_exists/,
    );
  });
});

describe("upsertSection（節の書き込み）", () => {
  it("節がなければ末尾に足す（見出しと本文の 2 ブロック）", async () => {
    const { canvas, slack, store } = setup();
    const id = await ensureChannelCanvas(slack, store, CHANNEL);
    expect(await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 決定A"))).toBe(
      "inserted",
    );
    const blocks = canvas.blocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "header" });
    expect(blocks[0]?.text).toContain(marker("1.1"));
    expect(blocks[1]?.text).toContain("• 決定A");
    expect(canvas.calls.edits.map((e) => e.operation)).toEqual(["insert_at_end"]);
  });

  it("再実行では、見出しを replace して古い本文を 1 件ずつ delete する。節は増えない（SC-008）", async () => {
    const { canvas, slack, store } = setup();
    const id = await ensureChannelCanvas(slack, store, CHANNEL);
    await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 古い"));
    canvas.calls.edits.length = 0;

    expect(await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 新しい"))).toBe(
      "replaced",
    );
    const blocks = canvas.blocks();
    expect(blocks).toHaveLength(2);
    expect(canvas.text()).toContain("• 新しい");
    expect(canvas.text()).not.toContain("• 古い");
    // 1 回の edit は 1 件（フェイクが 2 件以上を invalid_arguments にする）。replace 1 回と delete 1 回。
    expect(canvas.calls.edits.map((e) => e.operation)).toEqual(["replace", "delete"]);
  });

  it("別のスレッドの節と、人が書いた内容は残る（FR-031、US3 シナリオ 2・3）", async () => {
    const { canvas, slack, store } = setup();
    const id = await ensureChannelCanvas(slack, store, CHANNEL);
    canvas.humanAppend("# 議事メモ\n\n人が書いた段落");
    await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 一つ目"));
    await upsertSection(slack, id, marker("2.2"), sectionMarkdown("2.2", "• 二つ目"));
    canvas.humanAppend("節の後に人が書いた段落");

    await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 一つ目（更新）"));

    const text = canvas.text();
    expect(text).toContain("議事メモ");
    expect(text).toContain("人が書いた段落");
    expect(text).toContain("節の後に人が書いた段落");
    expect(text).toContain("• 二つ目");
    expect(text).toContain("• 一つ目（更新）");
    expect(text).not.toMatch(/• 一つ目(?!（)/);
    // 見出し 3 つ（人の 1 つ + 節 2 つ）、本文は 2 + 人の 2
    expect(canvas.blocks().filter((b) => b.kind === "header")).toHaveLength(3);
    expect(canvas.blocks()).toHaveLength(7);
  });

  it("見出しがなく本文だけ残っているときは、本文を消して末尾に足す", async () => {
    const { canvas, slack, store } = setup();
    const id = await ensureChannelCanvas(slack, store, CHANNEL);
    await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 古い"));
    // 人が見出しだけを消した状態を作る
    const header = canvas.blocks().find((b) => b.kind === "header");
    await slack.canvases.edit({
      canvas_id: id,
      changes: [{ operation: "delete", section_id: header?.id as string }],
    });
    expect(canvas.blocks()).toHaveLength(1);

    expect(await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 新しい"))).toBe(
      "inserted",
    );
    expect(canvas.blocks()).toHaveLength(2);
    expect(canvas.text()).not.toContain("• 古い");
    expect(canvas.text()).toContain("• 新しい");
  });

  it("見出しが複数あっても、1 つに置き換えて残りを消す", async () => {
    const { canvas, slack, store } = setup();
    const id = await ensureChannelCanvas(slack, store, CHANNEL);
    canvas.humanAppend(`## 重複 ${marker("1.1")}\n\n本文 ${marker("1.1")}`);
    canvas.humanAppend(`## 重複 ${marker("1.1")}\n\n本文 ${marker("1.1")}`);
    await upsertSection(slack, id, marker("1.1"), sectionMarkdown("1.1", "• 新しい"));
    expect(canvas.blocks()).toHaveLength(2);
  });
});

describe("writeChannelCanvasSection（ID の解決 + 書き込み）", () => {
  it("canvas がなければ作り、節を書く（US3 シナリオ 1）。再実行で作り直さない", async () => {
    const { canvas, slack, store } = setup();
    const first = await writeChannelCanvasSection(slack, store, {
      channelId: CHANNEL,
      marker: marker("1.1"),
      markdown: sectionMarkdown("1.1", "• A"),
    });
    expect(first).toEqual({ canvasId: "F0CANVAS1", action: "inserted" });
    const second = await writeChannelCanvasSection(slack, store, {
      channelId: CHANNEL,
      marker: marker("1.1"),
      markdown: sectionMarkdown("1.1", "• B"),
    });
    expect(second).toEqual({ canvasId: "F0CANVAS1", action: "replaced" });
    expect(canvas.calls.creates).toBe(1);
    expect(canvas.blocks()).toHaveLength(2);
  });
});
