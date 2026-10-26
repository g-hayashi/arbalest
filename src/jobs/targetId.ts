/**
 * 対象の識別子（data-model.md#識別子）。ロック（job_locks）と targets の ID に使う。
 * - スレッドは `t_<channelId>_<threadTs>`（`.` は `-` に置き換える）。
 * - チャネルの直近は `c_<channelId>`。
 */
export function targetIdOf(channelId: string, threadTs: string | null): string {
  if (threadTs === null) return `c_${channelId}`;
  return `t_${channelId}_${threadTs.replaceAll(".", "-")}`;
}

/** findings の同時実行を抑えるためのロックの ID。findings は保存しないので、ロックにだけ使う。 */
export function findingsLockId(channelId: string): string {
  return `f_${channelId}`;
}
