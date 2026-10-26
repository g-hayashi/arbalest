/**
 * チャネル canvas のフェイク（外部に接続しない）。R8 で実際の Slack で確かめた挙動を再現する。
 * - canvas はブロックの配列。見出し（`#` 〜 `###`）は 1 ブロック。行末の空白 2 つ（か `\`）でつないだ行は 1 ブロック。
 *   箇条書き（`- `、`* `、`1. `）と引用（`> `）の行は 1 行ごとに別のブロック。空行で区切る。
 * - `canvases.edit` の `changes` は 1 件まで（2 件以上は `invalid_arguments`）。
 * - `sections.lookup` は `contains_text` と `section_types` を解釈する。
 * - `conversations.info` は canvas があれば `properties.tabs[]`（`type: "canvas"`）に ID を出す。
 * - canvas があるチャネルで `conversations.canvases.create` すると `free_team_canvas_tab_already_exists`。
 */

export type FakeCanvasBlock = { id: string; kind: "header" | "text"; text: string };

type SlackError = Error & { code: string; data: { ok: false; error: string } };

function slackError(error: string): SlackError {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false as const, error },
  });
}

export type FakeCanvasOptions = {
  /** 最初からあるチャネル canvas の ID。 */
  existingCanvasId?: string;
  /** 最初の n 回の `conversations.info` は、canvas があっても tabs に出さない（同時に作られた場合の再現）。 */
  staleInfoCalls?: number;
  /** true なら `files.info` が失敗する（permalink の予備の確認用）。 */
  filesInfoFails?: boolean;
};

export type FakeCanvas = {
  /** 今の canvas の ID。まだなければ null。 */
  canvasId(): string | null;
  /** 今のブロック。 */
  blocks(): FakeCanvasBlock[];
  /** ブロックの本文を順につないだもの。 */
  text(): string;
  /** 人が canvas の末尾に書き足す（ボットの節の外の内容）。 */
  humanAppend(markdown: string): void;
  /** 呼び出しの記録。 */
  calls: {
    edits: { operation: string; section_id?: string }[];
    creates: number;
    infos: number;
  };
  /** WebClient に混ぜるメソッド。 */
  api: {
    conversations: {
      info: (args: { channel: string }) => Promise<unknown>;
      canvases: { create: (args: { channel_id: string }) => Promise<unknown> };
    };
    canvases: {
      edit: (args: { canvas_id: string; changes: unknown[] }) => Promise<unknown>;
      sections: { lookup: (args: { canvas_id: string; criteria: unknown }) => Promise<unknown> };
    };
    files: { info: (args: { file: string }) => Promise<unknown> };
  };
};

const HEADING = /^#{1,3}\s/;
const OWN_BLOCK = /^(?:- |\* |> |\d+\. )/;

/** markdown をブロックに分ける。 */
function parse(markdown: string, nextId: () => string): FakeCanvasBlock[] {
  const blocks: FakeCanvasBlock[] = [];
  let current: string[] | null = null;
  const close = () => {
    if (current !== null) blocks.push({ id: nextId(), kind: "text", text: current.join("\n") });
    current = null;
  };
  let previous = "";
  for (const line of markdown.split("\n")) {
    if (line.trim() === "") {
      close();
    } else if (HEADING.test(line)) {
      close();
      blocks.push({ id: nextId(), kind: "header", text: line.replace(/^#{1,3}\s/, "") });
    } else if (OWN_BLOCK.test(line)) {
      close();
      blocks.push({ id: nextId(), kind: "text", text: line });
    } else if (current !== null && (previous.endsWith("  ") || previous.endsWith("\\"))) {
      current.push(line);
    } else {
      close();
      current = [line];
    }
    previous = line;
  }
  close();
  return blocks;
}

export function createFakeCanvas(options: FakeCanvasOptions = {}): FakeCanvas {
  let canvasId: string | null = options.existingCanvasId ?? null;
  const blocks: FakeCanvasBlock[] = [];
  let seq = 0;
  let creates = 0;
  let infos = 0;
  let staleLeft = options.staleInfoCalls ?? 0;
  const edits: { operation: string; section_id?: string }[] = [];
  const nextId = () => `temp:C:${++seq}`;

  const requireCanvas = (id: string): void => {
    if (canvasId === null || id !== canvasId) throw slackError("canvas_not_found");
  };

  return {
    canvasId: () => canvasId,
    blocks: () => structuredClone(blocks),
    text: () => blocks.map((b) => b.text).join("\n"),
    humanAppend: (markdown) => {
      blocks.push(...parse(markdown, nextId));
    },
    calls: {
      edits,
      get creates() {
        return creates;
      },
      get infos() {
        return infos;
      },
    },
    api: {
      conversations: {
        info: async () => {
          infos++;
          const stale = staleLeft > 0;
          if (stale) staleLeft--;
          const tabs =
            canvasId !== null && !stale
              ? [
                  { type: "files" },
                  { type: "canvas", data: { file_id: canvasId } },
                  { type: "bookmarks" },
                ]
              : [{ type: "files" }, { type: "bookmarks" }];
          return { ok: true, channel: { properties: { tabs } } };
        },
        canvases: {
          create: async () => {
            creates++;
            if (canvasId !== null) throw slackError("free_team_canvas_tab_already_exists");
            canvasId = "F0CANVAS1";
            return { ok: true, canvas_id: canvasId };
          },
        },
      },
      canvases: {
        edit: async ({ canvas_id, changes }) => {
          if (changes.length !== 1) throw slackError("invalid_arguments");
          requireCanvas(canvas_id);
          const change = changes[0] as {
            operation: string;
            section_id?: string;
            document_content?: { markdown: string };
          };
          edits.push({
            operation: change.operation,
            ...(change.section_id !== undefined ? { section_id: change.section_id } : {}),
          });
          const index =
            change.section_id === undefined
              ? -1
              : blocks.findIndex((b) => b.id === change.section_id);
          const needsSection = change.operation === "replace" || change.operation === "delete";
          if (needsSection && index < 0) throw slackError("section_not_found");
          const content = change.document_content?.markdown;
          switch (change.operation) {
            case "insert_at_end":
              if (content === undefined) throw slackError("invalid_arguments");
              blocks.push(...parse(content, nextId));
              break;
            case "replace":
              if (content === undefined) throw slackError("invalid_arguments");
              blocks.splice(index, 1, ...parse(content, nextId));
              break;
            case "delete":
              blocks.splice(index, 1);
              break;
            default:
              throw slackError("invalid_arguments");
          }
          return { ok: true };
        },
        sections: {
          lookup: async ({ canvas_id, criteria }) => {
            requireCanvas(canvas_id);
            const c = criteria as { contains_text?: string; section_types?: string[] };
            const found = blocks.filter((b) => {
              if (c.contains_text !== undefined && !b.text.includes(c.contains_text)) return false;
              if (c.section_types !== undefined) {
                const isHeader = b.kind === "header";
                const wanted = c.section_types.some((t) => t === "any_header" || t === "h2");
                if (!isHeader || !wanted) return false;
              }
              return true;
            });
            return { ok: true, sections: found.map((b) => ({ id: b.id })) };
          },
        },
      },
      files: {
        info: async ({ file }) => {
          if (options.filesInfoFails === true) throw slackError("missing_scope");
          return {
            ok: true,
            file: { id: file, permalink: `https://example.slack.com/docs/T1/${file}` },
          };
        },
      },
    },
  };
}
