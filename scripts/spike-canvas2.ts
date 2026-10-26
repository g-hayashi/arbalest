/**
 * R8 の追加の検証（T024 の続き）。利用者がテスト用のチャネルで実行する。
 *
 *   SLACK_BOT_TOKEN=... npx tsx scripts/spike-canvas2.ts <テスト用チャネルの ID>
 *
 * 1 回目の検証で、canvas の「節」は見出しや段落などのブロック 1 つ分で、見出しの replace では本文が置き換わらないと分かった。
 * ここでは次を確かめる。
 *   A. どの書き方なら、複数行が 1 つのブロック（同じ section_id）になるか（改行の書き方、箇条書き、チェックリスト、引用）。
 *   B. 本文の行に入れた目印を contains_text で引けるか。
 *   C. delete（section_id 指定）でブロックを消せるか、消した後に人の行が残るか。
 * トークンと会話の内容は出力しない。
 */
import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
const channelId = process.argv[2];
if (!token || !channelId) {
  console.error(
    "使い方: SLACK_BOT_TOKEN=... npx tsx scripts/spike-canvas2.ts <channelId> [canvasId]",
  );
  process.exit(2);
}
const client = new WebClient(token);
const run = Date.now().toString(36);
const marker = `〔arb:spike2-${run}〕`;
const tok = (name: string) => `${name}${run}`.toUpperCase();

function errorOf(e: unknown): string {
  const data = (e as { data?: { error?: string } }).data;
  return data?.error ?? String(e);
}

type Props = {
  canvas?: { file_id?: string };
  tabs?: { type?: string; data?: { file_id?: string } }[];
};

/** 既存のチャネル canvas の ID を探す。引数で渡されたらそれを使う。どの欄で見つかったかを出す（値は出さない）。 */
async function canvasIdOf(): Promise<string | undefined> {
  if (process.argv[3]) {
    console.log("   canvas の ID: 引数");
    return process.argv[3];
  }
  const info = await client.conversations.info({ channel: channelId });
  const props = (info.channel as { properties?: Props } | undefined)?.properties;
  console.log(`   properties の欄: ${Object.keys(props ?? {}).join(", ") || "(なし)"}`);
  if (props?.canvas?.file_id) {
    console.log("   canvas の ID: properties.canvas.file_id");
    return props.canvas.file_id;
  }
  const tab = props?.tabs?.find((t) => t.type === "canvas" && t.data?.file_id);
  if (tab?.data?.file_id) {
    console.log("   canvas の ID: properties.tabs[type=canvas].data.file_id");
    return tab.data.file_id;
  }
  console.log(`   tabs の type: ${(props?.tabs ?? []).map((t) => t.type).join(", ") || "(なし)"}`);
  const created = await client.conversations.canvases.create({ channel_id: channelId });
  return created.canvas_id;
}

async function lookup(canvasId: string, text: string): Promise<string[]> {
  const r = await client.canvases.sections.lookup({
    canvas_id: canvasId,
    criteria: { contains_text: text },
  });
  return (r.sections ?? []).map((s) => s.id ?? "");
}

const pairs: [string, string, string][] = [
  ["改行（行末に空白 2 つ）", tok("PSA"), tok("PSB")],
  ["改行（行末に \\）", tok("PBA"), tok("PBB")],
  ["改行（<br>）", tok("PRA"), tok("PRB")],
  ["箇条書き", tok("LIA"), tok("LIB")],
  ["チェックリスト", tok("CKA"), tok("CKB")],
  ["引用", tok("QTA"), tok("QTB")],
];

async function main(): Promise<void> {
  const canvasId = await canvasIdOf().catch((e) => {
    console.log(`✘ canvas の ID: ${errorOf(e)}`);
    return undefined;
  });
  if (!canvasId) return;

  const [ps, pb, pr, li, ck, qt] = pairs;
  const markdown = [
    `## 検証2 ${marker}`,
    "",
    `${ps[1]} 一行目  \n${ps[2]} 二行目`,
    "",
    `${pb[1]} 一行目\\\n${pb[2]} 二行目`,
    "",
    `${pr[1]} 一行目<br>${pr[2]} 二行目`,
    "",
    `- ${li[1]} 項目1`,
    `- ${li[2]} 項目2 ${marker}`,
    "",
    `- [ ] ${ck[1]} 項目1`,
    `- [ ] ${ck[2]} 項目2`,
    "",
    `> ${qt[1]} 一行目`,
    `> ${qt[2]} 二行目`,
    "",
  ].join("\n");

  try {
    await client.canvases.edit({
      canvas_id: canvasId,
      changes: [{ operation: "insert_at_end", document_content: { type: "markdown", markdown } }],
    });
    console.log("✔ insert_at_end");
  } catch (e) {
    console.log(`✘ insert_at_end: ${errorOf(e)}`);
    return;
  }

  console.log("A. 2 つの行が同じブロックか");
  for (const [label, a, b] of pairs) {
    try {
      const [ia, ib] = [await lookup(canvasId, a), await lookup(canvasId, b)];
      const same = ia.length === 1 && ib.length === 1 && ia[0] === ib[0];
      console.log(
        `   ${label}: ${same ? "同じブロック" : `別（${ia.length} 件 / ${ib.length} 件）`}`,
      );
    } catch (e) {
      console.log(`   ✘ ${label}: ${errorOf(e)}`);
    }
  }

  let markerIds: string[] = [];
  try {
    markerIds = await lookup(canvasId, marker);
    console.log(
      `B. 目印を含むブロック: ${markerIds.length} 件（見出しと箇条書きの 2 行目の 2 件なら本文の目印も引ける）`,
    );
  } catch (e) {
    console.log(`✘ B. lookup: ${errorOf(e)}`);
  }

  // C. 今回足したブロックを、各行の語で引いて全部消す。
  const ids = new Set(markerIds);
  for (const [, a, b] of pairs) {
    for (const t of [a, b]) for (const id of await lookup(canvasId, t).catch(() => [])) ids.add(id);
  }
  // canvases.edit は 1 回に 1 件の変更しか受け付けないので、1 件ずつ消す。
  let deleted = 0;
  for (const id of ids) {
    try {
      await client.canvases.edit({
        canvas_id: canvasId,
        changes: [{ operation: "delete", section_id: id }],
      });
      deleted++;
    } catch (e) {
      console.log(`✘ C. delete: ${errorOf(e)}`);
    }
  }
  console.log(`C. delete: ${deleted} / ${ids.size} ブロック`);
  try {
    const left = await lookup(canvasId, marker);
    const human = await lookup(canvasId, "HUMAN-TOP");
    console.log(
      `   消した後の目印: ${left.length} 件、人の行 HUMAN-TOP: ${human.length > 0 ? "あり" : "なし"}`,
    );
  } catch (e) {
    console.log(`✘ C. lookup: ${errorOf(e)}`);
  }
  console.log(
    "canvas を開き、検証2 の節が消えていて、人の行と前回の節が残っているかを見てください。",
  );
}

await main();
