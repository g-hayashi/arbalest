/**
 * チャネル canvas の読み書き（US3、research.md R8、FR-030〜032）。
 * - canvas の ID: `canvases/{channelId}` → `conversations.info` の tabs → `conversations.canvases.create`。
 * - 節は「目印付きの h2 の見出し」と「本文の 1 ブロック」。目印（`〔arb:<threadTs>〕`）で引き、見出しを replace、
 *   残りのブロックを 1 件ずつ delete する（`canvases.edit` の `changes` は 1 回に 1 件まで）。
 * - 節の外（人が書いた内容、別のスレッドの節）は変えない。
 */

import type { WebClient } from "@slack/web-api";
import type { Store } from "../store/types.js";

/** チャネル canvas が既にあるときの create のエラー（R8）。 */
export const CANVAS_ALREADY_EXISTS = "free_team_canvas_tab_already_exists";

/** Slack の API のエラーコード（`data.error`）。なければ undefined。 */
export function slackErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === "string" ? code : undefined;
}

type ChannelProperties = { tabs?: { type?: string; data?: { file_id?: string } }[] };

/** `conversations.info` の tabs にある canvas の ID。なければ null。 */
async function findTabCanvasId(slack: WebClient, channelId: string): Promise<string | null> {
  const info = await slack.conversations.info({ channel: channelId });
  const properties = (info.channel as { properties?: ChannelProperties } | undefined)?.properties;
  const tab = properties?.tabs?.find((t) => t.type === "canvas" && t.data?.file_id !== undefined);
  return tab?.data?.file_id ?? null;
}

/** チャネル canvas の ID を返す。なければ作る。見つけた・作った ID は保存する。 */
export async function ensureChannelCanvas(
  slack: WebClient,
  store: Pick<Store, "canvases">,
  channelId: string,
): Promise<string> {
  const stored = await store.canvases.get(channelId);
  if (stored !== null) return stored.canvasId;

  const found = await findTabCanvasId(slack, channelId);
  if (found !== null) {
    await store.canvases.set(channelId, found);
    return found;
  }

  try {
    const created = await slack.conversations.canvases.create({ channel_id: channelId });
    if (created.canvas_id === undefined) {
      throw new Error("conversations.canvases.create の応答に canvas_id がありません");
    }
    await store.canvases.set(channelId, created.canvas_id);
    return created.canvas_id;
  } catch (error) {
    if (slackErrorCode(error) !== CANVAS_ALREADY_EXISTS) throw error;
    // 同時に作られた。tabs から探し直す。
    const again = await findTabCanvasId(slack, channelId);
    if (again === null) throw error;
    await store.canvases.set(channelId, again);
    return again;
  }
}

async function lookupIds(
  slack: WebClient,
  canvasId: string,
  marker: string,
  headersOnly: boolean,
): Promise<string[]> {
  const res = await slack.canvases.sections.lookup({
    canvas_id: canvasId,
    criteria: headersOnly
      ? { contains_text: marker, section_types: ["any_header"] }
      : { contains_text: marker },
  });
  return (res.sections ?? []).flatMap((s) => (s.id !== undefined ? [s.id] : []));
}

const insertAtEnd = (slack: WebClient, canvasId: string, markdown: string) =>
  slack.canvases.edit({
    canvas_id: canvasId,
    changes: [{ operation: "insert_at_end", document_content: { type: "markdown", markdown } }],
  });

const deleteSection = (slack: WebClient, canvasId: string, sectionId: string) =>
  slack.canvases.edit({
    canvas_id: canvasId,
    changes: [{ operation: "delete", section_id: sectionId }],
  });

/**
 * 目印の節を書く。`markdown` は見出しと本文（目印は両方に入っていること）。
 * 節がなければ末尾に足す（inserted）。あれば見出しを置き換えて、古い本文を消す（replaced）。
 */
export async function upsertSection(
  slack: WebClient,
  canvasId: string,
  marker: string,
  markdown: string,
): Promise<"inserted" | "replaced"> {
  const all = await lookupIds(slack, canvasId, marker, false);
  const headers = await lookupIds(slack, canvasId, marker, true);
  const [headerId] = headers;

  if (headerId === undefined) {
    // 見出しがない。本文だけ残っていれば消してから足す。
    for (const id of all) await deleteSection(slack, canvasId, id);
    await insertAtEnd(slack, canvasId, markdown);
    return "inserted";
  }

  await slack.canvases.edit({
    canvas_id: canvasId,
    changes: [
      {
        operation: "replace",
        section_id: headerId,
        document_content: { type: "markdown", markdown },
      },
    ],
  });
  for (const id of all) {
    if (id !== headerId) await deleteSection(slack, canvasId, id);
  }
  return "replaced";
}

/** canvas の ID を決めて（なければ作って）、節を書く。 */
export async function writeChannelCanvasSection(
  slack: WebClient,
  store: Pick<Store, "canvases">,
  input: { channelId: string; marker: string; markdown: string },
): Promise<{ canvasId: string; action: "inserted" | "replaced" }> {
  const canvasId = await ensureChannelCanvas(slack, store, input.channelId);
  const action = await upsertSection(slack, canvasId, input.marker, input.markdown);
  return { canvasId, action };
}
