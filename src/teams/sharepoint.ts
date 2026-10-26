/** 固定専用Listへの同期。人の列と生成列を分け、etag/hashで更新の成否を復旧する。 */
import { createHash, randomUUID } from "node:crypto";
import type { SummaryModel } from "../slack/render.js";
import { parseTeamsRetryAfter, TeamsApiError } from "./graph.js";
import { teamsWorkTargetId, validateTeamsSnapshot } from "./store/common.js";
import {
  type TeamsScope,
  type TeamsSharePointState,
  type TeamsSnapshot,
  TeamsWorkError,
  type TeamsWorkStore,
} from "./store/types.js";

export type GeneratedFields = Record<string, string>;
export type SharePointRow = { id: string; etag: string; fields: Record<string, unknown> };
export interface TeamsSharePointClient {
  findByKey(siteId: string, listId: string, key: string): Promise<SharePointRow | null>;
  create(siteId: string, listId: string, fields: GeneratedFields): Promise<SharePointRow>;
  get(siteId: string, listId: string, itemId: string): Promise<SharePointRow>;
  patch(
    siteId: string,
    listId: string,
    itemId: string,
    etag: string,
    fields: GeneratedFields,
  ): Promise<SharePointRow>;
}
export type TeamsSharePointBinding = Pick<TeamsScope, "tenantId" | "teamId" | "channelId"> & {
  siteId: string;
  listId: string;
  verified: {
    selected: boolean;
    listWrite: boolean;
    get: boolean;
    search: boolean;
    post: boolean;
    patch: boolean;
    precondition: boolean;
    otherListDenied: boolean;
    sameAudience: boolean;
  };
};
export type TeamsSharePointDeps = {
  store: TeamsWorkStore;
  client: TeamsSharePointClient;
  bindings: readonly TeamsSharePointBinding[];
  now: () => Date;
  owner?: string;
};
export type TeamsSharePointOutcome = { state: "applied" | "pending"; revision: number };
const columns = [
  "ArbalestKey",
  "Title",
  "ThreadUrl",
  "Overview",
  "Decisions",
  "OpenIssues",
  "Todos",
  "Questions",
  "Evidence",
  "GeneratedAt",
  "Revision",
] as const;
const gates = [
  "selected",
  "listWrite",
  "get",
  "search",
  "post",
  "patch",
  "precondition",
  "otherListDenied",
  "sameAudience",
] as const;
function fail(code: ConstructorParameters<typeof TeamsWorkError>[0]): never {
  throw new TeamsWorkError(code);
}
function validateFields(fields: GeneratedFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (!columns.includes(key as (typeof columns)[number]) || typeof value !== "string")
      fail("invalid_evidence");
    if (value.length > 8000) fail("too_large");
  }
}
/** GraphのメタデータやUserNotesを除いた固定列順だけを比較する。 */
export function generatedFieldsHash(fields: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(columns.map((key) => [key, fields[key] ?? ""])))
    .digest("hex");
}
function threadUrl(scope: TeamsScope): string {
  const url = new URL(
    `https://teams.microsoft.com/l/message/${encodeURIComponent(scope.channelId)}/${encodeURIComponent(scope.rootMessageId)}`,
  );
  url.searchParams.set("tenantId", scope.tenantId);
  url.searchParams.set("groupId", scope.teamId);
  url.searchParams.set("parentMessageId", scope.rootMessageId);
  return url.href;
}
function safeEvidence(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("invalid_evidence");
  }
  if (
    url.origin !== "https://teams.microsoft.com" ||
    url.username ||
    url.password ||
    url.href.length > 2048
  )
    fail("invalid_evidence");
  return url.href;
}
/** 検証済み構造から平文の分析列を作る。Markdownを再解析しない。 */
export function teamsSharePointAnalysis(
  model: SummaryModel,
  links: ReadonlyMap<string, string>,
): GeneratedFields {
  const mark = (item: { needsReview: boolean }) => (item.needsReview ? "要確認: " : "");
  const evidence = [
    ...new Set(
      [...(model.overview ?? []), ...model.topics, ...model.todos, ...model.questions].flatMap(
        (item) => item.evidence,
      ),
    ),
  ].map((ts) => {
    const link = links.get(ts);
    return link ? safeEvidence(link) : "要確認: 根拠なし";
  });
  return {
    Overview: (model.overview ?? []).map((x) => `${mark(x)}${x.text}`).join("\n"),
    Decisions: model.topics
      .filter((x) => x.status === "decided")
      .map((x) => `${mark(x)}${x.title}: ${x.decision ?? ""}`)
      .join("\n"),
    OpenIssues: model.topics
      .filter((x) => x.status === "open")
      .map(
        (x) =>
          `${mark(x)}${x.title}: ${x.options.join(" / ")} / 未回答: ${x.pendingParticipants.join("、")}`,
      )
      .join("\n"),
    Questions: model.questions.map((x) => `${mark(x)}${x.text}`).join("\n"),
    Evidence: evidence.join("\n"),
  };
}
function fieldsFor(snapshot: TeamsSnapshot): GeneratedFields {
  const content = snapshot.content;
  const saved = content && typeof content === "object" && !Array.isArray(content) ? content : {};
  const analysis = saved.sharepoint;
  const fields =
    analysis && typeof analysis === "object" && !Array.isArray(analysis) ? analysis : {};
  const names =
    saved.names && typeof saved.names === "object" && !Array.isArray(saved.names)
      ? saved.names
      : {};
  const text = (key: string) => {
    const value = fields[key];
    if (value !== undefined && typeof value !== "string") fail("invalid_evidence");
    return (value as string | undefined) ?? "";
  };
  return {
    ArbalestKey: teamsWorkTargetId(snapshot.scope),
    Title: "Teams スレッド記録",
    ThreadUrl: threadUrl(snapshot.scope),
    Overview: text("Overview"),
    Decisions: text("Decisions"),
    OpenIssues: text("OpenIssues"),
    Questions: text("Questions"),
    Todos: snapshot.todos
      .map(
        (todo) =>
          `T${todo.displayNo} ${todo.text} / ${todo.status === "done" ? "完了済み" : "未完了"} / 担当: ${todo.assigneeAadId ? (names[todo.assigneeAadId] ?? "表示名未取得") : "未定"} / 期限: ${todo.dueIso ?? todo.dueText ?? "未定"}`,
      )
      .join("\n"),
    Evidence: [
      text("Evidence"),
      ...snapshot.todos.flatMap((todo) =>
        todo.evidence.map((e) => `${safeEvidence(e.link)} ${e.quote}`),
      ),
    ]
      .filter(Boolean)
      .join("\n"),
    GeneratedAt: typeof saved.generatedAt === "string" ? saved.generatedAt : "",
    Revision: String(snapshot.revision),
  };
}
function bindingFor(
  scope: TeamsScope,
  bindings: readonly TeamsSharePointBinding[],
): TeamsSharePointBinding {
  const matches = bindings.filter(
    (b) =>
      b.tenantId.toLowerCase() === scope.tenantId.toLowerCase() &&
      b.teamId.toLowerCase() === scope.teamId.toLowerCase() &&
      b.channelId === scope.channelId,
  );
  const binding = matches[0];
  if (
    matches.length !== 1 ||
    !binding ||
    !binding.siteId.trim() ||
    !binding.listId.trim() ||
    gates.some((key) => binding.verified[key] !== true)
  )
    fail("external_not_verified");
  return binding;
}
export async function syncTeamsSharePoint(
  input: { scope: TeamsScope; revision: number },
  deps: TeamsSharePointDeps,
): Promise<TeamsSharePointOutcome> {
  return sync(input, deps);
}
/** 管理者の認証済みAAD ID、確認したrevision、生成列上書きの明示同意が必要。 */
export async function resyncTeamsSharePoint(
  input: {
    scope: TeamsScope;
    revision: number;
    actorAadId: string;
    acknowledgeGeneratedOverwrite: boolean;
  },
  deps: TeamsSharePointDeps,
): Promise<TeamsSharePointOutcome> {
  const settings = await deps.store.getSettings(input.scope);
  if (!settings || settings.managerAadId !== input.actorAadId.toLowerCase()) fail("unauthorized");
  const record = await deps.store.getRecord(input.scope);
  if (!record || record.desiredRevision !== input.revision) fail("stale_revision");
  if (input.acknowledgeGeneratedOverwrite !== true) fail("conflict");
  return sync(input, deps, input.actorAadId);
}
async function sync(
  input: { scope: TeamsScope; revision: number },
  deps: TeamsSharePointDeps,
  resyncActor?: string,
): Promise<TeamsSharePointOutcome> {
  const binding = bindingFor(input.scope, deps.bindings);
  const record = await deps.store.getRecord(input.scope);
  if (!record) return fail("not_found");
  if (record.desiredRevision !== input.revision) fail("superseded");
  validateTeamsSnapshot(record.snapshot, input.scope, input.revision);
  const previous = record.sharepoint;
  if (previous && (previous.siteId !== binding.siteId || previous.listId !== binding.listId))
    fail("invalid_scope");
  const operationId = `sharepoint_${record.targetId}_${input.revision}`;
  await deps.store.reserveEffect({
    operationId,
    scope: input.scope,
    kind: "sharepoint",
    revision: input.revision,
    snapshot: record.snapshot,
    expireAt: record.expireAt,
    now: deps.now(),
  });
  const lease = await deps.store.claimEffect(operationId, deps.owner ?? randomUUID(), deps.now(), {
    reapply: !!resyncActor,
  });
  if (!lease)
    return {
      state:
        previous?.state === "applied" && previous.appliedRevision === input.revision
          ? "applied"
          : "pending",
      revision: input.revision,
    };
  const owned = () => ({
    scope: input.scope,
    operationId,
    owner: lease.leaseOwner,
    fencingToken: lease.fencingToken,
    now: deps.now(),
  });
  const state: TeamsSharePointState = previous
    ? structuredClone(previous)
    : {
        siteId: binding.siteId,
        listId: binding.listId,
        arbalestKey: record.targetId,
        itemId: null,
        etag: null,
        appliedRevision: 0,
        appliedHash: null,
        pendingRevision: null,
        pendingHash: null,
        pendingGeneratedFields: null,
        state: "pending",
      };
  const save = () =>
    deps.store.saveRecord({
      ...owned(),
      revision: input.revision,
      snapshot: record.snapshot,
      sharepoint: state,
      progress: {
        sharepoint:
          state.state === "applied" ? "applied" : state.state === "pending" ? "pending" : "failed",
      },
    });
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    await deps.store.extendEffectLease(owned());
    return fn();
  };
  const accept = async (row: SharePointRow) => {
    if (
      !row.id?.trim() ||
      !row.etag?.trim() ||
      generatedFieldsHash(row.fields) !== state.pendingHash ||
      String(row.fields.Revision) !== String(state.pendingRevision)
    )
      fail("conflict");
    state.itemId = row.id;
    state.etag = row.etag;
    state.appliedHash = state.pendingHash;
    state.appliedRevision = input.revision;
    state.state = "applied";
    await save();
    await deps.store.saveEffect({ ...owned(), state: "applied" });
    return { state: "applied" as const, revision: input.revision };
  };
  try {
    if (state.state === "conflict" && !resyncActor) fail("conflict");
    const fields =
      state.pendingRevision === input.revision && state.pendingGeneratedFields
        ? state.pendingGeneratedFields
        : fieldsFor(record.snapshot);
    validateFields(fields);
    const read = () =>
      state.itemId
        ? call(() => deps.client.get(binding.siteId, binding.listId, state.itemId as string))
        : call(() => deps.client.findByKey(binding.siteId, binding.listId, state.arbalestKey));
    let row: SharePointRow | null | undefined;
    if (
      previous?.pendingRevision !== null &&
      previous?.pendingRevision !== undefined &&
      previous.pendingRevision < input.revision
    ) {
      // 旧予定の証跡を消す前に、その保存済み予定の実行結果だけを読み取る。
      if (
        !previous.pendingGeneratedFields ||
        !previous.pendingHash ||
        generatedFieldsHash(previous.pendingGeneratedFields) !== previous.pendingHash
      )
        fail("conflict");
      await save();
      row = await read();
      if (
        row &&
        generatedFieldsHash(row.fields) === previous.pendingHash &&
        String(row.fields.Revision) === String(previous.pendingRevision)
      ) {
        state.appliedHash = previous.pendingHash;
        state.appliedRevision = previous.pendingRevision;
        state.itemId = row.id;
        state.etag = row.etag;
        await save();
      } else if (row && generatedFieldsHash(row.fields) !== state.appliedHash && !resyncActor)
        fail("conflict");
    }
    state.pendingGeneratedFields = fields;
    state.pendingHash = generatedFieldsHash(fields);
    state.pendingRevision = input.revision;
    state.state = "pending";
    await save();
    if (row === undefined) row = await read();
    if (resyncActor && row) {
      const settings = await deps.store.getSettings(input.scope);
      if (!settings || settings.managerAadId !== resyncActor.toLowerCase()) fail("unauthorized");
      if (row.fields.ArbalestKey !== state.arbalestKey) fail("conflict");
      // 確認した現在行だけを基準にする。PATCHのIf-Match後の競合も再照合する。
      state.appliedHash = generatedFieldsHash(row.fields);
      await save();
    }
    if (!row) {
      try {
        row = await call(() => deps.client.create(binding.siteId, binding.listId, fields));
      } catch (error) {
        row = await call(() =>
          deps.client.findByKey(binding.siteId, binding.listId, state.arbalestKey),
        );
        if (!row) throw error;
      }
      return await accept(row);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const actual = generatedFieldsHash(row.fields);
      if (
        actual === state.pendingHash &&
        String(row.fields.Revision) === String(state.pendingRevision)
      )
        return await accept(row);
      if (!state.appliedHash || actual !== state.appliedHash) fail("conflict");
      if (row.fields.ArbalestKey !== state.arbalestKey || !row.id?.trim() || !row.etag?.trim())
        fail("conflict");
      state.itemId = row.id;
      state.etag = row.etag;
      await save();
      const current = row;
      try {
        return await accept(
          await call(() =>
            deps.client.patch(binding.siteId, binding.listId, current.id, current.etag, fields),
          ),
        );
      } catch (error) {
        if (!(error instanceof TeamsApiError) || (error.status !== 412 && !error.retryable))
          throw error;
        row = await call(() =>
          deps.client.get(binding.siteId, binding.listId, state.itemId as string),
        );
        if (generatedFieldsHash(row.fields) === state.pendingHash) return await accept(row);
        if (generatedFieldsHash(row.fields) !== state.appliedHash) fail("conflict");
        if (error.status !== 412 || attempt === 2) throw error;
      }
    }
    return fail("conflict");
  } catch (error) {
    state.state =
      error instanceof TeamsWorkError && error.code === "conflict"
        ? "conflict"
        : error instanceof TeamsWorkError && error.code === "too_large"
          ? "too_large"
          : "failed";
    await save();
    await deps.store.saveEffect({ ...owned(), state: "failed" });
    if (error instanceof TeamsApiError || error instanceof TeamsWorkError) throw error;
    throw new TeamsApiError(0);
  }
}

/** URLは設定済みsite/listとエンコードしたitem IDだけから作る。nextLinkは追わない。 */
export function createTeamsSharePointClient(options: {
  siteId: string;
  listId: string;
  token: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): TeamsSharePointClient {
  const segment = (id: string) => {
    if (!id.trim() || id === "." || id === "..") fail("invalid_scope");
    return encodeURIComponent(id);
  };
  const base = `https://graph.microsoft.com/v1.0/sites/${segment(options.siteId)}/lists/${segment(options.listId)}/items`;
  const check = (siteId: string, listId: string) => {
    if (siteId !== options.siteId || listId !== options.listId) fail("invalid_scope");
  };
  const request = async (
    url: string,
    method = "GET",
    body?: unknown,
    etag?: string,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      const token = await options.token();
      if (!token.trim()) throw new TeamsApiError(401);
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(etag ? { "If-Match": etag } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof TeamsApiError) throw error;
      throw new TeamsApiError(0);
    }
    if (!response.ok)
      throw new TeamsApiError(
        response.status,
        parseTeamsRetryAfter(response.headers.get("retry-after")),
      );
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TeamsApiError(422);
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof TeamsApiError) throw error;
      throw new TeamsApiError(0);
    }
  };
  const row = (value: Record<string, unknown>): SharePointRow => {
    const etag = value.eTag ?? value["@odata.etag"];
    if (
      typeof value.id !== "string" ||
      !value.id.trim() ||
      typeof etag !== "string" ||
      !etag.trim() ||
      !value.fields ||
      typeof value.fields !== "object" ||
      Array.isArray(value.fields)
    )
      throw new TeamsApiError(422);
    return { id: value.id, etag, fields: value.fields as Record<string, unknown> };
  };
  const get = async (site: string, list: string, item: string) => {
    check(site, list);
    const result = row(await request(`${base}/${segment(item)}?$expand=fields`));
    if (result.id !== item) throw new TeamsApiError(422);
    return result;
  };
  return {
    get,
    async findByKey(site, list, key) {
      check(site, list);
      if (!/^teams_[a-f0-9]{64}$/.test(key)) fail("invalid_scope");
      const url = new URL(base);
      url.searchParams.set("$expand", "fields");
      url.searchParams.set("$filter", `fields/ArbalestKey eq '${key}'`);
      url.searchParams.set("$top", "2");
      const result = await request(url.href);
      if (!Array.isArray(result.value) || result.value.length > 1 || result["@odata.nextLink"])
        fail("conflict");
      if (!result.value.length) return null;
      const found = row(result.value[0] as Record<string, unknown>);
      if (found.fields.ArbalestKey !== key) fail("conflict");
      return found;
    },
    async create(site, list, fields) {
      check(site, list);
      validateFields(fields);
      const result = await request(base, "POST", { fields });
      // createの応答にfieldsが無い場合も、保存されたIDの固定GETで確認する。
      if (typeof result.id !== "string") throw new TeamsApiError(422);
      return result.fields ? row(result) : get(site, list, result.id);
    },
    async patch(site, list, item, etag, fields) {
      check(site, list);
      validateFields(fields);
      if (!etag.trim()) fail("invalid_evidence");
      await request(`${base}/${segment(item)}/fields`, "PATCH", fields, etag);
      // PATCHはfieldValueSetを返すため、itemのetagを固定GETで再取得する。
      return get(site, list, item);
    },
  };
}
