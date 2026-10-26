/** 依頼文だけを構造化抽出し、コードで操作・抑止・期間を検証する（R1/R4）。 */
import { buildRequestIntentRequest } from "../analysis/prompts/requestIntent.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { type RequestPeriod, resolveRequestPeriod } from "../util/time.js";
import { parseCommand } from "./parse.js";

type Suppression = { suppressTodo: boolean; suppressCanvas: boolean };
export type RequestIntent =
  | ({ kind: "summary" } & Suppression)
  | ({ kind: "findings"; period: RequestPeriod } & Suppression)
  | ({ kind: "clarify"; question: string } & Suppression);

const CLARIFICATION =
  "会話の概要と期間の振り返りのどちらを希望しますか？振り返りなら対象の期間も教えてください。";
const clarify = (): RequestIntent => ({
  kind: "clarify",
  question: CLARIFICATION,
  suppressTodo: true,
  suppressCanvas: true,
});

/** 空と旧summaryコマンドはAIを呼ばない。その他は本文だけをAIに渡す。 */
export async function interpretRequest(options: {
  text: string;
  llm: LlmProvider;
  now: Date;
}): Promise<{ intent: RequestIntent; usage: LlmUsage | null }> {
  const text = options.text.normalize("NFKC").trim();
  if (text === "" || parseCommand(text).kind === "summarize") {
    return { intent: { kind: "summary", suppressTodo: false, suppressCanvas: false }, usage: null };
  }
  const result = await options.llm.generateStructured(buildRequestIntentRequest(text));
  const extracted = result.data;
  const replyOnly = /見るだけ|読むだけ|返信だけ|要約だけ|登録しない|保存しない/.test(text);
  const suppression = {
    suppressTodo: replyOnly || extracted.suppressTodo,
    suppressCanvas: replyOnly || extracted.suppressCanvas,
  };
  let intent: RequestIntent;
  if (extracted.intent === "summary" && extracted.period === null) {
    intent = { kind: "summary", ...suppression };
  } else if (extracted.intent === "findings") {
    const period = resolveRequestPeriod(
      extracted.period ?? { kind: "default", amount: null },
      options.now,
    );
    intent = period === null ? clarify() : { kind: "findings", period, ...suppression };
  } else {
    intent = clarify();
  }
  return { intent, usage: result.usage };
}
