/** Teams の取得・共通分析・保存・返信。管理操作は任意注入する。 */
import { createHash } from "node:crypto";
import { toSummaryModel } from "../analysis/decide.js";
import { analyzeFindings } from "../analysis/findings.js";
import { analyze } from "../analysis/pipeline.js";
import { PROMPT_VERSION } from "../analysis/prompts/summarize.js";
import { interpretRequest } from "../commands/intent.js";
import { parseCommand } from "../commands/parse.js";
import { LlmError } from "../llm/index.js";
import type { RequestProgressInput } from "../store/types.js";
import { emptyAnalysisState } from "../store/types.js";
import { resolveRequestPeriod } from "../util/time.js";
import { FILTERED_TEXT, type JobContext } from "../worker/server.js";
import { TeamsApiError } from "./graph.js";
import { type TeamsTrust, validateTeamsPayload } from "./ingress.js";
import { flushTeamsTodoCards } from "./records.js";
import {
  escapeTeamsText,
  renderTeamsFindings,
  renderTeamsSummary,
  TEAMS_MESSAGE_LIMIT,
  TEAMS_UNSUPPORTED_NOTE,
} from "./render.js";
import { manageTeamsTodos, type TeamsTodoDeps, type TeamsWorkIntent } from "./todos.js";
import type { TeamsGraphReader, TeamsJobPayload } from "./types.js";

// biome-ignore lint/suspicious/noConfusingVoidType: 送信SDKがIDを返さない場合も受け付ける共通契約。
export type TeamsReply = (payload: TeamsJobPayload, text: string) => Promise<string | void>;

const key = (parts: readonly string[]): string =>
  `teams_${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
export function teamsChannelKey(
  p: Pick<TeamsJobPayload, "tenantId" | "teamId" | "channelId">,
): string {
  return key([p.tenantId.toLowerCase(), p.teamId.toLowerCase(), p.channelId]);
}
export function teamsTargetId(p: TeamsJobPayload): string {
  return key([p.tenantId.toLowerCase(), p.teamId.toLowerCase(), p.channelId, p.rootMessageId]);
}

/** 保存時も再読込時も同じ上限を検証する。Firestore の文書上限には余裕を残す。 */
function validateReplyChunks(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Teams の返信snapshotが不正です");
  }
  // Array.some は疎配列の穴を飛ばすため、欠損も列挙して検証する。
  for (const chunk of value) {
    if (typeof chunk !== "string" || chunk.trim() === "")
      throw new TypeError("Teams の返信snapshotが不正です");
  }
  if (
    value.some((chunk) => chunk.length > TEAMS_MESSAGE_LIMIT) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024
  ) {
    throw new RangeError("Teams の返信snapshotが上限を超えました");
  }
}

export function createTeamsJob(deps: {
  graph: TeamsGraphReader;
  reply: TeamsReply;
  trust: TeamsTrust;
  work?: TeamsTodoDeps;
}): (
  payload: TeamsJobPayload,
  ctx: Pick<JobContext, "store" | "llm" | "now" | "log">,
) => Promise<void> {
  return async (payload, ctx) => {
    const unsupportedNote = deps.work ? "" : `\n${TEAMS_UNSUPPORTED_NOTE}`;
    if (!validateTeamsPayload(payload, deps.trust)) throw new TypeError("Teams の依頼が不正です");
    const targetId = teamsTargetId(payload);
    const channelId = teamsChannelKey(payload);
    const old = await ctx.store.events.getRequestProgress(payload.taskName);
    if (
      old !== null &&
      (old.targetId !== targetId ||
        old.channelId !== channelId ||
        old.threadTs !== payload.rootMessageId ||
        old.mentionTs !== payload.mentionId)
    )
      throw new TypeError("Teams の依頼対象が一致しません");
    const progress: RequestProgressInput = old ?? {
      targetId,
      channelId,
      threadTs: payload.rootMessageId,
      mentionTs: payload.mentionId,
      stages: { todos: "skipped", canvas: "skipped" },
      messages: {},
    };
    if (
      progress.messages === null ||
      typeof progress.messages !== "object" ||
      Array.isArray(progress.messages)
    )
      throw new TypeError("Teams の送信進捗が不正です");
    const slots = Object.entries(progress.messages);
    if (progress.replyChunks !== undefined) {
      validateReplyChunks(progress.replyChunks);
      for (const [slot, messageId] of slots) {
        const found = /^summary:(0|[1-9]\d*)$/.exec(slot);
        if (
          found === null ||
          Number(found[1]) >= progress.replyChunks.length ||
          typeof messageId !== "string" ||
          messageId === ""
        )
          throw new TypeError("Teams の送信slotが不正です");
      }
    } else if (slots.length > 0 || progress.stages.reply === "done") {
      throw new TypeError("Teams の送信進捗に返信snapshotがありません");
    }
    const sync = async (explicitRefresh = false) => {
      if (
        !deps.work?.sync ||
        progress.stages.canvas === "skipped" ||
        progress.stages.canvas === undefined
      )
        return undefined;
      return deps.work.sync({ scope: payload, explicitRefresh });
    };
    if (progress.stages.reply === "done") {
      const result = await sync();
      if (result?.retry) throw result.retry;
      return;
    }
    const manage: typeof manageTeamsTodos = async (input, work) => {
      const outcome = await manageTeamsTodos(input, work);
      progress.stages.todos = outcome.rejected.length > 0 ? "failed" : "done";
      progress.stages.canvas = outcome.record.state === "reserved" ? "failed" : "skipped";
      return outcome;
    };
    let messages = progress.replyChunks;
    if (messages === undefined) {
      const commandMessages = await deps.work?.command?.(payload);
      if (commandMessages) messages = commandMessages;
      else
        try {
          const requestedAt = new Date(payload.requestedAt);
          const command = parseCommand(payload.requestText);
          const workText = payload.requestText.normalize("NFKC").trim();
          const done = /^(?:done|完了)\s+T([1-9]\d*)$/i.exec(workText);
          const workIntent: TeamsWorkIntent | null = deps.work
            ? done
              ? { kind: "done", displayNo: Number(done[1]) }
              : command.kind === "todo" || command.kind === "canvas"
                ? { kind: command.kind }
                : workText === "通知停止"
                  ? { kind: "notifications_off" }
                  : workText === "通知再開"
                    ? { kind: "notifications_on" }
                    : null
            : null;
          const legacyPeriod =
            command.kind === "findings"
              ? resolveRequestPeriod({ kind: "rolling_days", amount: command.days }, requestedAt)
              : null;
          const intent =
            workIntent !== null
              ? { kind: "summary" as const, suppressTodo: false, suppressCanvas: false }
              : command.kind === "findings" && legacyPeriod !== null
                ? {
                    kind: "findings" as const,
                    period: { ...legacyPeriod, clamped: legacyPeriod.clamped || command.clamped },
                    suppressTodo: false,
                    suppressCanvas: false,
                  }
                : (
                    await interpretRequest({
                      text: payload.requestText,
                      llm: ctx.llm,
                      now: requestedAt,
                    })
                  ).intent;
          if (intent.kind === "clarify") {
            messages = [`${escapeTeamsText(intent.question)}${unsupportedNote}`];
          } else if (
            deps.work &&
            workIntent &&
            (workIntent.kind === "done" ||
              workIntent.kind === "notifications_off" ||
              workIntent.kind === "notifications_on")
          ) {
            const prior = await ctx.store.targets.get(targetId);
            const analysis = {
              state: emptyAnalysisState(),
              participants: prior?.participants ?? [],
            };
            const conversation = {
              messages: [],
              names: new Map(analysis.participants.map((person) => [person.userId, person.name])),
              links: new Map(),
              sourceIds: new Map(),
              sourceRefs: new Map(),
            };
            const outcome = await manage(
              { payload, intent: workIntent, conversation, analysis },
              deps.work,
            );
            messages = renderTeamsSummary(toSummaryModel(analysis.state, []), {
              links: conversation.links,
              count: 0,
              firstTs: null,
              lastTs: null,
              work: outcome,
            });
          } else if (intent.kind === "findings") {
            const fetched = await deps.graph.getChannel(
              payload.teamId,
              payload.channelId,
              new Date(intent.period.start),
              new Date(intent.period.end),
            );
            // 共通キャッシュはts/本文を検証する。Teams固有の元IDの再対応・表示名変更も境界で無効にする。
            const mappingKey = key([
              channelId,
              JSON.stringify([...fetched.sourceIds].sort(([a], [b]) => a.localeCompare(b))),
              JSON.stringify([...fetched.names].sort(([a], [b]) => a.localeCompare(b))),
            ]);
            const cacheKey = (value: string) =>
              createHash("sha256")
                .update(JSON.stringify(["teams_findings@1", mappingKey, value]))
                .digest("hex");
            const result = await analyzeFindings({
              llm: ctx.llm,
              messages: fetched.messages,
              names: fetched.names,
              now: requestedAt,
              channelId,
              cache: {
                get: (value) => ctx.store.chunkCache.get(cacheKey(value)),
                put: (value, candidates) => ctx.store.chunkCache.put(cacheKey(value), candidates),
              },
              log: ctx.log,
            });
            ctx.log("INFO", "Teams Findings の分析利用量", {
              channelId,
              messages: fetched.messages.length,
              chunks: result.chunks,
              cacheHits: result.cacheHits,
              candidates: result.candidates,
              calls: result.usage.calls,
              input: result.usage.input,
              cachedInput: result.usage.cachedInput,
              output: result.usage.output,
            });
            messages = renderTeamsFindings(result.themes, {
              links: fetched.links,
              count: fetched.messages.length,
              firstTs: fetched.messages[0]?.ts ?? null,
              lastTs: fetched.messages.at(-1)?.ts ?? null,
              period: intent.period,
              workEnabled: !!deps.work,
            });
          } else {
            const fetched = await deps.graph.getThread(
              payload.teamId,
              payload.channelId,
              payload.rootMessageId,
            );
            // 分析IDが取得全量に依存するため、以前のID・差分を持ち越さない。
            const result = await analyze({
              llm: ctx.llm,
              messages: fetched.messages,
              names: fetched.names,
              now: requestedAt,
              prior: null,
              logFields: { targetId },
            });
            const model = toSummaryModel(
              result.state,
              result.participants,
              result.marks,
              result.speakers,
            );
            await ctx.store.targets.put({
              targetId,
              kind: "thread",
              channelId,
              threadTs: payload.rootMessageId,
              lastAnalyzedTs: result.lastAnalyzedTs,
              analyzedDigest: result.analyzedDigest,
              promptVersion: PROMPT_VERSION,
              participants: result.participants,
              state: result.state,
              nextSeq: result.nextSeq,
              canvasSectionMarker: null,
            });
            ctx.log("INFO", "Teams の分析利用量", {
              targetId,
              calls: result.usage.calls,
              input: result.usage.input,
              cachedInput: result.usage.cachedInput,
              output: result.usage.output,
            });
            messages = renderTeamsSummary(model, {
              links: fetched.links,
              count: fetched.messages.length,
              firstTs: fetched.messages[0]?.ts ?? null,
              lastTs: fetched.messages.at(-1)?.ts ?? null,
              ...(deps.work
                ? {
                    work: await manage(
                      {
                        payload,
                        intent: workIntent ?? intent,
                        conversation: fetched,
                        analysis: result,
                      },
                      deps.work,
                    ),
                  }
                : {}),
            });
          }
        } catch (error) {
          if (error instanceof TeamsApiError && !error.retryable) {
            if (error.status === 404 && deps.work)
              await deps.work.store.disableThread({ scope: payload, now: ctx.now() });
            const text =
              error.status === 401 || error.status === 403
                ? "Teams の履歴を読む権限がありません。"
                : error.status === 404
                  ? "Teams の対象メッセージが見つかりません。"
                  : "Teams の履歴を完全に取得できませんでした。";
            messages = [`${text}${unsupportedNote}`];
          } else if (error instanceof LlmError && error.kind === "content_filter") {
            messages = [`${FILTERED_TEXT}${unsupportedNote}`];
          } else throw error;
        }
      validateReplyChunks(messages);
      progress.replyChunks = [...messages];
      // 完成した返信を先に固定する。以降の再試行は履歴・意図・分析を実行しない。
      await ctx.store.events.saveRequestProgress(payload.taskName, progress);
    }
    // 通常返信snapshotを固定した後だけ副作用へ進む。失敗しても再分析しない。
    const requested = parseCommand(payload.requestText);
    const synced = await sync(requested.kind === "todo" || requested.kind === "canvas");
    if (synced && progress.messages["summary:0"] === undefined) {
      // 副作用の結果は独立した返信slotで示す。失敗を台帳成功へ巻き戻さない。
      const status = `記録: Teams=${synced.teams} / SharePoint=${synced.sharepoint}`;
      if (!messages.at(-1)?.startsWith("記録: Teams=")) messages = [...messages, status];
      else messages = [...messages.slice(0, -1), status];
      validateReplyChunks(messages);
      progress.replyChunks = messages;
      progress.stages.canvas = synced.retry ? "failed" : "done";
      await ctx.store.events.saveRequestProgress(payload.taskName, progress);
    }
    for (const [index, text] of messages.entries()) {
      const slot = `summary:${index}`;
      if (progress.messages[slot] !== undefined) continue;
      const messageId = await deps.reply(payload, text);
      progress.messages[slot] = messageId || "sent";
      // 送信成功からこの保存までの障害では重複が残る。Teams に検索用の投稿キーがないため回復できない。
      await ctx.store.events.saveRequestProgress(payload.taskName, progress);
    }
    if (deps.work?.writer) {
      await flushTeamsTodoCards(
        { payload, activityId: progress.messages["summary:0"] ?? "", text: messages[0] ?? "" },
        { ...deps.work, writer: deps.work.writer },
      );
    }
    progress.stages.reply = "done";
    await ctx.store.events.saveRequestProgress(payload.taskName, progress);
    if (synced?.retry) throw synced.retry;
  };
}
