/**
 * 会話の分割（R5）。入力が上限のトークン数を超えるときに使う。
 * スレッド（親と返信）は切らずに同じ塊に入れる。1 つのスレッドが上限を超える場合だけ、時刻順に分ける。
 * 塊の並びと、塊の中のメッセージは ts の昇順。
 */
import { compareTs, type SlackMessage } from "../slack/conversation.js";
import { countTokens } from "./tokens.js";

/** 分割の上限（R5）。 */
export const CHUNK_MAX_TOKENS = 60_000;

/** 1 行の見出し（`[m12] 10/23(金) 14:03 田中 → m10:`）とリアクションの分の見積もり。 */
const LINE_OVERHEAD_TOKENS = 40;
const REACTION_TOKENS = 8;

/** メッセージ 1 件のトークン数の見積もり。 */
export function estimateMessageTokens(message: SlackMessage): number {
  return (
    countTokens(message.text) + LINE_OVERHEAD_TOKENS + REACTION_TOKENS * message.reactions.length
  );
}

export type ChunkOptions = {
  /** 既定は {@link CHUNK_MAX_TOKENS}。 */
  maxTokens?: number;
  /** メッセージ 1 件のトークン数。既定は {@link estimateMessageTokens}。 */
  measure?: (message: SlackMessage) => number;
};

type Unit = { messages: SlackMessage[]; tokens: number };

/** スレッドごと（親がなければ返信どうし、単発は 1 件）にまとめ、先頭の ts の昇順に並べる。 */
function toUnits(messages: SlackMessage[], measure: (m: SlackMessage) => number): Unit[] {
  const sorted = [...messages].sort((a, b) => compareTs(a.ts, b.ts));
  const byRoot = new Map<string, Unit>();
  for (const m of sorted) {
    const root = m.threadTs ?? m.ts;
    const unit = byRoot.get(root) ?? { messages: [], tokens: 0 };
    unit.messages.push(m);
    unit.tokens += measure(m);
    byRoot.set(root, unit);
  }
  return [...byRoot.values()].sort((a, b) =>
    compareTs(a.messages[0]?.ts ?? "0", b.messages[0]?.ts ?? "0"),
  );
}

export function chunkMessages(
  messages: SlackMessage[],
  options: ChunkOptions = {},
): SlackMessage[][] {
  const maxTokens = options.maxTokens ?? CHUNK_MAX_TOKENS;
  const measure = options.measure ?? estimateMessageTokens;

  const chunks: SlackMessage[][] = [];
  let current: SlackMessage[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentTokens = 0;
  };

  for (const unit of toUnits(messages, measure)) {
    if (unit.tokens <= maxTokens) {
      if (currentTokens + unit.tokens > maxTokens) flush();
      current.push(...unit.messages);
      currentTokens += unit.tokens;
      continue;
    }
    // 1 つのスレッドが上限を超える: 溜まった塊を閉じ、時刻順に詰めて分ける。最後の塊は後続が続けて入れる。
    flush();
    for (const m of unit.messages) {
      const t = measure(m);
      if (currentTokens + t > maxTokens) flush();
      current.push(m);
      currentTokens += t;
    }
  }
  flush();
  // 塊の中を ts の昇順にそろえる（スレッドと単発が混ざるため）。
  return chunks.map((c) => c.sort((a, b) => compareTs(a.ts, b.ts)));
}
