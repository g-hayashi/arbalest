import { createHash, randomUUID } from "node:crypto";
import { isTrustedTeamsServiceUrl } from "../ingress.js";
import { matchTeamsTodos, TeamsWorkError, type TeamsWorkErrorCode } from "../todo-identity.js";
import type { TeamsBackend, TeamsTransaction } from "./backend.js";
import type {
  TeamsActionRef,
  TeamsEffect,
  TeamsEffectInput,
  TeamsEffectLease,
  TeamsHumanInput,
  TeamsLeaseInput,
  TeamsRecord,
  TeamsScope,
  TeamsSettingsInput,
  TeamsSlot,
  TeamsSnapshot,
  TeamsThreadSettings,
  TeamsTodo,
  TeamsTodoCandidate,
  TeamsWorkStore,
  TeamsWorkStoreOptions,
} from "./types.js";

const DAY = 86_400_000;
const RETENTION = 90 * DAY;
const MAX_SNAPSHOT = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: TeamsWorkErrorCode): never {
  throw new TeamsWorkError(code);
}
const clone = <T>(value: T): T => structuredClone(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const integer = (value: unknown, min = 1): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const time = (value: Date): number =>
  value instanceof Date && Number.isFinite(value.getTime())
    ? value.getTime()
    : fail("invalid_evidence");
const live = (value: { expireAt: Date }, now: Date) => time(value.expireAt) > time(now);
const requireLive = (value: { expireAt: Date }, now: Date) => {
  if (!live(value, now)) fail("expired");
};
const aad = (value: string): string =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : fail("unauthorized");
const normalizedText = (value: string) => value.replace(/\s+/gu, " ").trim();

export function normalizeTeamsScope(scope: TeamsScope): TeamsScope {
  matchTeamsTodos({ scope, candidates: [], existing: [] });
  return {
    tenantId: UUID.test(scope.tenantId) ? scope.tenantId.toLowerCase() : scope.tenantId,
    teamId: UUID.test(scope.teamId) ? scope.teamId.toLowerCase() : scope.teamId,
    channelId: scope.channelId,
    rootMessageId: scope.rootMessageId,
  };
}
export function teamsWorkTargetId(scope: TeamsScope): string {
  const s = normalizeTeamsScope(scope);
  return `teams_${hash([s.tenantId, s.teamId, s.channelId, s.rootMessageId])}`;
}
const sameScope = (left: TeamsScope, right: TeamsScope) => {
  if (teamsWorkTargetId(left) !== teamsWorkTargetId(right)) fail("invalid_scope");
};
/** 日次IDにrevision/hashを含めない。JST日付は送信ジョブ側で決定する。 */
export function teamsReminderOperationId(scope: TeamsScope, jstDate: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(jstDate) ||
    new Date(`${jstDate}T00:00:00Z`).toISOString().slice(0, 10) !== jstDate
  )
    fail("invalid_evidence");
  return `reminder_${teamsWorkTargetId(scope)}_${jstDate}`;
}
function validateSize(value: unknown) {
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SNAPSHOT) fail("snapshot_too_large");
  } catch (error) {
    if (error instanceof TeamsWorkError) throw error;
    fail("invalid_evidence");
  }
}
function validatedCandidate(scope: TeamsScope, value: TeamsTodoCandidate): TeamsTodoCandidate {
  matchTeamsTodos({ scope, candidates: [value], existing: [] });
  if (
    !["explicit", "implied", "uncertain"].includes(value.certainty) ||
    typeof value.needsReview !== "boolean" ||
    typeof value.closed !== "boolean"
  )
    fail("invalid_evidence");
  return {
    ...clone(value),
    assigneeAadId: value.assigneeAadId === null ? null : aad(value.assigneeAadId),
    evidence: value.evidence.map((e) => ({
      ...e,
      ref: { ...e.ref, ...normalizeTeamsScope(e.ref) },
    })),
  };
}
function validateTodo(todo: TeamsTodo, scope: TeamsScope) {
  sameScope(todo.scope, scope);
  if (
    todo.targetId !== teamsWorkTargetId(scope) ||
    !integer(todo.displayNo) ||
    !integer(todo.revision) ||
    !["open", "done"].includes(todo.status)
  )
    fail("invalid_evidence");
  matchTeamsTodos({ scope, candidates: [], existing: [todo] });
  aad(todo.createdByAadId);
  time(todo.expireAt);
  if (
    !Number.isFinite(Date.parse(todo.createdAt)) ||
    !Number.isFinite(Date.parse(todo.lastHumanUpdatedAt))
  )
    fail("invalid_evidence");
  if (todo.status === "done") {
    if (todo.doneBy === null || todo.doneAt === null || !Number.isFinite(Date.parse(todo.doneAt)))
      fail("invalid_evidence");
    aad(todo.doneBy);
  } else if (todo.doneBy !== null || todo.doneAt !== null) fail("invalid_evidence");
}
function validateSettings(value: TeamsThreadSettings, scope = value.scope) {
  sameScope(value.scope, scope);
  if (
    value.targetId !== teamsWorkTargetId(scope) ||
    !integer(value.nextDisplayNo) ||
    typeof value.disabled !== "boolean" ||
    typeof value.notificationsEnabled !== "boolean"
  )
    fail("invalid_evidence");
  aad(value.managerAadId);
  time(value.expireAt);
  if (value.serviceUrl !== null || value.conversationId !== null) validateReference(value, scope);
}
function validateReference(
  reference: { serviceUrl: string | null; conversationId: string | null },
  scope: TeamsScope,
) {
  if (
    reference.serviceUrl === null ||
    !isTrustedTeamsServiceUrl(reference.serviceUrl) ||
    (reference.conversationId !== scope.channelId &&
      reference.conversationId !== `${scope.channelId};messageid=${scope.rootMessageId}`)
  )
    fail("invalid_scope");
}
export function validateTeamsSnapshot(value: TeamsSnapshot, scope: TeamsScope, revision: number) {
  validateSize(value);
  if (
    !value ||
    !integer(revision) ||
    value.revision !== revision ||
    !Array.isArray(value.slots) ||
    !Array.isArray(value.todos)
  )
    fail("invalid_evidence");
  sameScope(value.scope, scope);
  for (const slot of value.slots) {
    if (typeof slot !== "string" || slot.trim() === "") fail("invalid_evidence");
    if (slot.length > 8000) fail("too_large");
  }
  const ids = new Set<string>();
  for (const todo of value.todos) {
    validateTodo(todo, scope);
    if (ids.has(todo.todoId)) fail("invalid_evidence");
    ids.add(todo.todoId);
  }
}
function validateSlots(slots: TeamsSlot[], scope: TeamsScope, revision: number) {
  if (!Array.isArray(slots)) fail("invalid_evidence");
  const used = new Set<number>();
  for (const slot of slots) {
    if (
      !slot ||
      !integer(slot.slot, 0) ||
      used.has(slot.slot) ||
      typeof slot.text !== "string" ||
      !integer(slot.appliedRevision, 0) ||
      slot.appliedRevision > revision ||
      typeof slot.botOwned !== "boolean"
    )
      fail("invalid_evidence");
    if (slot.text.length > 8000) fail("too_large");
    sameScope(slot.scope, scope);
    if (
      ![
        "pending",
        "creating",
        "applied",
        "failed",
        "delivery_unknown",
        "deleted",
        "retired",
      ].includes(slot.state)
    )
      fail("invalid_evidence");
    if (slot.activityId !== null && (!nonempty(slot.activityId) || !slot.botOwned))
      fail("invalid_evidence");
    if (["applied", "retired"].includes(slot.state) && !nonempty(slot.activityId))
      fail("invalid_evidence");
    used.add(slot.slot);
  }
  validateSize(slots);
}
function validateRecord(record: TeamsRecord) {
  if (record.targetId !== teamsWorkTargetId(record.scope) || !nonempty(record.operationId))
    fail("invalid_scope");
  validateTeamsSnapshot(record.snapshot, record.scope, record.desiredRevision);
  if (record.snapshotHash !== hash(record.snapshot)) fail("conflict");
  validateSlots(record.slots, record.scope, record.desiredRevision);
  time(record.expireAt);
  if (record.sharepoint) {
    const sp = record.sharepoint;
    if (
      !nonempty(sp.siteId) ||
      !nonempty(sp.listId) ||
      sp.arbalestKey !== record.targetId ||
      !integer(sp.appliedRevision, 0) ||
      sp.appliedRevision > record.desiredRevision
    )
      fail("invalid_evidence");
    for (const [field, value] of Object.entries(sp.pendingGeneratedFields ?? {})) {
      if (field === "UserNotes" || typeof value !== "string") fail("invalid_evidence");
      if (value.length > 8000) fail("too_large");
    }
  }
  validateSize(record);
}
function validateEffect(effect: TeamsEffect) {
  if (
    effect.targetId !== teamsWorkTargetId(effect.scope) ||
    !nonempty(effect.operationId) ||
    !["record", "reminder", "sharepoint", "reply"].includes(effect.kind)
  )
    fail("invalid_scope");
  validateTeamsSnapshot(effect.snapshot, effect.scope, effect.revision);
  if (
    hash(effect.snapshot) !== effect.snapshotHash ||
    !integer(effect.fencingToken, 0) ||
    !integer(effect.attempts, 0)
  )
    fail("invalid_evidence");
  if (
    !["pending", "running", "applied", "failed", "delivery_unknown", "cancelled"].includes(
      effect.state,
    )
  )
    fail("invalid_evidence");
  time(effect.expireAt);
  if (effect.leaseUntil !== null) time(effect.leaseUntil);
  if (effect.nextAttemptAt != null) time(effect.nextAttemptAt);
  validateSlots(effect.slots, effect.scope, effect.revision);
  validateSize(effect);
}
const newSlots = (snapshot: TeamsSnapshot): TeamsSlot[] =>
  snapshot.slots.map((text, slot) => ({
    slot,
    text,
    scope: clone(snapshot.scope),
    botOwned: true,
    activityId: null,
    appliedRevision: 0,
    state: "pending",
  }));
const expiry = (now: Date) => new Date(time(now) + RETENTION);
const capExpiry = (requested: Date, settings: TeamsThreadSettings, todos: TeamsTodo[] = []) =>
  new Date(
    Math.min(time(requested), time(settings.expireAt), ...todos.map((t) => time(t.expireAt))),
  );

type Request = {
  targetId: string;
  scope: TeamsScope;
  fingerprint: string;
  todoId: string;
  expireAt: Date;
};
type Anchor = {
  targetId: string;
  scope: TeamsScope;
  todoId: string;
  evidence: TeamsTodo["evidence"][number];
  textHash: string;
  expireAt: Date;
};

export function createTeamsWorkStore(
  backend: TeamsBackend,
  options: TeamsWorkStoreOptions,
): TeamsWorkStore {
  const clock = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const leaseMs = options.leaseMs ?? 60_000;
  if (!integer(leaseMs)) throw new TypeError("Invalid lease duration");
  // 過去のpayload時刻で期限を回避しない。処理開始時の時計をtransaction再試行中も固定する。
  const effectiveNow = (requested?: Date) =>
    new Date(Math.max(time(clock()), requested ? time(requested) : -Infinity));
  const run = <T>(body: (tx: TeamsTransaction) => Promise<T>) => backend.run(body);
  const settingsFor = async (
    tx: TeamsTransaction,
    scope: TeamsScope,
    now: Date,
    required = true,
  ) => {
    const value = await tx.get<TeamsThreadSettings>(
      "teams_thread_settings",
      teamsWorkTargetId(scope),
    );
    if (!value) {
      if (required) fail("not_found");
      return null;
    }
    validateSettings(value, scope);
    requireLive(value, now);
    if (value.disabled) fail("disabled");
    return value;
  };
  const todosFor = async (tx: TeamsTransaction, scope: TeamsScope, now: Date) => {
    const all = await tx.list<TeamsTodo>("teams_todos", teamsWorkTargetId(scope));
    for (const todo of all) validateTodo(todo, scope);
    return all.filter((todo) => live(todo, now)).sort((a, b) => a.displayNo - b.displayNo);
  };
  const human = (input: TeamsHumanInput) => ({
    scope: normalizeTeamsScope(input.scope),
    actor: aad(input.actorAadId),
    now: effectiveNow(input.now),
  });
  const authorized = (todo: TeamsTodo, actor: string) => {
    if (todo.createdByAadId !== actor && todo.assigneeAadId !== actor) fail("unauthorized");
  };
  const expected = (todo: TeamsTodo, revision: number | undefined) => {
    if (!integer(revision) || revision !== todo.revision) fail("stale_revision");
  };
  const findTodo = async (
    tx: TeamsTransaction,
    scope: TeamsScope,
    now: Date,
    todoId?: string,
    displayNo?: number,
  ) => {
    let todo: TeamsTodo | null;
    if (todoId) todo = await tx.get<TeamsTodo>("teams_todos", todoId);
    else {
      if (!integer(displayNo)) fail("not_found");
      todo =
        (await tx.list<TeamsTodo>("teams_todos", teamsWorkTargetId(scope))).find(
          (t) => t.displayNo === displayNo,
        ) ?? null;
    }
    if (!todo) return fail("not_found");
    validateTodo(todo, scope);
    requireLive(todo, now);
    if (displayNo !== undefined && todo.displayNo !== displayNo) fail("not_found");
    return todo;
  };
  const ensure = async (tx: TeamsTransaction, input: TeamsSettingsInput, now: Date) => {
    const scope = normalizeTeamsScope(input.scope),
      targetId = teamsWorkTargetId(scope),
      actor = aad(input.actorAadId);
    const previous = await settingsFor(tx, scope, now, false);
    const value: TeamsThreadSettings = previous ?? {
      scope,
      targetId,
      nextDisplayNo: 1,
      managerAadId: actor,
      notificationsEnabled: true,
      disabled: false,
      serviceUrl: null,
      conversationId: null,
      createdAt: now.toISOString(),
      lastHumanUpdatedAt: now.toISOString(),
      expireAt: expiry(now),
    };
    if (input.reference) {
      const { serviceUrl, conversationId } = input.reference;
      validateReference(input.reference, scope);
      value.serviceUrl = serviceUrl;
      value.conversationId = conversationId;
    }
    tx.set("teams_thread_settings", targetId, value);
    return value;
  };
  const saveAnchors = (tx: TeamsTransaction, todo: TeamsTodo) => {
    for (const evidence of todo.evidence) {
      const identity = [
        todo.targetId,
        evidence.ref.kind,
        evidence.ref.messageId,
        normalizedText(evidence.quote),
        normalizedText(todo.text),
        todo.todoId,
      ];
      const anchor: Anchor = {
        targetId: todo.targetId,
        scope: todo.scope,
        todoId: todo.todoId,
        evidence,
        textHash: hash(normalizedText(todo.text)),
        expireAt: todo.expireAt,
      };
      validateSize(anchor);
      tx.set("teams_todo_anchors", hash(identity), anchor);
    }
  };
  const makeEffect = (input: TeamsEffectInput, settings: TeamsThreadSettings): TeamsEffect => {
    validateTeamsSnapshot(input.snapshot, input.scope, input.revision);
    const value: TeamsEffect = {
      operationId: input.operationId,
      scope: clone(input.scope),
      targetId: teamsWorkTargetId(input.scope),
      kind: input.kind,
      revision: input.revision,
      snapshot: clone(input.snapshot),
      snapshotHash: hash(input.snapshot),
      slots: newSlots(input.snapshot),
      state: "pending",
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      fencingToken: 0,
      expireAt: capExpiry(input.expireAt, settings, input.snapshot.todos),
    };
    validateEffect(value);
    requireLive(value, input.now);
    return value;
  };
  const reserve = async (
    tx: TeamsTransaction,
    settings: TeamsThreadSettings,
    todos: TeamsTodo[],
    now: Date,
    supplied?: TeamsSnapshot,
  ) => {
    const scope = settings.scope,
      targetId = settings.targetId;
    const previous = await tx.get<TeamsRecord>("teams_records", targetId);
    if (previous) validateRecord(previous);
    const revision = (previous?.desiredRevision ?? 0) + 1;
    if (!integer(revision)) fail("invalid_evidence");
    const snapshot =
      supplied ??
      (options.renderSnapshot
        ? options.renderSnapshot(
            clone({ scope, revision, todos, previous: previous?.snapshot ?? null }),
          )
        : { scope, revision, todos, slots: [] });
    validateTeamsSnapshot(snapshot, scope, revision);
    // rendererは表示だけを決め、確定台帳の内容を変更できない。
    if (hash(snapshot.todos) !== hash(todos)) fail("conflict");
    const operationId = `record_${targetId}_${revision}`;
    const expireAt = capExpiry(settings.expireAt, settings, todos);
    const slots = clone(previous?.slots ?? []);
    for (const [index, text] of snapshot.slots.entries()) {
      const old = slots.find((s) => s.slot === index);
      if (old) {
        old.text = text;
        if (!["creating", "delivery_unknown", "deleted"].includes(old.state)) old.state = "pending";
      } else {
        const slot = newSlots(snapshot)[index];
        if (!slot) fail("invalid_evidence");
        slots.push(slot);
      }
    }
    const record: TeamsRecord = {
      scope,
      targetId,
      desiredRevision: revision,
      snapshot: clone(snapshot),
      snapshotHash: hash(snapshot),
      operationId,
      slots,
      sharepoint: previous?.sharepoint ?? null,
      progress: { ...previous?.progress, ledger: "applied", teams: "pending" },
      expireAt,
    };
    validateRecord(record);
    const effect = makeEffect(
      { operationId, scope, kind: "record", revision, snapshot, expireAt, now },
      settings,
    );
    effect.slots = clone(slots);
    validateEffect(effect);
    tx.set("teams_records", targetId, record);
    tx.set("teams_effects", hash(operationId), effect);
    return record;
  };
  const persistTodo = async (
    tx: TeamsTransaction,
    todo: TeamsTodo,
    settings: TeamsThreadSettings,
    now: Date,
    extend: boolean,
    recordPolicy: "always" | "existing_only" | "none" = "always",
  ) => {
    if (extend) {
      todo.lastHumanUpdatedAt = now.toISOString();
      todo.expireAt = expiry(now);
      settings.lastHumanUpdatedAt = now.toISOString();
      settings.expireAt = expiry(now);
    }
    validateTodo(todo, settings.scope);
    validateSize(todo);
    tx.set("teams_todos", todo.todoId, todo);
    saveAnchors(tx, todo);
    tx.set("teams_thread_settings", settings.targetId, settings);
    if (
      recordPolicy === "always" ||
      (recordPolicy === "existing_only" && (await tx.get("teams_records", settings.targetId)))
    )
      await reserve(tx, settings, await todosFor(tx, settings.scope, now), now);
  };
  const checkEffect = async (tx: TeamsTransaction, effect: TeamsEffect, now: Date) => {
    validateEffect(effect);
    requireLive(effect, now);
    const settings = await settingsFor(tx, effect.scope, now);
    if (!settings) return fail("not_found");
    if (effect.kind === "reminder" && !settings.notificationsEnabled) fail("disabled");
    if (effect.kind === "record" || effect.kind === "sharepoint") {
      const record = await tx.get<TeamsRecord>("teams_records", effect.targetId);
      if (!record) fail("not_found");
      validateRecord(record);
      requireLive(record, now);
      if (record.desiredRevision !== effect.revision) fail("superseded");
    }
    return settings;
  };
  const owned = async (tx: TeamsTransaction, input: TeamsLeaseInput, now: Date) => {
    const effect = await tx.get<TeamsEffect>("teams_effects", hash(input.operationId));
    if (!effect) return fail("not_found");
    sameScope(effect.scope, input.scope);
    if (
      effect.leaseOwner !== input.owner ||
      effect.fencingToken !== input.fencingToken ||
      !effect.leaseUntil ||
      time(effect.leaseUntil) <= time(now) ||
      effect.state !== "running"
    )
      fail("lease_lost");
    await checkEffect(tx, effect, now);
    return effect as TeamsEffectLease;
  };

  return {
    async getTodos(scope) {
      const now = effectiveNow();
      return run((tx) => todosFor(tx, normalizeTeamsScope(scope), now));
    },
    async getSettings(scope) {
      const now = effectiveNow();
      return run(async (tx) => {
        const value = await tx.get<TeamsThreadSettings>(
          "teams_thread_settings",
          teamsWorkTargetId(scope),
        );
        if (!value) return null;
        validateSettings(value, scope);
        return live(value, now) ? value : null;
      });
    },
    async listSettings() {
      const now = effectiveNow();
      return run(async (tx) => {
        const values = await tx.list<TeamsThreadSettings>("teams_thread_settings");
        for (const value of values) validateSettings(value);
        return values.filter((v) => live(v, now));
      });
    },
    async ensureSettings(input) {
      const { now } = human(input);
      return run((tx) => ensure(tx, input, now));
    },
    async disableThread(input) {
      const now = effectiveNow(input.now);
      return run(async (tx) => {
        const value = await tx.get<TeamsThreadSettings>(
          "teams_thread_settings",
          teamsWorkTargetId(input.scope),
        );
        if (!value) return;
        validateSettings(value, input.scope);
        requireLive(value, now);
        value.disabled = true;
        value.notificationsEnabled = false;
        tx.set("teams_thread_settings", value.targetId, value);
      });
    },
    async stopNotifications(input) {
      const now = effectiveNow(input.now);
      return run(async (tx) => {
        const value = await settingsFor(tx, input.scope, now);
        if (!value) return;
        value.notificationsEnabled = false;
        tx.set("teams_thread_settings", value.targetId, value);
      });
    },
    async register(input) {
      const { scope, actor, now } = human(input);
      const candidate = validatedCandidate(scope, input.candidate);
      if (!nonempty(input.requestId) || !["new", "link"].includes(input.mode))
        fail("invalid_evidence");
      if (
        input.automatic &&
        (input.mode !== "new" ||
          input.explicitNew ||
          candidate.closed ||
          candidate.needsReview ||
          candidate.certainty !== "explicit" ||
          candidate.assigneeAadId === null)
      )
        fail("invalid_evidence");
      const targetId = teamsWorkTargetId(scope),
        requestKey = hash([targetId, input.requestId]);
      const fingerprint = hash([
        candidate,
        input.mode,
        input.todoId ?? null,
        actor,
        input.explicitNew ?? false,
      ]);
      return run(async (tx) => {
        const settings = await ensure(tx, { ...input, scope }, now);
        const request = await tx.get<Request>("teams_requests", requestKey);
        if (request) {
          sameScope(request.scope, scope);
          requireLive(request, now);
          if (request.fingerprint !== fingerprint) fail("conflict");
          const todo = await findTodo(tx, scope, now, request.todoId);
          if (input.mode === "link") authorized(todo, actor);
          return { todo, changed: false };
        }
        const todos = await todosFor(tx, scope, now);
        const match = matchTeamsTodos({ scope, candidates: [candidate], existing: todos })[0];
        if (!match) fail("invalid_evidence");
        let todo: TeamsTodo,
          changed = false;
        if (input.mode === "link") {
          todo = await findTodo(tx, scope, now, input.todoId);
          authorized(todo, actor);
          expected(todo, input.expectedRevision);
          const evidence = new Map(
            todo.evidence.map((e) => [hash([e.ref, normalizedText(e.quote)]), e]),
          );
          for (const item of candidate.evidence)
            evidence.set(hash([item.ref, normalizedText(item.quote)]), item);
          if (evidence.size !== todo.evidence.length) {
            todo.evidence = [...evidence.values()];
            todo.revision++;
            changed = true;
            await persistTodo(tx, todo, settings, now, true, input.recordPolicy);
          }
        } else if (match.kind === "existing") {
          todo = await findTodo(tx, scope, now, match.todoIds[0]);
        } else {
          if (match.kind !== "new" && !input.explicitNew) fail("ambiguous");
          if (
            input.automatic &&
            candidate.evidence.some((e) => Date.parse(e.sourceCreatedAt) + RETENTION <= time(now))
          )
            fail("expired");
          const todoId = newId();
          if (!nonempty(todoId) || todoId.includes("/") || (await tx.get("teams_todos", todoId)))
            fail("conflict");
          if (!integer(settings.nextDisplayNo + 1)) fail("invalid_evidence");
          todo = {
            todoId,
            targetId,
            scope,
            text: candidate.text,
            evidence: candidate.evidence,
            assigneeAadId: candidate.assigneeAadId,
            dueIso: candidate.dueIso,
            dueText: candidate.dueText,
            displayNo: settings.nextDisplayNo++,
            createdByAadId: actor,
            status: "open",
            revision: 1,
            createdAt: now.toISOString(),
            lastHumanUpdatedAt: now.toISOString(),
            expireAt: expiry(now),
            doneBy: null,
            doneAt: null,
          };
          changed = true;
          await persistTodo(tx, todo, settings, now, !input.automatic, input.recordPolicy);
        }
        tx.set<Request>("teams_requests", requestKey, {
          scope,
          targetId,
          fingerprint,
          todoId: todo.todoId,
          expireAt: todo.expireAt,
        });
        return { todo, changed };
      });
    },
    async confirmUpdate(input) {
      const { scope, actor, now } = human(input),
        candidate = validatedCandidate(scope, input.candidate);
      return run(async (tx) => {
        const todo = await findTodo(tx, scope, now, input.todoId, input.displayNo);
        authorized(todo, actor);
        expected(todo, input.expectedRevision);
        const settings = await settingsFor(tx, scope, now);
        if (!settings) return fail("not_found");
        const match = matchTeamsTodos({ scope, candidates: [candidate], existing: [todo] })[0];
        if (!match) fail("invalid_evidence");
        if (match.kind === "existing") return { todo, changed: false };
        if (match.kind !== "update_proposal") fail("ambiguous");
        todo.assigneeAadId = candidate.assigneeAadId;
        todo.dueIso = candidate.dueIso;
        todo.dueText = candidate.dueText;
        todo.revision++;
        await persistTodo(tx, todo, settings, now, true, input.recordPolicy);
        return { todo, changed: true };
      });
    },
    async markDone(input) {
      const { scope, actor, now } = human(input);
      return run(async (tx) => {
        const todo = await findTodo(tx, scope, now, input.todoId, input.displayNo);
        authorized(todo, actor);
        const settings = await settingsFor(tx, scope, now);
        if (!settings) return fail("not_found");
        if (todo.status === "done") return { todo, changed: false };
        expected(todo, input.expectedRevision);
        todo.status = "done";
        todo.doneBy = actor;
        todo.doneAt = now.toISOString();
        todo.revision++;
        await persistTodo(tx, todo, settings, now, true, input.recordPolicy);
        return { todo, changed: true };
      });
    },
    async setNotifications(input) {
      const { scope, actor, now } = human(input);
      return run(async (tx) => {
        const value = await settingsFor(tx, scope, now);
        if (!value) return fail("not_found");
        if (value.managerAadId !== actor) fail("unauthorized");
        if (typeof input.enabled !== "boolean") fail("invalid_evidence");
        if (value.notificationsEnabled !== input.enabled) {
          value.notificationsEnabled = input.enabled;
          value.lastHumanUpdatedAt = now.toISOString();
          value.expireAt = expiry(now);
          tx.set("teams_thread_settings", value.targetId, value);
        }
        return value;
      });
    },
    async putActionRef(input) {
      const { scope, actor, now } = human(input);
      if (
        !/^[a-f0-9]{64}$/.test(input.tokenHash) ||
        !nonempty(input.sourceActivityId) ||
        ![
          "register",
          "link",
          "confirm_update",
          "done",
          "notifications_off",
          "notifications_on",
        ].includes(input.action)
      )
        fail("invalid_evidence");
      const candidate = input.candidate ? validatedCandidate(scope, input.candidate) : null;
      if (["register", "link", "confirm_update"].includes(input.action) && !candidate)
        fail("invalid_evidence");
      return run(async (tx) => {
        const settings = await settingsFor(tx, scope, now);
        if (!settings) return fail("not_found");
        const todo = input.todoId ? await findTodo(tx, scope, now, input.todoId) : null;
        if (["done", "confirm_update", "link"].includes(input.action)) {
          if (!todo) return fail("not_found");
          authorized(todo, actor);
          expected(todo, input.expectedRevision);
        }
        if (input.action.startsWith("notifications_") && settings.managerAadId !== actor)
          fail("unauthorized");
        const expireAt = capExpiry(
          new Date(Math.min(time(input.expireAt), time(now) + 7 * DAY)),
          settings,
          todo ? [todo] : [],
        );
        const value: TeamsActionRef = {
          tokenHash: input.tokenHash,
          scope,
          targetId: settings.targetId,
          sourceActivityId: input.sourceActivityId,
          action: input.action,
          todoId: todo?.todoId ?? null,
          candidate,
          expectedRevision: input.expectedRevision ?? null,
          issuedByAadId: actor,
          allowedActorAadIds: (input.allowedActorAadIds ?? []).map(aad),
          explicitNew: input.explicitNew ?? false,
          createdAt: now.toISOString(),
          expireAt,
        };
        requireLive(value, now);
        validateSize(value);
        const previous = await tx.get<TeamsActionRef>("teams_action_refs", input.tokenHash);
        if (previous) {
          if (hash(previous) !== hash(value)) fail("conflict");
          return;
        }
        tx.set("teams_action_refs", input.tokenHash, value);
      });
    },
    async getActionRef(tokenHash) {
      const now = effectiveNow();
      return run(async (tx) => {
        if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
        const value = await tx.get<TeamsActionRef>("teams_action_refs", tokenHash);
        if (!value || !live(value, now)) return null;
        validateSize(value);
        if (value.targetId !== teamsWorkTargetId(value.scope) || value.tokenHash !== tokenHash)
          fail("invalid_scope");
        if (value.candidate) validatedCandidate(value.scope, value.candidate);
        const settings = await tx.get<TeamsThreadSettings>("teams_thread_settings", value.targetId);
        if (!settings || !live(settings, now) || settings.disabled) return null;
        if (value.todoId) {
          const todo = await tx.get<TeamsTodo>("teams_todos", value.todoId);
          if (!todo || !live(todo, now)) return null;
          validateTodo(todo, value.scope);
        }
        return value;
      });
    },
    async reserveEffect(input) {
      const scope = normalizeTeamsScope(input.scope),
        now = effectiveNow(input.now);
      return run(async (tx) => {
        const settings = await settingsFor(tx, scope, now);
        if (!settings) return fail("not_found");
        const previous = await tx.get<TeamsEffect>("teams_effects", hash(input.operationId));
        if (previous) {
          validateEffect(previous);
          sameScope(previous.scope, scope);
          requireLive(previous, now);
          if (previous.kind !== input.kind) fail("conflict");
          return { effect: previous, created: false };
        }
        const effect = makeEffect({ ...input, scope, now }, settings);
        await checkEffect(tx, effect, now);
        tx.set("teams_effects", hash(input.operationId), effect);
        return { effect, created: true };
      });
    },
    async getEffect(operationId) {
      const now = effectiveNow();
      return run(async (tx) => {
        const value = await tx.get<TeamsEffect>("teams_effects", hash(operationId));
        if (!value) return null;
        validateEffect(value);
        return live(value, now) ? value : null;
      });
    },
    async claimEffect(operationId, owner, requested, claimOptions) {
      const now = effectiveNow(requested);
      if (!nonempty(owner)) fail("invalid_evidence");
      return run(async (tx) => {
        const effect = await tx.get<TeamsEffect>("teams_effects", hash(operationId));
        if (!effect) return null;
        validateEffect(effect);
        if (
          !live(effect, now) ||
          ["cancelled", "delivery_unknown"].includes(effect.state) ||
          (effect.state === "applied" && !(claimOptions?.reapply && effect.kind === "record"))
        )
          return null;
        try {
          await checkEffect(tx, effect, now);
        } catch (error) {
          if (
            error instanceof TeamsWorkError &&
            ["disabled", "expired", "superseded"].includes(error.code)
          )
            return null;
          throw error;
        }
        if (effect.leaseUntil && time(effect.leaseUntil) > time(now)) return null;
        if (effect.nextAttemptAt && time(effect.nextAttemptAt) > time(now)) return null;
        if (effect.slots.some((s) => s.state === "creating" || s.state === "delivery_unknown")) {
          effect.state = "delivery_unknown";
          effect.slots = effect.slots.map((s) =>
            s.state === "creating" ? { ...s, state: "delivery_unknown" } : s,
          );
          if (effect.kind === "record") {
            const record = await tx.get<TeamsRecord>("teams_records", effect.targetId);
            if (record && record.desiredRevision === effect.revision) {
              record.slots = clone(effect.slots);
              record.progress.teams = "delivery_unknown";
              validateRecord(record);
              tx.set("teams_records", record.targetId, record);
            }
          }
          tx.set("teams_effects", hash(operationId), effect);
          return null;
        }
        effect.state = "running";
        effect.leaseOwner = owner;
        effect.leaseUntil = new Date(Math.min(time(now) + leaseMs, time(effect.expireAt)));
        effect.fencingToken++;
        effect.attempts++;
        validateEffect(effect);
        tx.set("teams_effects", hash(operationId), effect);
        return effect as TeamsEffectLease;
      });
    },
    async extendEffectLease(input) {
      const now = effectiveNow(input.now);
      return run(async (tx) => {
        const effect = await owned(tx, input, now);
        effect.leaseUntil = new Date(Math.min(time(now) + leaseMs, time(effect.expireAt)));
        tx.set("teams_effects", hash(input.operationId), effect);
        return effect;
      });
    },
    async saveEffect(input) {
      const now = effectiveNow(input.now);
      return run(async (tx) => {
        const effect: TeamsEffect = await owned(tx, input, now);
        if (input.slots) effect.slots = clone(input.slots);
        if (input.state) effect.state = input.state;
        if (input.nextAttemptAt !== undefined) effect.nextAttemptAt = input.nextAttemptAt;
        if (effect.state !== "running") {
          effect.leaseOwner = null;
          effect.leaseUntil = null;
        }
        validateEffect(effect);
        tx.set("teams_effects", hash(input.operationId), effect);
      });
    },
    async getRecord(scope) {
      const now = effectiveNow();
      return run(async (tx) => {
        const value = await tx.get<TeamsRecord>("teams_records", teamsWorkTargetId(scope));
        if (!value) return null;
        sameScope(value.scope, scope);
        validateRecord(value);
        return live(value, now) ? value : null;
      });
    },
    async listRecords() {
      const now = effectiveNow();
      return run(async (tx) => {
        const values = await tx.list<TeamsRecord>("teams_records");
        for (const value of values) validateRecord(value);
        return values.filter((v) => live(v, now));
      });
    },
    async reserveRecord(input) {
      const { scope, now } = human(input);
      return run(async (tx) => {
        const settings = await settingsFor(tx, scope, now);
        if (!settings) return fail("not_found");
        const previous = await tx.get<TeamsRecord>("teams_records", settings.targetId);
        if ((previous?.desiredRevision ?? 0) !== input.expectedRevision) fail("stale_revision");
        return reserve(tx, settings, await todosFor(tx, scope, now), now, input.snapshot);
      });
    },
    async recoverRecord(input) {
      const { scope, actor, now } = human(input);
      return run(async (tx) => {
        const settings = await settingsFor(tx, scope, now);
        if (!settings || settings.managerAadId !== actor) fail("unauthorized");
        const record = await tx.get<TeamsRecord>("teams_records", settings.targetId);
        if (!record) return fail("not_found");
        validateRecord(record);
        requireLive(record, now);
        if (record.desiredRevision !== input.expectedRevision) fail("stale_revision");
        const effect = await tx.get<TeamsEffect>("teams_effects", hash(record.operationId));
        if (!effect) return fail("not_found");
        validateEffect(effect);
        if (effect.leaseUntil && time(effect.leaseUntil) > time(now)) fail("lease_lost");
        const slot = record.slots.find((s) => s.slot === input.slot);
        if (!slot) return fail("not_found");
        if (input.activityId !== null && !nonempty(input.activityId)) fail("invalid_evidence");
        if (
          input.activityId !== null &&
          record.slots.some((s) => s.slot !== input.slot && s.activityId === input.activityId)
        )
          fail("conflict");
        slot.activityId = input.activityId;
        slot.botOwned = true;
        slot.state = "pending";
        slot.appliedRevision = 0;
        record.progress.teams = "pending";
        effect.slots = clone(record.slots);
        effect.state = effect.slots.some((s) => ["creating", "delivery_unknown"].includes(s.state))
          ? "delivery_unknown"
          : "pending";
        effect.leaseOwner = null;
        effect.leaseUntil = null;
        effect.fencingToken++;
        validateRecord(record);
        validateEffect(effect);
        tx.set("teams_records", settings.targetId, record);
        tx.set("teams_effects", hash(record.operationId), effect);
      });
    },
    async saveRecord(input) {
      const now = effectiveNow(input.now);
      return run(async (tx) => {
        const effect = await owned(tx, input, now);
        const record = await tx.get<TeamsRecord>("teams_records", effect.targetId);
        if (!record) return fail("not_found");
        validateRecord(record);
        requireLive(record, now);
        if (input.revision !== record.desiredRevision || effect.revision !== input.revision)
          fail("superseded");
        validateTeamsSnapshot(input.snapshot, input.scope, input.revision);
        if (hash(input.snapshot) !== record.snapshotHash) fail("conflict");
        if (input.slots) {
          record.slots = clone(input.slots);
          if (effect.kind !== "record") fail("invalid_evidence");
          effect.slots = clone(input.slots);
          validateEffect(effect);
          tx.set("teams_effects", hash(effect.operationId), effect);
        }
        if (input.sharepoint !== undefined) record.sharepoint = clone(input.sharepoint);
        if (input.progress) record.progress = { ...record.progress, ...input.progress };
        validateRecord(record);
        tx.set("teams_records", record.targetId, record);
      });
    },
  };
}
