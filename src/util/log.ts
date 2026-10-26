/** Cloud Logging の severity。 */
export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

/**
 * 構造化ログを 1 行の JSON で標準出力に出す（Cloud Logging が severity と message を読む）。
 * fields に、トークン・メッセージ本文・AI の入出力の本文を入れないこと。
 */
export function log(
  severity: Severity,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ ...fields, severity, message }));
}
