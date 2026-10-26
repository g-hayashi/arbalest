/**
 * 会話の取得（R11）。スレッドは conversations.replies、チャネルは conversations.history。
 * 429 は WebClient の自動の再試行に任せる。クライアントは差し替え可能（テストはフェイク）。
 */

/** Slack が返すメッセージのうち、使う欄だけ。 */
export type RawSlackMessage = {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { user?: string; ts?: string };
  reactions?: { name?: string; count?: number; users?: string[] }[];
};

type Page = {
  messages?: RawSlackMessage[];
  response_metadata?: { next_cursor?: string };
};

/** `WebClient` のうち、使う部分だけ。 */
export interface SlackConversationClient {
  conversations: {
    replies(args: {
      channel: string;
      ts: string;
      cursor?: string;
      limit?: number;
      oldest?: string;
      latest?: string;
      inclusive?: boolean;
    }): Promise<Page>;
    history(args: {
      channel: string;
      cursor?: string;
      limit?: number;
      oldest?: string;
      latest?: string;
      inclusive?: boolean;
    }): Promise<Page>;
  };
}

export type SlackMessage = {
  ts: string;
  /** スレッドの返信なら親の ts。親・単発のメッセージは null。 */
  threadTs: string | null;
  /** 投稿者。ユーザーの情報が無いメッセージは null。 */
  userId: string | null;
  /** 編集後の本文（Slack が返す text）。 */
  text: string;
  edited: boolean;
  reactions: { name: string; userIds: string[] }[];
};

export type FetchOptions = {
  /** 自分（ボット）のユーザー ID。このユーザーの投稿は除く。 */
  botUserId?: string;
};

const PAGE_SIZE = 200;
/** 無償プランの履歴上限。期間前の親を無制限に遡らない。 */
const HISTORY_MAX_SECONDS = 90 * 24 * 60 * 60;

/** 取り込まない subtype。join / leave / channel_* と、group_ / bot_message。 */
function isExcludedSubtype(subtype: string | undefined): boolean {
  if (subtype === undefined) return false;
  return (
    subtype === "bot_message" ||
    subtype === "channel_join" ||
    subtype === "channel_leave" ||
    subtype === "group_join" ||
    subtype === "group_leave" ||
    subtype.startsWith("channel_") ||
    subtype.startsWith("group_")
  );
}

function shouldKeep(raw: RawSlackMessage, options: FetchOptions): boolean {
  if (raw.bot_id !== undefined) return false;
  if (isExcludedSubtype(raw.subtype)) return false;
  if (options.botUserId !== undefined && raw.user === options.botUserId) return false;
  return true;
}

function toMessage(raw: RawSlackMessage): SlackMessage {
  // 親自身の thread_ts は自分の ts と同じ。返信のときだけ threadTs を持たせる。
  const threadTs = raw.thread_ts !== undefined && raw.thread_ts !== raw.ts ? raw.thread_ts : null;
  return {
    ts: raw.ts,
    threadTs,
    userId: raw.user ?? null,
    text: raw.text ?? "",
    edited: raw.edited !== undefined,
    reactions: (raw.reactions ?? [])
      .filter((r): r is typeof r & { name: string } => typeof r.name === "string")
      .map((r) => ({ name: r.name, userIds: r.users ?? [] })),
  };
}

/** cursor を辿って全ページのメッセージを集める。 */
async function collectPages(
  fetchPage: (cursor: string | undefined) => Promise<Page>,
): Promise<RawSlackMessage[]> {
  const out: RawSlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    out.push(...(page.messages ?? []));
    const next = page.response_metadata?.next_cursor;
    cursor = next === undefined || next === "" ? undefined : next;
  } while (cursor !== undefined);
  return out;
}

function finalize(raws: RawSlackMessage[], options: FetchOptions): SlackMessage[] {
  const byTs = new Map<string, SlackMessage>();
  for (const raw of raws) {
    if (!shouldKeep(raw, options)) continue;
    if (!byTs.has(raw.ts)) byTs.set(raw.ts, toMessage(raw));
  }
  return [...byTs.values()].sort((a, b) => compareTs(a.ts, b.ts));
}

/** Slack の ts を数値として比べる（秒.マイクロ秒の固定長なので、整数部と小数部に分ける）。 */
export function compareTs(a: string, b: string): number {
  const [as = "0", af = ""] = a.split(".");
  const [bs = "0", bf = ""] = b.split(".");
  if (as.length !== bs.length) return as.length - bs.length;
  if (as !== bs) return as < bs ? -1 : 1;
  const fa = af.padEnd(6, "0");
  const fb = bf.padEnd(6, "0");
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

async function fetchReplies(
  client: SlackConversationClient,
  channelId: string,
  threadTs: string,
  range?: { oldest: string; latest: string },
): Promise<RawSlackMessage[]> {
  return collectPages((cursor) =>
    client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      cursor,
      limit: PAGE_SIZE,
      ...(range !== undefined ? { ...range, inclusive: true } : {}),
    }),
  );
}

/** スレッド（親と返信）を ts の昇順で返す。 */
export async function fetchThreadMessages(
  client: SlackConversationClient,
  channelId: string,
  threadTs: string,
  options: FetchOptions = {},
): Promise<SlackMessage[]> {
  return finalize(await fetchReplies(client, channelId, threadTs), options);
}

/**
 * チャネルの oldest 以降のメッセージを ts の昇順で返す。
 * latest 指定時は開始を含み、終了を含まない。展開した返信にも同じ範囲を適用する。
 * 期間前の親も終了から90日まで探すが、その本文は分析対象に含めない。
 * 返信のある親は conversations.replies で展開し、返信も含める。
 */
export async function fetchChannelMessages(
  client: SlackConversationClient,
  channelId: string,
  options: FetchOptions & { oldest: string; latest?: string },
): Promise<SlackMessage[]> {
  const top = await collectPages((cursor) =>
    client.conversations.history({
      channel: channelId,
      oldest: options.oldest,
      ...(options.latest !== undefined ? { latest: options.latest, inclusive: true } : {}),
      cursor,
      limit: PAGE_SIZE,
    }),
  );
  const all = [...top];
  const parents = [...top];
  const range =
    options.latest !== undefined ? { oldest: options.oldest, latest: options.latest } : undefined;
  if (range !== undefined) {
    // 小数部を保ち、Slack ts のマイクロ秒境界を丸めずに90日を引く。
    const [seconds = "0", fraction = "000000"] = range.latest.split(".");
    const parentSeconds = Number(seconds) - HISTORY_MAX_SECONDS;
    const parentOldest = parentSeconds < 0 ? "0.000000" : `${parentSeconds}.${fraction}`;
    if (compareTs(parentOldest, range.oldest) < 0) {
      const earlier = await collectPages((cursor) =>
        client.conversations.history({
          channel: channelId,
          oldest: parentOldest,
          latest: range.oldest,
          inclusive: true,
          cursor,
          limit: PAGE_SIZE,
        }),
      );
      parents.push(
        ...earlier.filter(
          (raw) =>
            compareTs(raw.ts, parentOldest) >= 0 &&
            compareTs(raw.ts, range.oldest) < 0 &&
            (raw.latest_reply === undefined || compareTs(raw.latest_reply, range.oldest) >= 0),
        ),
      );
    }
  }
  const expanded = new Set<string>();
  for (const raw of parents) {
    const isParent = raw.thread_ts !== undefined && raw.thread_ts === raw.ts;
    if (isParent && (raw.reply_count ?? 0) > 0 && !expanded.has(raw.ts)) {
      expanded.add(raw.ts);
      all.push(...(await fetchReplies(client, channelId, raw.ts, range)));
    }
  }
  return finalize(all, options).filter(
    (message) =>
      options.latest === undefined ||
      (compareTs(message.ts, options.oldest) >= 0 && compareTs(message.ts, options.latest) < 0),
  );
}
