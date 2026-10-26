import type { MessageRef } from "./types.js";

export type TeamsScope = Pick<MessageRef, "tenantId" | "teamId" | "channelId" | "rootMessageId">;

export type TeamsEvidence = {
  ref: MessageRef;
  quote: string;
  link: string;
  sourceCreatedAt: string;
};

export type TeamsTodoCandidate = {
  text: string;
  evidence: TeamsEvidence[];
  assigneeAadId: string | null;
  dueIso: string | null;
  dueText: string | null;
  certainty: "explicit" | "implied" | "uncertain";
  needsReview: boolean;
  closed: boolean;
};

/** 保存形式に依存せず、同一性の照合で必要な既存項目だけを受け取る。 */
export type TeamsTodoIdentity = Pick<
  TeamsTodoCandidate,
  "text" | "evidence" | "assigneeAadId" | "dueIso" | "dueText"
> & {
  todoId: string;
  scope: TeamsScope;
  status: "open" | "done";
};

type Change = { from: string | null; to: string | null };
export type TeamsTodoChanges = Partial<Record<"assigneeAadId" | "dueIso" | "dueText", Change>>;

export type TeamsTodoMatch = {
  candidateIndex: number;
  kind: "existing" | "update_proposal" | "ambiguous" | "new";
  todoIds: string[];
  status: "open" | "done" | null;
  changes: TeamsTodoChanges;
};

export type TeamsWorkErrorCode =
  | "invalid_scope"
  | "invalid_evidence"
  | "unauthorized"
  | "not_found"
  | "expired"
  | "stale_revision"
  | "ambiguous"
  | "disabled"
  | "external_not_verified"
  | "snapshot_too_large"
  | "too_large"
  | "lease_lost"
  | "superseded"
  | "delivery_unknown"
  | "conflict"
  | "enqueue_failed";

export class TeamsWorkError extends Error {
  constructor(readonly code: TeamsWorkErrorCode) {
    super(`Teams work error: ${code}`);
    this.name = "TeamsWorkError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizedUuid = (id: string) => (uuid.test(id) ? id.toLowerCase() : id);
const normalizedText = (text: string) => text.replace(/\s+/gu, " ").trim();
const nonempty = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

function scopeKey(scope: TeamsScope): string {
  if (
    scope === null ||
    typeof scope !== "object" ||
    ![scope.tenantId, scope.teamId, scope.channelId, scope.rootMessageId].every(nonempty)
  )
    throw new TeamsWorkError("invalid_scope");
  return JSON.stringify([
    normalizedUuid(scope.tenantId),
    normalizedUuid(scope.teamId),
    scope.channelId,
    scope.rootMessageId,
  ]);
}

function validIso(value: unknown, dateOnly = false): value is string {
  if (typeof value !== "string") return false;
  const pattern = dateOnly
    ? /^\d{4}-\d{2}-\d{2}$/u
    : /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
  if (!pattern.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function validLink(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://teams.microsoft.com" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

type Identity = { refs: Set<string>; anchor: string; text: string };

function identity(
  item: Pick<TeamsTodoCandidate, "text" | "evidence" | "assigneeAadId" | "dueIso" | "dueText">,
  expectedScope: string,
): Identity {
  const invalid = () => {
    throw new TeamsWorkError("invalid_evidence");
  };
  if (
    typeof item.text !== "string" ||
    normalizedText(item.text) === "" ||
    !Array.isArray(item.evidence) ||
    item.evidence.length === 0 ||
    (item.assigneeAadId !== null &&
      (typeof item.assigneeAadId !== "string" || !uuid.test(item.assigneeAadId))) ||
    (item.dueIso !== null && !validIso(item.dueIso, true) && !validIso(item.dueIso)) ||
    (item.dueText !== null && typeof item.dueText !== "string")
  )
    return invalid();

  const refs = new Set<string>();
  const anchors = new Set<string>();
  for (const evidence of item.evidence) {
    if (evidence === null || typeof evidence !== "object" || !evidence.ref) return invalid();
    const ref = evidence.ref;
    const key = scopeKey(ref);
    if (key !== expectedScope) throw new TeamsWorkError("invalid_scope");
    if (
      !["root", "reply"].includes(ref.kind) ||
      !nonempty(ref.messageId) ||
      (ref.kind === "root" && ref.messageId !== ref.rootMessageId) ||
      typeof evidence.quote !== "string" ||
      normalizedText(evidence.quote) === "" ||
      !validLink(evidence.link) ||
      !validIso(evidence.sourceCreatedAt)
    )
      return invalid();
    const refKey = JSON.stringify([key, ref.kind, ref.messageId]);
    refs.add(refKey);
    anchors.add(JSON.stringify([refKey, normalizedText(evidence.quote)]));
  }
  return {
    refs,
    anchor: JSON.stringify([...anchors].sort()),
    text: normalizedText(item.text),
  };
}

function overlaps(a: Identity, b: Identity): boolean {
  return [...a.refs].some((ref) => b.refs.has(ref));
}

/** 自動継承できない根拠の重なりはすべて明示確認へ回す。 */
export function matchTeamsTodos(input: {
  scope: TeamsScope;
  candidates: TeamsTodoCandidate[];
  existing: TeamsTodoIdentity[];
}): TeamsTodoMatch[] {
  const expectedScope = scopeKey(input.scope);
  const candidates = input.candidates.map((item) => ({ item, ...identity(item, expectedScope) }));
  const existing = input.existing.map((item) => {
    if (scopeKey(item.scope) !== expectedScope) throw new TeamsWorkError("invalid_scope");
    if (!nonempty(item.todoId) || !["open", "done"].includes(item.status))
      throw new TeamsWorkError("invalid_evidence");
    return { item, ...identity(item, expectedScope) };
  });
  return candidates.map((candidate, candidateIndex) => {
    const related = existing.filter((old) => overlaps(candidate, old));
    const collision = candidates.some(
      (other, index) => candidateIndex !== index && overlaps(candidate, other),
    );
    const base: TeamsTodoMatch = {
      candidateIndex,
      kind: "ambiguous",
      todoIds: related.map((old) => old.item.todoId).sort(),
      status: null,
      changes: {},
    };
    if (collision) return base;
    if (related.length === 0) return { ...base, kind: "new" };
    if (related.length !== 1) return base;
    const oldIdentity = related[0];
    if (oldIdentity === undefined) return base;
    if (candidate.anchor !== oldIdentity.anchor || candidate.text !== oldIdentity.text) return base;
    const old = oldIdentity.item;
    const current = candidate.item;
    for (const field of ["assigneeAadId", "dueIso", "dueText"] as const) {
      const from =
        field === "assigneeAadId" && old[field] !== null ? normalizedUuid(old[field]) : old[field];
      const to =
        field === "assigneeAadId" && current[field] !== null
          ? normalizedUuid(current[field])
          : current[field];
      if (from !== to) base.changes[field] = { from, to };
    }
    return {
      ...base,
      kind: Object.keys(base.changes).length === 0 ? "existing" : "update_proposal",
      status: old.status,
    };
  });
}
