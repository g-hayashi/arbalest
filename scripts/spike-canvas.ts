/**
 * R8 の検証（T024）。利用者がテスト用のチャネルで実行する。
 *
 *   SLACK_BOT_TOKEN=... npx tsx scripts/spike-canvas.ts <テスト用チャネルの ID>
 *
 * 確かめること:
 *   1. ボットのトークンで conversations.canvases.create と canvases.edit が動くか。
 *   2. 見出しの section_id に replace すると、見出しの下の本文まで置き換わるか。
 *   3. 節の外に人が書いた内容が残るか。
 * トークンと会話の内容は出力しない。出すのは API の成否と、目印の文字列の有無だけ。
 */
import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
const channelId = process.argv[2];
if (!token || !channelId) {
  console.error("使い方: SLACK_BOT_TOKEN=... npx tsx scripts/spike-canvas.ts <channelId>");
  process.exit(2);
}
const client = new WebClient(token);
const marker = `〔arb:spike-${Date.now()}〕`;

function errorOf(e: unknown): string {
  const data = (e as { data?: { error?: string } }).data;
  return data?.error ?? String(e);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    console.log(`✔ ${name}`);
    return r;
  } catch (e) {
    console.log(`✘ ${name}: ${errorOf(e)}`);
    return undefined;
  }
}

async function getCanvasId(): Promise<string | undefined> {
  const created = await step("1. conversations.canvases.create", () =>
    client.conversations.canvases.create({
      channel_id: channelId,
      document_content: {
        type: "markdown",
        markdown: "# Arbalest 検証\n\n人が書いた行 HUMAN-TOP\n",
      },
    }),
  );
  if (created?.canvas_id) return created.canvas_id;
  // 既にチャネル canvas があるときは、それを使う。
  const info = await step("   conversations.info（既存の canvas）", () =>
    client.conversations.info({ channel: channelId }),
  );
  const props = (info?.channel as { properties?: { canvas?: { file_id?: string } } } | undefined)
    ?.properties;
  return props?.canvas?.file_id;
}

async function lookup(canvasId: string, text: string, headersOnly: boolean): Promise<string[]> {
  const r = await client.canvases.sections.lookup({
    canvas_id: canvasId,
    criteria: headersOnly
      ? { section_types: ["any_header"], contains_text: text }
      : { contains_text: text },
  });
  return (r.sections ?? []).map((s) => s.id ?? "");
}

async function main(): Promise<void> {
  const canvasId = await getCanvasId();
  if (!canvasId) {
    console.log("canvas の ID を得られませんでした。ここで終わります。");
    return;
  }

  await step("1. canvases.edit（insert_at_end: 目印付きの節）", () =>
    client.canvases.edit({
      canvas_id: canvasId,
      changes: [
        {
          operation: "insert_at_end",
          document_content: {
            type: "markdown",
            markdown: `## 調整: 検証 ${marker}\n\n本文 BODY-OLD-1\n\n本文 BODY-OLD-2\n\n## 人の節\n\n人のメモ HUMAN-BOTTOM\n`,
          },
        },
      ],
    }),
  );

  const ids = await step("   canvases.sections.lookup（見出しの目印）", () =>
    lookup(canvasId, marker, true),
  );
  console.log(`   見つかった節: ${ids?.length ?? 0} 件`);
  const sectionId = ids?.[0];
  if (!sectionId) return;

  await step("2. canvases.edit（replace: 見出しの section_id）", () =>
    client.canvases.edit({
      canvas_id: canvasId,
      changes: [
        {
          operation: "replace",
          section_id: sectionId,
          document_content: {
            type: "markdown",
            markdown: `## 調整: 検証 ${marker}\n\n本文 BODY-NEW\n`,
          },
        },
      ],
    }),
  );

  for (const [label, text] of [
    ["目印の見出し", marker],
    ["新しい本文 BODY-NEW", "BODY-NEW"],
    ["古い本文 BODY-OLD-1（残っていれば本文は置き換わっていない）", "BODY-OLD-1"],
    ["古い本文 BODY-OLD-2", "BODY-OLD-2"],
    ["3. 人が書いた行 HUMAN-TOP", "HUMAN-TOP"],
    ["3. 人のメモ HUMAN-BOTTOM", "HUMAN-BOTTOM"],
  ] as const) {
    const found = await lookup(canvasId, text, false).catch((e) => {
      console.log(`   ✘ lookup ${label}: ${errorOf(e)}`);
      return null;
    });
    if (found !== null) console.log(`   ${label}: ${found.length > 0 ? "あり" : "なし"}`);
  }
  console.log("canvas を開き、見た目でも確かめてください（目印の節は手で消して構いません）。");
}

await main();
