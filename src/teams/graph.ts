import { Parser } from "htmlparser2";
import type { TeamsConversation, TeamsGraphReader } from "./types.js";

export type { TeamsGraphReader } from "./types.js";

/** 外部の本文・URL・秘密を引き継がない固定エラー。0 は通信失敗、422 は不正な取得結果。 */
export class TeamsApiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(
      status === 401 || status === 403
        ? "Teams の履歴を読む権限がありません。"
        : status === 404
          ? "Teams の対象メッセージが見つかりません。"
          : "Teams の履歴を完全に取得できませんでした。",
    );
    this.name = "TeamsApiError";
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

/** Retry-Afterの秒数またはHTTP日時だけを読み、外部例外の内容を保持しない。 */
export function parseTeamsRetryAfter(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

const invalid = (): never => {
  throw new TeamsApiError(422);
};

/** HTML の構造だけを読み、リンクを実行せず本文にする。 */
export function teamsHtmlToText(html: string): string {
  let text = "";
  let hidden = 0;
  const newline = () => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "script" || name === "style") hidden++;
        if (hidden > 0) return;
        if (name === "br" || name === "p" || name === "div") newline();
        if (name === "at") text += "@";
      },
      ontext(value) {
        if (hidden === 0) text += value;
      },
      onclosetag(name) {
        if (name === "script" || name === "style") hidden--;
        if (hidden === 0 && (name === "p" || name === "div")) newline();
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return text.replace(/\u00a0/g, " ").trim();
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as ObjectValue;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return invalid();
  return value;
}

function pathSegment(value: string): string {
  const id = nonempty(value);
  if (id === "." || id === "..") return invalid();
  try {
    return encodeURIComponent(id);
  } catch {
    return invalid();
  }
}

function timeMs(value: unknown): number {
  const text = nonempty(value);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!parts) return invalid();
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const ms = Date.parse(text);
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    !Number.isSafeInteger(ms) ||
    ms < 0
  )
    return invalid();
  return ms;
}

type Message = {
  id: string;
  rootId: string;
  isReply: boolean;
  ms: number;
  userId: string | null;
  name: string | null;
  text: string;
  edited: boolean;
  keep: boolean;
  webUrl?: string;
};

function message(value: unknown, rootId?: string): Message {
  const raw = object(value);
  const id = nonempty(raw.id);
  pathSegment(id);
  const ms = timeMs(raw.createdDateTime);
  const from = raw.from == null ? {} : object(raw.from);
  const user = from.user == null ? {} : object(from.user);
  if (
    !["message", "systemEventMessage", "chatEvent", "typing", "unknownFutureValue"].includes(
      String(raw.messageType),
    )
  )
    return invalid();
  if (raw.replyToId != null && raw.replyToId !== rootId) return invalid();
  if (raw.lastEditedDateTime != null) timeMs(raw.lastEditedDateTime);
  if (raw.deletedDateTime != null) timeMs(raw.deletedDateTime);
  const userId = user.id == null ? null : nonempty(user.id);
  const name = typeof user.displayName === "string" ? user.displayName : userId;
  const keep =
    raw.deletedDateTime == null &&
    from.application == null &&
    raw.messageType === "message" &&
    userId !== null;
  // 削除やシステム投稿は本文・投稿者が消えている場合もある。親の対応だけを保持する。
  const body = keep ? object(raw.body) : { contentType: "text", content: "" };
  if (typeof body.content !== "string" || !["html", "text"].includes(String(body.contentType)))
    return invalid();
  return {
    id,
    rootId: rootId ?? id,
    isReply: rootId !== undefined,
    ms,
    userId,
    name,
    text: body.contentType === "html" ? teamsHtmlToText(body.content) : body.content,
    edited: raw.lastEditedDateTime != null,
    keep,
    ...(typeof raw.webUrl === "string" ? { webUrl: raw.webUrl } : {}),
  };
}

function trustedUrl(value: string, origin: string, path?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.origin !== origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (path !== undefined && canonicalPath(url.pathname) !== canonicalPath(path))
  )
    return invalid();
  return url;
}

/** ODataは :/@ の非エンコード形を返す。区切りを保って各segmentを一度だけ比較する。 */
function canonicalPath(path: string): string {
  try {
    return JSON.stringify(path.split("/").map((segment) => decodeURIComponent(segment)));
  } catch {
    return invalid();
  }
}

function link(raw: Message, tenantId: string, teamId: string, channelId: string): string {
  if (raw.webUrl !== undefined) {
    try {
      return trustedUrl(raw.webUrl, "https://teams.microsoft.com").href;
    } catch {
      // 不正な webUrl は元メッセージの ID から公式リンクを生成する。
    }
  }
  const url = new URL(
    `https://teams.microsoft.com/l/message/${pathSegment(channelId)}/${pathSegment(raw.id)}`,
  );
  url.searchParams.set("tenantId", tenantId);
  url.searchParams.set("groupId", teamId);
  url.searchParams.set("parentMessageId", raw.rootId);
  return url.href;
}

function normalize(
  raws: Message[],
  tenantId: string,
  teamId: string,
  channelId: string,
  range?: { start: number; end: number },
): TeamsConversation {
  const identity = (raw: Pick<Message, "rootId" | "id" | "isReply">) =>
    JSON.stringify([raw.rootId, raw.isReply, raw.id]);
  const byId = new Map<string, Message>();
  for (const raw of raws) {
    const previous = byId.get(identity(raw));
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(raw))
      return invalid();
    byId.set(identity(raw), raw);
  }
  const sorted = [...byId.values()].sort(
    (a, b) =>
      a.ms - b.ms ||
      (a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : a.rootId.localeCompare(b.rootId) || Number(a.isReply) - Number(b.isReply)),
  );
  const timestamps = new Map<string, string>();
  let previousMs = -1;
  let suffix = 0;
  for (const raw of sorted) {
    suffix = raw.ms === previousMs ? suffix + 1 : 0;
    if (suffix >= 999) return invalid();
    previousMs = raw.ms;
    const sec = Math.floor(raw.ms / 1000);
    const micros = (raw.ms % 1000) * 1000 + suffix;
    timestamps.set(identity(raw), `${sec}.${String(micros).padStart(6, "0")}`);
  }
  const result: TeamsConversation = {
    messages: [],
    names: new Map(),
    links: new Map(),
    sourceIds: new Map(),
    sourceRefs: new Map(),
  };
  for (const raw of sorted) {
    if (!raw.keep || (range !== undefined && (raw.ms < range.start || raw.ms >= range.end)))
      continue;
    const ts = timestamps.get(identity(raw));
    if (ts === undefined) return invalid();
    const threadTs = !raw.isReply
      ? null
      : timestamps.get(identity({ rootId: raw.rootId, id: raw.rootId, isReply: false }));
    if (threadTs === undefined) return invalid();
    result.messages.push({
      ts,
      threadTs,
      userId: raw.userId,
      text: raw.text,
      edited: raw.edited,
      reactions: [],
    });
    if (raw.userId !== null && raw.name !== null) result.names.set(raw.userId, raw.name);
    result.sourceIds.set(ts, raw.id);
    result.sourceRefs.set(ts, {
      tenantId: tenantId.toLowerCase(),
      teamId: teamId.toLowerCase(),
      channelId,
      rootMessageId: raw.rootId,
      kind: raw.isReply ? "reply" : "root",
      messageId: raw.id,
    });
    result.links.set(ts, link(raw, tenantId, teamId, channelId));
  }
  return result;
}

export function createTeamsGraphReader(options: {
  token: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  tenantId: string;
  maxPages?: number;
  maxMessages?: number;
}): TeamsGraphReader {
  const fetch = options.fetch ?? globalThis.fetch;
  const maxPages = options.maxPages ?? 1000;
  const maxMessages = options.maxMessages ?? 10_000;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    !Number.isSafeInteger(maxMessages) ||
    maxMessages < 1
  )
    return invalid();
  nonempty(options.tenantId);

  function session(teamId: string, channelId: string) {
    const base = `https://graph.microsoft.com/v1.0/teams/${pathSegment(teamId)}/channels/${pathSegment(channelId)}`;
    let requests = 0;
    let count = 0;
    const all: Message[] = [];
    const get = async (url: string): Promise<ObjectValue> => {
      if (requests >= maxPages) return invalid();
      requests++;
      let response: Response;
      try {
        const token = nonempty(await options.token());
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Prefer: "include-unknown-enum-members" },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (error instanceof TeamsApiError) throw error;
        throw new TeamsApiError(0);
      }
      if (!response.ok)
        throw new TeamsApiError(
          response.status,
          parseTeamsRetryAfter(response.headers.get("retry-after")),
        );
      try {
        return object(await response.json());
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TeamsApiError) return invalid();
        throw new TeamsApiError(0);
      }
    };
    const add = (value: unknown, rootId?: string) => {
      count++;
      if (count > maxMessages) return invalid();
      const raw = message(value, rootId);
      all.push(raw);
      return raw;
    };
    const collect = async (initial: string, rootId?: string) => {
      const path = new URL(initial).pathname;
      const visited = new Set<string>();
      let next: string | undefined = initial;
      const collected: Message[] = [];
      while (next !== undefined) {
        const url = trustedUrl(next, "https://graph.microsoft.com", path).href;
        if (visited.has(url)) return invalid();
        visited.add(url);
        const page = await get(url);
        if (!Array.isArray(page.value)) return invalid();
        for (const item of page.value) collected.push(add(item, rootId));
        const link = page["@odata.nextLink"];
        next = link === undefined || link === null ? undefined : nonempty(link);
      }
      return collected;
    };
    const standardChannel = async () => {
      if ((await get(base)).membershipType !== "standard") return invalid();
    };
    return { base, get, add, collect, all, standardChannel };
  }

  return {
    async getThread(teamId, channelId, rootId) {
      const current = session(teamId, channelId);
      const path = `${current.base}/messages/${pathSegment(rootId)}`;
      await current.standardChannel();
      if (current.add(await current.get(path)).id !== rootId) return invalid();
      await current.collect(`${path}/replies`, rootId);
      return normalize(current.all, options.tenantId, teamId, channelId);
    },
    async getChannel(teamId, channelId, start, end) {
      const range = { start: start.getTime(), end: end.getTime() };
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start >= range.end)
        return invalid();
      const current = session(teamId, channelId);
      await current.standardChannel();
      const roots = await current.collect(`${current.base}/messages`);
      // 期間前の親への返信も対象なので、全親を列挙してから全返信を取得する。
      for (const rootId of new Set(roots.map((raw) => raw.id))) {
        await current.collect(`${current.base}/messages/${pathSegment(rootId)}/replies`, rootId);
      }
      // 同一msの採番は取得全量に依存する。再取得では差分ではなく全量を再分析する。
      return normalize(current.all, options.tenantId, teamId, channelId, range);
    },
  };
}
