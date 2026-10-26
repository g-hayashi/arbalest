/** Teams 専用台帳と、外部送信前の記録予約。送信は呼び出し元で行う。 */
import { createHash } from "node:crypto";
import { toSummaryModel } from "../analysis/decide.js";
import type { AnalysisState, Participant } from "../store/types.js";
import { reserveTeamsTodoCards, type TeamsRecordWriter } from "./records.js";
import { renderTeamsSummary } from "./render.js";
import { teamsSharePointAnalysis } from "./sharepoint.js";
import type { TeamsRecord, TeamsTodo, TeamsTodoCandidate, TeamsWorkStore } from "./store/types.js";
import {
  matchTeamsTodos,
  type TeamsTodoMatch,
  TeamsWorkError,
  type TeamsWorkErrorCode,
} from "./todo-identity.js";
import type { TeamsConversation, TeamsJobPayload } from "./types.js";

export type TeamsWorkIntent =
  | { kind: "summary"; suppressTodo: boolean; suppressCanvas: boolean }
  | { kind: "todo" | "canvas" | "findings" }
  | { kind: "done"; displayNo: number }
  | { kind: "notifications_off" | "notifications_on" }
  | { kind: "register"; candidate: TeamsTodoCandidate; explicitNew?: boolean }
  | {
      kind: "link" | "confirm_update";
      candidate: TeamsTodoCandidate;
      todoId: string;
      expectedRevision: number;
    };
export type TeamsAnalysisResult = { state: AnalysisState; participants: Participant[] };
export type TeamsTodoDeps = {
  store: TeamsWorkStore;
  now: () => Date;
  writer?: TeamsRecordWriter;
  todoEnabled?: boolean;
  recordEnabled?: boolean;
  sync?: (input: {
    scope: TeamsJobPayload;
    explicitRefresh?: boolean;
    repair?: boolean;
  }) => Promise<{ teams: string; sharepoint: string; retry?: unknown }>;
  command?: (payload: TeamsJobPayload) => Promise<string[] | null>;
};
export type TeamsTodoOutcome = {
  names: Record<string, string>;
  candidates: {
    candidate: TeamsTodoCandidate;
    match: TeamsTodoMatch | null;
    rejected: TeamsWorkErrorCode | null;
  }[];
  todos: TeamsTodo[];
  changed: number;
  rejected: TeamsWorkErrorCode[];
  record: {
    state: "reserved" | "skipped" | "rejected";
    revision: number | null;
    operationId: string | null;
  };
};
const normalize = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");
const scopeKey = (scope: TeamsJobPayload | TeamsTodoCandidate["evidence"][number]["ref"]) =>
  JSON.stringify([
    scope.tenantId.toLowerCase(),
    scope.teamId.toLowerCase(),
    scope.channelId,
    scope.rootMessageId,
  ]);

/** 保存済みの明示候補にも取得し直した本文・日時・リンク・参加者を適用する。 */
function verify(
  candidate: TeamsTodoCandidate,
  payload: TeamsJobPayload,
  conversation: TeamsConversation,
): void {
  matchTeamsTodos({ scope: payload, candidates: [candidate], existing: [] });
  for (const evidence of candidate.evidence) {
    const entry = [...conversation.sourceRefs].find(
      ([, ref]) =>
        scopeKey(ref) === scopeKey(evidence.ref) &&
        ref.kind === evidence.ref.kind &&
        ref.messageId === evidence.ref.messageId,
    );
    const message = entry && conversation.messages.find((item) => item.ts === entry[0]);
    const timestamp = message && /^(\d+)\.(\d{6})$/.exec(message.ts);
    const milliseconds = timestamp
      ? Number(timestamp[1]) * 1000 + Number(timestamp[2]?.slice(0, 3))
      : Number.NaN;
    if (
      !message ||
      !normalize(evidence.quote) ||
      !normalize(message.text).includes(normalize(evidence.quote)) ||
      conversation.links.get(message.ts) !== evidence.link ||
      Date.parse(evidence.sourceCreatedAt) !== milliseconds
    )
      throw new TeamsWorkError("invalid_evidence");
  }
  if (
    candidate.assigneeAadId !== null &&
    !conversation.messages.some(
      (item) => item.userId?.toLowerCase() === candidate.assigneeAadId?.toLowerCase(),
    )
  )
    throw new TeamsWorkError("invalid_evidence");
}

export async function manageTeamsTodos(
  input: {
    payload: TeamsJobPayload;
    intent: TeamsWorkIntent;
    conversation: TeamsConversation;
    analysis: TeamsAnalysisResult;
  },
  deps: TeamsTodoDeps,
): Promise<TeamsTodoOutcome> {
  const { payload, intent, conversation, analysis } = input;
  const scope = {
    tenantId: payload.tenantId.toLowerCase(),
    teamId: payload.teamId.toLowerCase(),
    channelId: payload.channelId,
    rootMessageId: payload.rootMessageId,
  };
  const human = {
    scope,
    actorAadId: payload.userId.toLowerCase(),
    now: deps.now(),
    recordPolicy:
      deps.recordEnabled === false
        ? ("none" as const)
        : intent.kind === "summary"
          ? intent.suppressCanvas
            ? ("none" as const)
            : ("always" as const)
          : ("existing_only" as const),
  };
  const reference = { serviceUrl: payload.serviceUrl, conversationId: payload.conversationId };
  const outcome: TeamsTodoOutcome = {
    names: Object.fromEntries(
      [...conversation.names].map(([id, name]) => [id.toLowerCase(), name]),
    ),
    candidates: [],
    todos: await deps.store.getTodos(scope),
    changed: 0,
    rejected: [],
    record: { state: "skipped", revision: null, operationId: null },
  };
  if (intent.kind === "findings") return outcome;
  const settings = await deps.store.getSettings(scope);
  if (settings?.disabled) {
    outcome.rejected.push("disabled");
    return outcome;
  }
  if (deps.todoEnabled === false && !["summary", "canvas"].includes(intent.kind)) {
    outcome.rejected.push("disabled");
    return outcome;
  }
  const reject = (error: unknown) => {
    if (!(error instanceof TeamsWorkError)) throw error;
    outcome.rejected.push(error.code);
  };
  const explicit = "candidate" in intent;
  if (explicit) {
    try {
      verify(intent.candidate, payload, conversation);
      const result =
        intent.kind === "confirm_update"
          ? await deps.store.confirmUpdate({
              ...human,
              todoId: intent.todoId,
              expectedRevision: intent.expectedRevision,
              candidate: intent.candidate,
            })
          : await deps.store.register({
              ...human,
              reference,
              requestId: payload.taskName,
              candidate: intent.candidate,
              mode: intent.kind === "link" ? "link" : "new",
              ...(intent.kind === "link"
                ? { todoId: intent.todoId, expectedRevision: intent.expectedRevision }
                : { explicitNew: intent.kind === "register" && (intent.explicitNew ?? false) }),
            });
      outcome.changed += Number(result.changed);
    } catch (error) {
      reject(error);
    }
  } else if (intent.kind === "done") {
    try {
      const todo = outcome.todos.find((item) => item.displayNo === intent.displayNo);
      if (!todo) throw new TeamsWorkError("not_found");
      outcome.changed += Number(
        (
          await deps.store.markDone({
            ...human,
            displayNo: intent.displayNo,
            expectedRevision: todo.revision,
          })
        ).changed,
      );
    } catch (error) {
      reject(error);
    }
  } else if (intent.kind === "notifications_off" || intent.kind === "notifications_on") {
    try {
      await deps.store.setNotifications({ ...human, enabled: intent.kind === "notifications_on" });
    } catch (error) {
      reject(error);
    }
  } else {
    for (const item of analysis.state.todos) {
      const assignee =
        item.assignee === null
          ? null
          : analysis.participants
              .find((person) => person.id === item.assignee)
              ?.userId.toLowerCase();
      const candidate: TeamsTodoCandidate = {
        text: item.text,
        assigneeAadId: assignee ?? null,
        dueIso: item.dueIso,
        dueText: item.dueText,
        certainty: item.certainty,
        needsReview: item.needsReview,
        closed: item.closed,
        evidence: item.evidence.flatMap((ts) => {
          const ref = conversation.sourceRefs.get(ts);
          const link = conversation.links.get(ts);
          const stamp = /^(\d+)\.(\d{6})$/.exec(ts);
          return ref && link && stamp
            ? [
                {
                  ref,
                  link,
                  quote: item.quote,
                  sourceCreatedAt: new Date(
                    Number(stamp[1]) * 1000 + Number(stamp[2]?.slice(0, 3)),
                  ).toISOString(),
                },
              ]
            : [];
        }),
      };
      try {
        if (
          candidate.evidence.length !== item.evidence.length ||
          (item.assignee !== null && assignee === undefined)
        )
          throw new TeamsWorkError("invalid_evidence");
        verify(candidate, payload, conversation);
        outcome.candidates.push({ candidate, match: null, rejected: null });
      } catch (error) {
        if (!(error instanceof TeamsWorkError)) throw error;
        outcome.candidates.push({ candidate, match: null, rejected: error.code });
      }
    }
    const valid = outcome.candidates.filter((item) => item.rejected === null);
    const matches = matchTeamsTodos({
      scope,
      candidates: valid.map((item) => item.candidate),
      existing: outcome.todos,
    });
    for (const [index, entry] of valid.entries()) {
      const match = matches[index];
      entry.match = match ?? null;
      const c = entry.candidate;
      if (
        intent.kind !== "summary" ||
        deps.todoEnabled === false ||
        intent.suppressTodo ||
        match?.kind !== "new" ||
        c.needsReview ||
        c.certainty !== "explicit" ||
        c.closed ||
        c.assigneeAadId === null ||
        outcome.candidates.some((item) => item.rejected !== null)
      )
        continue;
      try {
        const digest = createHash("sha256").update(JSON.stringify(c)).digest("hex");
        outcome.changed += Number(
          (
            await deps.store.register({
              ...human,
              reference,
              requestId: `${payload.taskName}:${digest}`,
              candidate: c,
              mode: "new",
              automatic: true,
            })
          ).changed,
        );
      } catch (error) {
        reject(error);
      }
    }
  }
  outcome.todos = await deps.store.getTodos(scope);
  const validCandidates = outcome.candidates.filter((item) => item.rejected === null);
  const latestMatches = matchTeamsTodos({
    scope,
    candidates: validCandidates.map((item) => item.candidate),
    existing: outcome.todos,
  });
  for (const [index, entry] of validCandidates.entries())
    entry.match = latestMatches[index] ?? null;
  const model = toSummaryModel(analysis.state, analysis.participants);
  const verifiedContent =
    model.topics.some((item) => !item.needsReview) ||
    analysis.state.questions.some((item) => !item.closed && !item.needsReview) ||
    outcome.candidates.some(
      (item) =>
        item.rejected === null &&
        !item.candidate.closed &&
        !item.candidate.needsReview &&
        item.match?.status !== "done",
    );
  const shouldReserve =
    deps.recordEnabled !== false &&
    (intent.kind === "canvas" ||
      (intent.kind === "summary" && !intent.suppressCanvas && verifiedContent));
  if (shouldReserve) {
    try {
      // 根拠不一致の取得結果から外部記録を更新しない。
      if (outcome.candidates.some((item) => item.rejected !== null))
        throw new TeamsWorkError("invalid_evidence");
      await deps.store.ensureSettings({ ...human, reference });
      const previous = await deps.store.getRecord(scope);
      const record = await deps.store.reserveRecord({
        ...human,
        expectedRevision: previous?.desiredRevision ?? 0,
        snapshot: {
          scope,
          revision: (previous?.desiredRevision ?? 0) + 1,
          slots: renderTeamsSummary(model, {
            links: conversation.links,
            count: conversation.messages.length,
            firstTs: conversation.messages[0]?.ts ?? null,
            lastTs: conversation.messages.at(-1)?.ts ?? null,
            work: outcome,
          }),
          todos: outcome.todos,
          content: {
            names: outcome.names,
            sharepoint: teamsSharePointAnalysis(model, conversation.links),
            generatedAt: deps.now().toISOString(),
          },
        },
      });
      outcome.record = reserved(record);
    } catch (error) {
      reject(error);
      outcome.record.state = "rejected";
    }
  } else if (
    deps.recordEnabled !== false &&
    (intent.kind === "todo" || ((intent.kind === "done" || explicit) && outcome.changed > 0))
  ) {
    const record = await deps.store.getRecord(scope);
    if (record) outcome.record = reserved(record);
  }
  if (deps.writer && deps.todoEnabled !== false && intent.kind === "todo") {
    if (
      outcome.todos.some((todo) => todo.status === "open") ||
      outcome.candidates.some((entry) => !entry.rejected && entry.match?.kind !== "existing")
    ) {
      await deps.store.ensureSettings({ ...human, reference });
      await reserveTeamsTodoCards({ payload, outcome }, { ...deps, writer: deps.writer });
    }
  }
  return outcome;
}
function reserved(record: TeamsRecord): TeamsTodoOutcome["record"] {
  return { state: "reserved", revision: record.desiredRevision, operationId: record.operationId };
}
