/** findings の日数の既定と上限（contracts/commands-and-output.md#文法）。 */
export const FINDINGS_DEFAULT_DAYS = 30;
export const FINDINGS_MAX_DAYS = 90;

export type Command =
  | { kind: "summarize" }
  | { kind: "canvas" }
  | { kind: "todo" }
  /** days は上限を適用した後の値。上限を超えて丸めたときは clamped: true。 */
  | { kind: "findings"; days: number; clamped: boolean }
  /** 空メンションと自然文。重い解釈は worker が行う。 */
  | { kind: "request"; text: string };

const SUMMARIZE = new Set(["まとめ", "summary", "要約"]);
const CANVAS = new Set(["canvas", "キャンバス"]);
const TODO = new Set(["todo", "タスク"]);
const FINDINGS = /^(?:findings|振り返り)(?:\s+(\d+)\s*(?:日|days?)?)?$/;

/**
 * メンション `<@BOT>` を除いた本文を解析する。前後の空白を除き、全角を半角にし（NFKC）、
 * 英字の大文字小文字は区別しない。
 */
export function parseCommand(text: string): Command {
  const normalized = text.normalize("NFKC").trim();
  const t = normalized.toLowerCase();
  if (SUMMARIZE.has(t)) return { kind: "summarize" };
  if (CANVAS.has(t)) return { kind: "canvas" };
  if (TODO.has(t)) return { kind: "todo" };

  const m = FINDINGS.exec(t);
  if (m) {
    if (m[1] === undefined) {
      return { kind: "findings", days: FINDINGS_DEFAULT_DAYS, clamped: false };
    }
    const n = Number(m[1]);
    if (n < 1) return { kind: "request", text: normalized };
    if (n > FINDINGS_MAX_DAYS) {
      return { kind: "findings", days: FINDINGS_MAX_DAYS, clamped: true };
    }
    return { kind: "findings", days: n, clamped: false };
  }
  return { kind: "request", text: normalized };
}
