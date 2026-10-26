/** ユーザーの表示名（R11）。`users.info` の結果を 1 時間、メモリにキャッシュする。 */

/** `deleted` は退出・削除されたユーザー（`users.info` の `deleted`、または user_not_found）。リマインドの宛先の判断に使う。 */
export type SlackUser = { id: string; name: string; deleted: boolean };

/** `WebClient` のうち、使う部分だけ。 */
export interface SlackUsersClient {
  users: {
    info(args: { user: string }): Promise<{
      user?: {
        id?: string;
        name?: string;
        deleted?: boolean;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      };
    }>;
  };
}

export interface UserResolver {
  getUser(userId: string): Promise<SlackUser>;
}

export const USER_CACHE_TTL_MS = 60 * 60 * 1000;

type CachedUser = { user: SlackUser; fetchedAt: number };
/** worker が共有する client ごとに保持し、別ワークスペースの client とは共有しない。 */
const caches = new WeakMap<SlackUsersClient, Map<string, CachedUser>>();

function isUserNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const data = (error as { data?: { error?: unknown } }).data;
  return data?.error === "user_not_found";
}

/** display_name → real_name → name → ID の順で選ぶ。空文字は飛ばす。 */
function pickName(userId: string, info: Awaited<ReturnType<SlackUsersClient["users"]["info"]>>) {
  const u = info.user;
  const candidates = [u?.profile?.display_name, u?.profile?.real_name, u?.real_name, u?.name];
  return candidates.find((c) => c !== undefined && c !== "") ?? userId;
}

export function createUserResolver(
  client: SlackUsersClient,
  now: () => Date,
  ttlMs: number = USER_CACHE_TTL_MS,
): UserResolver {
  const cache = caches.get(client) ?? new Map<string, CachedUser>();
  caches.set(client, cache);
  return {
    async getUser(userId) {
      const cached = cache.get(userId);
      if (cached && cached.fetchedAt + ttlMs > now().getTime()) return cached.user;
      let user: SlackUser;
      try {
        const info = await client.users.info({ user: userId });
        user = { id: userId, name: pickName(userId, info), deleted: info.user?.deleted === true };
      } catch (error) {
        // 削除されたユーザーなど。ID を名前にして続ける（キャッシュはしない）。
        if (isUserNotFound(error)) return { id: userId, name: userId, deleted: true };
        throw error;
      }
      cache.set(userId, { user, fetchedAt: now().getTime() });
      return user;
    },
  };
}
