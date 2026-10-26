/** 自然文の依頼を解釈し、共通の会話分析へ接続する。 */
import { interpretRequest } from "../../commands/intent.js";
import type { JobPayload } from "../../jobs/types.js";
import { LlmError } from "../../llm/index.js";
import { NO_UNFURL } from "../../slack/unfurl.js";
import { FILTERED_TEXT, type JobContext } from "../server.js";
import { findingsJob } from "./findings.js";
import { runSummaryRequest } from "./summarize.js";

export async function requestJob(payload: JobPayload, ctx: JobContext): Promise<void> {
  try {
    const { intent, usage } = await interpretRequest({
      text: payload.requestText ?? "",
      llm: ctx.llm,
      now: ctx.now(),
    });
    if (usage !== null)
      ctx.log("INFO", "依頼解釈のAI利用量", {
        command: payload.command,
        input: usage.input,
        cachedInput: usage.cachedInput,
        output: usage.output,
        model: usage.model,
      });
    if (intent.kind === "summary") {
      await runSummaryRequest(payload, ctx, intent);
      return;
    }
    if (intent.kind === "findings") {
      await findingsJob({ ...payload, period: intent.period }, ctx);
      return;
    }
    await ctx.slack.chat.postMessage({
      channel: payload.channelId,
      thread_ts: payload.mentionTs,
      text: intent.question,
      ...NO_UNFURL,
    });
  } catch (error) {
    if (!(error instanceof LlmError) || error.kind !== "content_filter") throw error;
    await ctx.slack.chat.postMessage({
      channel: payload.channelId,
      thread_ts: payload.mentionTs,
      text: FILTERED_TEXT,
      ...NO_UNFURL,
    });
  }
}
