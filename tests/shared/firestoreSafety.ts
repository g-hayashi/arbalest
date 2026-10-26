/**
 * R9 の安全のための約束。テスト用データベースの ID を検証する。
 * 本番の `(default)` に接続しそうなら、テストを始めずに例外にする。
 */
export function assertSafeTestDatabase(databaseId: string): void {
  const id = databaseId.trim();
  if (id === "" || id === "(default)") {
    throw new Error(
      "FIRESTORE_TEST_DATABASE が (default) または空です。テスト専用のデータベース（arbalest-test）を指定してください。",
    );
  }
}

/** `t<日時>_<乱数>_`（例: `t20251024140300_a1b2c3d4_`）。実行ごとに異なる接頭辞。 */
export function newTestPrefix(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "");
  const rand = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `t${stamp}_${rand}_`;
}
