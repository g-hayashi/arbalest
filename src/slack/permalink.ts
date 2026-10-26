/** パーマリンクの組み立て（R7）。`chat.getPermalink` は呼ばず、`auth.test` の url から組み立てる。 */

/** `WebClient` のうち、使う部分だけ。 */
export interface SlackAuthClient {
  auth: { test(): Promise<{ url?: string }> };
}

/**
 * `https://<domain>.slack.com/archives/<channel>/p<ts の数字>`。
 * スレッドの返信（threadTs があり ts と違う）なら `?thread_ts=<threadTs>&cid=<channel>` を付ける。
 */
export function buildPermalink(
  workspaceUrl: string,
  channelId: string,
  ts: string,
  threadTs: string | null,
): string {
  const base = workspaceUrl.replace(/\/+$/, "");
  const link = `${base}/archives/${channelId}/p${ts.replace(".", "")}`;
  if (threadTs !== null && threadTs !== ts) {
    return `${link}?thread_ts=${threadTs}&cid=${channelId}`;
  }
  return link;
}

export interface PermalinkBuilder {
  permalink(channelId: string, ts: string, threadTs: string | null): Promise<string>;
}

/** auth.test の url を初回に取ってキャッシュする。失敗したときはキャッシュせず、次の呼び出しで取り直す。 */
export function createPermalinkBuilder(client: SlackAuthClient): PermalinkBuilder {
  let workspaceUrl: Promise<string> | undefined;
  const load = async (): Promise<string> => {
    const res = await client.auth.test();
    if (!res.url) throw new Error("auth.test の応答に url がありません");
    return res.url;
  };
  return {
    async permalink(channelId, ts, threadTs) {
      workspaceUrl ??= load();
      try {
        return buildPermalink(await workspaceUrl, channelId, ts, threadTs);
      } catch (error) {
        workspaceUrl = undefined;
        throw error;
      }
    },
  };
}
