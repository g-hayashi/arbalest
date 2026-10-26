/** 固定snapshotの管理投稿。作成結果不明は人による復旧まで再投稿しない。 */
import { randomUUID } from "node:crypto";
import { issueTeamsAction } from "./actions.js";
import { TeamsApiError } from "./graph.js";
import { isTrustedTeamsServiceUrl } from "./ingress.js";
import { escapeTeamsText, splitTeamsLines } from "./render.js";
import { teamsWorkTargetId, validateTeamsSnapshot } from "./store/common.js";
import {
  type JsonValue,
  type TeamsActionRefInput,
  type TeamsConversationReference,
  type TeamsScope,
  type TeamsSnapshot,
  type TeamsTodo,
  TeamsWorkError,
  type TeamsWorkStore,
} from "./store/types.js";
import type { TeamsTodoOutcome } from "./todos.js";

export type TeamsRecordMessage = { text: string; card?: JsonValue };
export interface TeamsRecordWriter {
  create(
    scope: TeamsScope,
    reference: TeamsConversationReference,
    message: TeamsRecordMessage,
  ): Promise<{ activityId: string }>;
  update(
    scope: TeamsScope,
    reference: TeamsConversationReference,
    activityId: string,
    message: TeamsRecordMessage,
  ): Promise<void>;
}
export type TeamsRecordDeps = {
  store: TeamsWorkStore;
  writer: TeamsRecordWriter;
  now: () => Date;
  owner?: string;
};
export type TeamsRecordOutcome = {
  state: "applied" | "pending" | "delivery_unknown" | "deleted";
  revision: number;
};
function fail(code: ConstructorParameters<typeof TeamsWorkError>[0]): never {
  throw new TeamsWorkError(code);
}
const sameScope = (a: TeamsScope, b: TeamsScope) => teamsWorkTargetId(a) === teamsWorkTargetId(b);

export function validateTeamsRecordMessage(message: TeamsRecordMessage): void {
  if (typeof message.text !== "string" || !message.text.trim()) fail("invalid_evidence");
  if (message.text.length > 8000) fail("too_large");
  // Teamsのメッセージ上限28KiBに余裕を残す。カードも省略せず停止する。
  if (Buffer.byteLength(JSON.stringify(message), "utf8") > 24 * 1024) fail("too_large");
}
async function referenceFor(
  scope: TeamsScope,
  store: TeamsWorkStore,
): Promise<TeamsConversationReference> {
  const settings = await store.getSettings(scope);
  if (!settings) return fail("not_found");
  if (settings.disabled) fail("disabled");
  if (
    !settings.serviceUrl ||
    !isTrustedTeamsServiceUrl(settings.serviceUrl) ||
    (settings.conversationId !== scope.channelId &&
      settings.conversationId !== `${scope.channelId};messageid=${scope.rootMessageId}`)
  )
    fail("invalid_scope");
  if (!settings.conversationId) fail("invalid_scope");
  return { serviceUrl: settings.serviceUrl, conversationId: settings.conversationId };
}

export async function syncTeamsRecord(
  input: { scope: TeamsScope; revision: number; explicitRefresh?: boolean; repair?: boolean },
  deps: TeamsRecordDeps,
): Promise<TeamsRecordOutcome> {
  const record = await deps.store.getRecord(input.scope);
  if (!record) return fail("not_found");
  if (!sameScope(record.scope, input.scope)) fail("invalid_scope");
  if (record.desiredRevision !== input.revision) fail("superseded");
  validateTeamsSnapshot(record.snapshot, input.scope, input.revision);
  const reference = await referenceFor(input.scope, deps.store);
  const lease = await deps.store.claimEffect(
    record.operationId,
    deps.owner ?? randomUUID(),
    deps.now(),
    { reapply: input.repair },
  );
  if (!lease) {
    const latest = await deps.store.getRecord(input.scope);
    return {
      state: latest?.slots.some((s) => ["creating", "delivery_unknown"].includes(s.state))
        ? "delivery_unknown"
        : latest?.progress.teams === "applied"
          ? "applied"
          : "pending",
      revision: input.revision,
    };
  }
  const owned = () => ({
    scope: input.scope,
    operationId: record.operationId,
    owner: lease.leaseOwner,
    fencingToken: lease.fencingToken,
    now: deps.now(),
  });
  const save = (state: "pending" | "applied" | "failed" | "delivery_unknown") =>
    deps.store.saveRecord({
      ...owned(),
      revision: input.revision,
      snapshot: record.snapshot,
      slots: record.slots,
      progress: { teams: state },
    });
  let deleted = false;
  for (const slot of record.slots) {
    if (!sameScope(slot.scope, input.scope) || !slot.botOwned) fail("invalid_scope");
    const retired = slot.slot >= record.snapshot.slots.length;
    const text = retired ? "この内容は統合済み" : record.snapshot.slots[slot.slot];
    if (text === undefined) fail("invalid_evidence");
    validateTeamsRecordMessage({ text });
    if (["creating", "delivery_unknown"].includes(slot.state)) return fail("delivery_unknown");
    if (
      !depsIsReapply(input) &&
      slot.appliedRevision === input.revision &&
      ["applied", "retired"].includes(slot.state)
    )
      continue;
    if (slot.state === "deleted" && !input.explicitRefresh) {
      deleted = true;
      continue;
    }
    if (retired && !slot.activityId) {
      slot.state = "pending";
      continue;
    }
    await deps.store.extendEffectLease(owned());
    if (slot.activityId && slot.state !== "deleted") {
      try {
        await deps.writer.update(input.scope, reference, slot.activityId, { text });
      } catch (error) {
        slot.state = error instanceof TeamsApiError && error.status === 404 ? "deleted" : "failed";
        await save("failed");
        if (slot.state === "deleted") {
          deleted = true;
          continue;
        }
        await deps.store.saveEffect({ ...owned(), state: "failed" });
        throw error;
      }
    } else {
      slot.state = "creating";
      slot.activityId = null;
      await save("pending");
      await deps.store.extendEffectLease(owned());
      try {
        const created = await deps.writer.create(input.scope, reference, { text });
        if (!created.activityId?.trim()) fail("delivery_unknown");
        slot.activityId = created.activityId;
        slot.state = retired ? "retired" : "applied";
        slot.appliedRevision = input.revision;
        slot.text = text;
        await save("pending");
      } catch {
        slot.state = "delivery_unknown";
        // 保存障害やリース喪失でも先行保存済みcreatingが自動再作成を止める。
        try {
          await save("delivery_unknown");
          await deps.store.saveEffect({ ...owned(), state: "delivery_unknown" });
        } catch {
          /* 先行creatingを保持 */
        }
        return fail("delivery_unknown");
      }
    }
    slot.state = retired ? "retired" : "applied";
    slot.appliedRevision = input.revision;
    slot.text = text;
    await save("pending");
  }
  await save(deleted ? "failed" : "applied");
  await deps.store.saveEffect({ ...owned(), state: deleted ? "failed" : "applied" });
  return { state: deleted ? "deleted" : "applied", revision: input.revision };
}
const depsIsReapply = (input: { repair?: boolean }) => input.repair === true;

/** 再関連付けはGraph等の外部照会を注入。入力の自己申告を所有証明に使わない。 */
export async function recoverTeamsRecord(
  input: {
    scope: TeamsScope;
    revision: number;
    actorAadId: string;
    slot: number;
    mode: "relink" | "recreate";
    activityId?: string;
    acknowledgeDuplicate?: boolean;
  },
  deps: TeamsRecordDeps & {
    verifyActivity?: (
      scope: TeamsScope,
      activityId: string,
    ) => Promise<{ scope: TeamsScope; botOwned: boolean }>;
  },
): Promise<void> {
  const settings = await deps.store.getSettings(input.scope);
  if (!settings || settings.managerAadId !== input.actorAadId.toLowerCase()) fail("unauthorized");
  let activityId: string | null = null;
  if (input.mode === "relink") {
    if (!input.activityId?.trim() || !deps.verifyActivity) fail("invalid_evidence");
    const verified = await deps.verifyActivity(input.scope, input.activityId);
    if (!sameScope(verified.scope, input.scope)) fail("invalid_scope");
    if (!verified.botOwned) fail("unauthorized");
    activityId = input.activityId;
  } else if (input.acknowledgeDuplicate !== true) fail("delivery_unknown");
  await deps.store.recoverRecord({
    scope: input.scope,
    actorAadId: input.actorAadId,
    now: deps.now(),
    expectedRevision: input.revision,
    slot: input.slot,
    activityId,
  });
}

/** 台帳変更では過去の検証済み分析表示を維持し、台帳部分だけを現在値に置き換える。 */
export function renderTeamsRecordSnapshot(input: {
  scope: TeamsScope;
  revision: number;
  todos: TeamsTodo[];
  previous: TeamsSnapshot | null;
}): TeamsSnapshot {
  const saved = input.previous?.slots.join("\n") ?? "";
  const analysis = saved.split("## 登録済みToDo")[0]?.trim() ?? "";
  const lines = analysis ? analysis.split("\n") : [];
  const content = input.previous?.content;
  const savedNames =
    content && typeof content === "object" && !Array.isArray(content) ? content.names : null;
  const names =
    savedNames && typeof savedNames === "object" && !Array.isArray(savedNames) ? savedNames : {};
  lines.push("## 登録済みToDo");
  for (const todo of input.todos) {
    const name =
      todo.assigneeAadId === null
        ? "未定（登録者が管理）"
        : typeof names[todo.assigneeAadId] === "string"
          ? (names[todo.assigneeAadId] as string)
          : "担当者（表示名未取得）";
    lines.push(
      `- T${todo.displayNo} ${escapeTeamsText(todo.text)} / ${todo.status === "done" ? "完了済み" : "未完了"} / 担当: ${escapeTeamsText(name)} / 期限: ${escapeTeamsText(todo.dueIso ?? todo.dueText ?? "未定")} / 完了: done T${todo.displayNo}`,
    );
    for (const evidence of todo.evidence) {
      const url = new URL(evidence.link);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "teams.microsoft.com" ||
        url.username ||
        url.password ||
        url.port ||
        url.href.length > 2048
      )
        fail("invalid_evidence");
      lines.push(
        `  [根拠](${url.href.replaceAll("(", "%28").replaceAll(")", "%29")}) / ${escapeTeamsText(evidence.quote)}`,
      );
    }
  }
  if (!input.todos.length) lines.push("登録済みToDoはありません。");
  const result = {
    ...input.previous,
    scope: input.scope,
    revision: input.revision,
    todos: input.todos,
    slots: splitTeamsLines(lines),
  };
  validateTeamsSnapshot(result, input.scope, input.revision);
  return result;
}

/** IDを永続化した通常返信へカードだけを付加する。raw tokenはこの呼出しの外へ保存しない。 */
export async function publishTeamsTodoCards(
  input: {
    scope: TeamsScope;
    actorAadId: string;
    activityId: string;
    text: string;
    outcome: TeamsTodoOutcome;
  },
  deps: TeamsRecordDeps,
): Promise<void> {
  if (!input.activityId.trim() || input.activityId === "sent") fail("invalid_evidence");
  const reference = await referenceFor(input.scope, deps.store);
  const actions: JsonValue[] = [];
  const refs: Omit<TeamsActionRefInput, "tokenHash">[] = [];
  const add = async (title: string, action: Omit<TeamsActionRefInput, "tokenHash">) => {
    refs.push(action);
    actions.push({ type: "Action.Execute", title, data: { token: "a".repeat(43) } });
  };
  const settings = await deps.store.getSettings(input.scope);
  if (settings && settings.managerAadId === input.actorAadId) {
    await add(settings.notificationsEnabled ? "通知停止" : "通知再開", {
      scope: input.scope,
      actorAadId: input.actorAadId,
      now: deps.now(),
      sourceActivityId: input.activityId,
      action: settings.notificationsEnabled ? "notifications_off" : "notifications_on",
      expireAt: new Date(deps.now().getTime() + 7 * 86_400_000),
    });
  }
  for (const todo of input.outcome.todos) {
    if (todo.status !== "open") continue;
    await add(`完了: T${todo.displayNo}`, {
      scope: input.scope,
      actorAadId: input.actorAadId,
      now: deps.now(),
      sourceActivityId: input.activityId,
      action: "done",
      todoId: todo.todoId,
      expectedRevision: todo.revision,
      expireAt: new Date(deps.now().getTime() + 7 * 86_400_000),
    });
  }
  for (const entry of input.outcome.candidates) {
    if (entry.rejected || entry.match?.kind === "existing" || !entry.match) continue;
    const base = {
      scope: input.scope,
      actorAadId: input.actorAadId,
      now: deps.now(),
      sourceActivityId: input.activityId,
      candidate: entry.candidate,
      expireAt: new Date(deps.now().getTime() + 7 * 86_400_000),
    };
    if (entry.match.kind === "new" || entry.match.kind === "ambiguous")
      await add(`登録: ${entry.candidate.text}`, {
        ...base,
        action: "register",
        explicitNew: entry.match.kind === "ambiguous",
      });
    if (entry.match.kind === "ambiguous" || entry.match.kind === "update_proposal") {
      for (const id of entry.match.todoIds) {
        const todo = input.outcome.todos.find((t) => t.todoId === id);
        if (!todo) continue;
        await add(
          `${entry.match.kind === "ambiguous" ? "関連付け" : "更新確認"}: T${todo.displayNo}`,
          {
            ...base,
            action: entry.match.kind === "ambiguous" ? "link" : "confirm_update",
            todoId: id,
            expectedRevision: todo.revision,
          },
        );
      }
    }
  }
  if (!actions.length) return;
  const message = {
    text: input.text,
    card: {
      type: "AdaptiveCard",
      version: "1.5",
      body: [
        { type: "TextBlock", text: "候補の操作", wrap: true },
        ...Array.from({ length: Math.ceil(actions.length / 3) }, (_, index) => ({
          type: "ActionSet",
          actions: actions.slice(index * 3, index * 3 + 3),
        })),
      ],
    },
  };
  validateTeamsRecordMessage(message);
  for (const [index, ref] of refs.entries()) {
    const { token } = await issueTeamsAction(ref, deps);
    const action = actions[index] as { type: string; title: string; data: { token: string } };
    action.data.token = token;
  }
  await deps.writer.update(input.scope, reference, input.activityId, message);
}

type CardsPayload = TeamsScope & { taskName: string; userId: string };
export async function reserveTeamsTodoCards(
  input: { payload: CardsPayload; outcome: TeamsTodoOutcome },
  deps: TeamsRecordDeps,
): Promise<void> {
  if (
    !input.outcome.todos.some((todo) => todo.status === "open") &&
    !input.outcome.candidates.some(
      (entry) => !entry.rejected && entry.match && entry.match.kind !== "existing",
    )
  )
    return;
  const scope = {
    tenantId: input.payload.tenantId,
    teamId: input.payload.teamId,
    channelId: input.payload.channelId,
    rootMessageId: input.payload.rootMessageId,
  };
  const settings = await deps.store.getSettings(scope);
  if (!settings) fail("not_found");
  // 候補は保存するが、カードにしか存在しないraw tokenはここでは発行しない。
  await deps.store.reserveEffect({
    operationId: `cards_${input.payload.taskName}`,
    scope,
    kind: "reply",
    revision: 1,
    snapshot: {
      scope,
      revision: 1,
      slots: [],
      todos: [],
      content: JSON.parse(JSON.stringify(input.outcome)) as JsonValue,
    },
    expireAt: settings.expireAt,
    now: deps.now(),
  });
}
export async function flushTeamsTodoCards(
  input: { payload: CardsPayload; activityId: string; text: string },
  deps: TeamsRecordDeps,
): Promise<void> {
  const operationId = `cards_${input.payload.taskName}`;
  const effect = await deps.store.getEffect(operationId);
  if (!effect) return;
  if (!sameScope(effect.scope, input.payload) || effect.kind !== "reply") fail("invalid_scope");
  const lease = await deps.store.claimEffect(operationId, deps.owner ?? randomUUID(), deps.now());
  if (!lease) return;
  const owned = {
    scope: effect.scope,
    operationId,
    owner: lease.leaseOwner,
    fencingToken: lease.fencingToken,
    now: deps.now(),
  };
  try {
    await deps.store.extendEffectLease(owned);
    await publishTeamsTodoCards(
      {
        scope: effect.scope,
        actorAadId: input.payload.userId,
        activityId: input.activityId,
        text: input.text,
        outcome: effect.snapshot.content as unknown as TeamsTodoOutcome,
      },
      deps,
    );
    await deps.store.saveEffect({ ...owned, now: deps.now(), state: "applied" });
  } catch (error) {
    await deps.store.saveEffect({ ...owned, now: deps.now(), state: "failed" });
    throw error;
  }
}
