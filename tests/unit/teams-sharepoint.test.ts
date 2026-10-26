import { describe, expect, it, vi } from "vitest";
import { TeamsApiError } from "../../src/teams/graph.js";
import {
  createTeamsSharePointClient,
  generatedFieldsHash,
  resyncTeamsSharePoint,
  type SharePointRow,
  syncTeamsSharePoint,
  type TeamsSharePointBinding,
  type TeamsSharePointClient,
  teamsSharePointAnalysis,
} from "../../src/teams/sharepoint.js";
import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";
import { actor, scope, start } from "../shared/teamsStoreContract.js";

const binding: TeamsSharePointBinding = {
  tenantId: scope.tenantId,
  teamId: scope.teamId,
  channelId: scope.channelId,
  siteId: "site",
  listId: "list",
  verified: {
    selected: true,
    listWrite: true,
    get: true,
    search: true,
    post: true,
    patch: true,
    precondition: true,
    otherListDenied: true,
    sameAudience: true,
  },
};
async function setup(overview = "概要") {
  const store = createMemoryTeamsWorkStore({ now: () => start });
  await store.ensureSettings({ scope, actorAadId: actor, now: start });
  await store.reserveRecord({
    scope,
    actorAadId: actor,
    now: start,
    expectedRevision: 0,
    snapshot: {
      scope,
      revision: 1,
      slots: ["表示"],
      todos: [],
      content: {
        sharepoint: {
          Overview: overview,
          Decisions: "決定",
          OpenIssues: "未決定",
          Questions: "問い",
          Evidence: "",
        },
        generatedAt: start.toISOString(),
      },
    },
  });
  let row: SharePointRow | null = null;
  const client = {
    findByKey: vi.fn<TeamsSharePointClient["findByKey"]>(async () => row),
    get: vi.fn<TeamsSharePointClient["get"]>(async () => {
      if (!row) throw new TeamsApiError(404);
      return row;
    }),
    create: vi.fn<TeamsSharePointClient["create"]>(async (_s, _l, fields) => {
      row = { id: "1", etag: "e1", fields: { ...fields, UserNotes: "人のメモ" } };
      return row;
    }),
    patch: vi.fn<TeamsSharePointClient["patch"]>(async (_s, _l, _i, _e, fields) => {
      row = { id: "1", etag: "e2", fields: { ...fields, UserNotes: "更新メモ" } };
      return row;
    }),
  };
  return {
    store,
    client,
    bindings: [structuredClone(binding)],
    now: () => start,
    row: () => row,
    setRow: (value: SharePointRow) => {
      row = value;
    },
  };
}
const input = { scope, revision: 1 };
describe("Teams SharePoint同期", () => {
  it.each(Object.keys(binding.verified))("ゲート %s 未達では一切送らない", async (gate) => {
    const s = await setup();
    Object.assign(s.bindings[0]?.verified ?? {}, { [gate]: false });
    await expect(syncTeamsSharePoint(input, s)).rejects.toMatchObject({
      code: "external_not_verified",
    });
    expect(s.client.findByKey).not.toHaveBeenCalled();
  });
  it("固定scope以外は拒否", async () => {
    const s = await setup();
    s.bindings[0] = { ...binding, channelId: "other" };
    await expect(syncTeamsSharePoint(input, s)).rejects.toMatchObject({
      code: "external_not_verified",
    });
  });
  it("外部検索より前に予定を保存しUserNotesを送らない", async () => {
    const s = await setup();
    s.client.findByKey.mockImplementation(async () => {
      const state = (await s.store.getRecord(scope))?.sharepoint;
      expect(state?.pendingRevision).toBe(1);
      expect(state?.pendingHash).toBe(generatedFieldsHash(state?.pendingGeneratedFields ?? {}));
      return null;
    });
    expect(await syncTeamsSharePoint(input, s)).toMatchObject({ state: "applied" });
    expect(s.client.create.mock.calls[0]?.[2]).not.toHaveProperty("UserNotes");
    expect(s.row()?.fields.UserNotes).toBe("人のメモ");
    expect((await s.store.getRecord(scope))?.sharepoint?.appliedRevision).toBe(1);
  });
  it.each([0, 409])("POST応答紛失/一意競合 %s は再検索する", async (status) => {
    const s = await setup();
    s.client.create.mockImplementation(async (_a, _b, fields) => {
      s.setRow({ id: "1", etag: "new", fields });
      throw new TeamsApiError(status);
    });
    await expect(syncTeamsSharePoint(input, s)).resolves.toMatchObject({ state: "applied" });
    expect(s.client.findByKey).toHaveBeenCalledTimes(2);
    expect(s.client.create).toHaveBeenCalledOnce();
  });
  it("初回検索で既存の異なる生成列を上書きしない", async () => {
    const s = await setup();
    s.setRow({ id: "1", etag: "e", fields: { Overview: "人の編集" } });
    await expect(syncTeamsSharePoint(input, s)).rejects.toMatchObject({ code: "conflict" });
    expect(s.client.patch).not.toHaveBeenCalled();
  });
  it("旧revisionのPOST結果不明を予定hashで復旧して最新revisionへ進む", async () => {
    const s = await setup();
    const save = s.store.saveRecord.bind(s.store);
    vi.spyOn(s.store, "saveRecord").mockImplementation(async (value) => {
      if (value.sharepoint?.state === "applied") throw new Error("synthetic outage");
      return save(value);
    });
    await expect(syncTeamsSharePoint(input, s)).rejects.toBeDefined();
    vi.mocked(s.store.saveRecord).mockImplementation(save);
    const record = await s.store.getRecord(scope);
    if (!record) throw new Error("record");
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...record.snapshot, revision: 2 },
    });
    await expect(syncTeamsSharePoint({ scope, revision: 2 }, s)).resolves.toMatchObject({
      state: "applied",
    });
    expect(s.client.create).toHaveBeenCalledOnce();
    expect(s.client.patch).toHaveBeenCalledOnce();
  });
  it("外部成功後の全保存停止でも旧pending hashを照合して次revisionを適用", async () => {
    const s = await setup();
    const save = s.store.saveRecord.bind(s.store);
    let saved = false;
    vi.spyOn(s.store, "saveRecord").mockImplementation(async (value) => {
      if (saved) throw new Error("synthetic outage");
      await save(value);
      saved = true;
    });
    await expect(syncTeamsSharePoint(input, s)).rejects.toBeDefined();
    vi.mocked(s.store.saveRecord).mockImplementation(save);
    const record = await s.store.getRecord(scope);
    if (!record) throw new Error("record");
    expect(record.sharepoint?.appliedHash).toBeNull();
    expect(record.sharepoint?.pendingRevision).toBe(1);
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...record.snapshot, revision: 2 },
    });
    await expect(syncTeamsSharePoint({ scope, revision: 2 }, s)).resolves.toMatchObject({
      state: "applied",
    });
    expect(s.client.create).toHaveBeenCalledOnce();
    expect(s.client.patch).toHaveBeenCalledOnce();
  });
  it("次revisionの照合中に通信失敗しても旧pending証跡を保持する", async () => {
    const s = await setup();
    const save = s.store.saveRecord.bind(s.store);
    let saved = false;
    vi.spyOn(s.store, "saveRecord").mockImplementation(async (value) => {
      if (saved) throw new Error("synthetic outage");
      await save(value);
      saved = true;
    });
    await expect(syncTeamsSharePoint(input, s)).rejects.toBeDefined();
    vi.mocked(s.store.saveRecord).mockImplementation(save);
    const record = await s.store.getRecord(scope);
    if (!record) throw new Error("record");
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...record.snapshot, revision: 2 },
    });
    s.client.findByKey.mockRejectedValueOnce(new TeamsApiError(0));
    await expect(syncTeamsSharePoint({ scope, revision: 2 }, s)).rejects.toMatchObject({
      status: 0,
    });
    expect((await s.store.getRecord(scope))?.sharepoint?.pendingRevision).toBe(1);
    await expect(syncTeamsSharePoint({ scope, revision: 2 }, s)).resolves.toMatchObject({
      state: "applied",
    });
    expect(s.client.create).toHaveBeenCalledOnce();
  });
  it("応答後保存失敗は先行予定値を保持し、再試行で同じ行を復旧", async () => {
    const s = await setup();
    const save = s.store.saveRecord.bind(s.store);
    vi.spyOn(s.store, "saveRecord").mockImplementation(async (value) => {
      if (value.sharepoint?.state === "applied") throw new Error("synthetic storage outage");
      return save(value);
    });
    await expect(syncTeamsSharePoint(input, s)).rejects.toBeDefined();
    vi.mocked(s.store.saveRecord).mockImplementation(save);
    await expect(syncTeamsSharePoint(input, s)).resolves.toMatchObject({ state: "applied" });
    expect(s.client.create).toHaveBeenCalledOnce();
  });
  it("412で生成列を人が変えたらconflictで停止", async () => {
    const s = await setup();
    await syncTeamsSharePoint(input, s);
    const record = await s.store.getRecord(scope);
    if (!record) throw new Error("record");
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...record.snapshot, revision: 2 },
    });
    s.client.patch.mockImplementationOnce(async () => {
      const row = s.row();
      if (!row) throw new Error("row");
      s.setRow({ ...row, etag: "human", fields: { ...row.fields, Overview: "人の編集" } });
      throw new TeamsApiError(412);
    });
    await expect(syncTeamsSharePoint({ scope, revision: 2 }, s)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(s.client.patch).toHaveBeenCalledOnce();
    await expect(
      resyncTeamsSharePoint(
        { scope, revision: 2, actorAadId: "other", acknowledgeGeneratedOverwrite: true },
        s,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      resyncTeamsSharePoint(
        { scope, revision: 1, actorAadId: actor, acknowledgeGeneratedOverwrite: true },
        s,
      ),
    ).rejects.toMatchObject({ code: "stale_revision" });
    await expect(
      resyncTeamsSharePoint(
        { scope, revision: 2, actorAadId: actor, acknowledgeGeneratedOverwrite: false },
        s,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      resyncTeamsSharePoint(
        { scope, revision: 2, actorAadId: actor, acknowledgeGeneratedOverwrite: true },
        s,
      ),
    ).resolves.toMatchObject({ state: "applied" });
    expect(s.client.patch.mock.calls[1]?.[3]).toBe("human");
  });
  it("検証済み構造の平文列と固定Teams根拠だけを保存", () => {
    const model = {
      overview: [{ id: "k1", text: "概要", evidence: ["1"], needsReview: false }],
      topics: [],
      todos: [],
      questions: [],
    };
    expect(
      teamsSharePointAnalysis(
        model,
        new Map([["1", "https://teams.microsoft.com/l/message/channel/root"]]),
      ),
    ).toMatchObject({
      Overview: "概要",
      Evidence: "https://teams.microsoft.com/l/message/channel/root",
    });
    expect(() =>
      teamsSharePointAnalysis(model, new Map([["1", "https://evil.example/"]])),
    ).toThrow();
  });
  it.each([0, 412])("PATCH %s 後に予定値があれば適用済みにする", async (status) => {
    const s = await setup();
    await syncTeamsSharePoint(input, s);
    const record = await s.store.getRecord(scope);
    if (!record) throw new Error("record");
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: {
        ...record.snapshot,
        revision: 2,
        content: { sharepoint: { Overview: "次" }, generatedAt: start.toISOString() },
      },
    });
    s.client.patch.mockImplementation(async (_a, _b, _c, etag, fields) => {
      expect(etag).toBe("e1");
      s.setRow({ id: "1", etag: "e3", fields });
      throw new TeamsApiError(status);
    });
    await expect(syncTeamsSharePoint({ scope, revision: 2 }, s)).resolves.toMatchObject({
      state: "applied",
    });
  });
  it("412でUserNotesだけ変更されていれば新etagで再試行", async () => {
    const s = await setup();
    await syncTeamsSharePoint(input, s);
    const record = await s.store.getRecord(scope);
    if (!record) throw new Error("record");
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...record.snapshot, revision: 2 },
    });
    s.client.patch.mockImplementationOnce(async () => {
      const row = s.row();
      if (!row) throw new Error("row");
      s.setRow({ ...row, etag: "human", fields: { ...row.fields, UserNotes: "人" } });
      throw new TeamsApiError(412);
    });
    await syncTeamsSharePoint({ scope, revision: 2 }, s);
    expect(s.client.patch.mock.calls[1]?.[3]).toBe("human");
    expect(s.client.patch.mock.calls[1]?.[4]).not.toHaveProperty("UserNotes");
  });
  it.each([8000, 8001])("生成列%s文字は境界で停止", async (size) => {
    const s = await setup("あ".repeat(size));
    if (size === 8000)
      await expect(syncTeamsSharePoint(input, s)).resolves.toMatchObject({ state: "applied" });
    else {
      await expect(syncTeamsSharePoint(input, s)).rejects.toMatchObject({ code: "too_large" });
      expect(s.client.create).not.toHaveBeenCalled();
      expect((await s.store.getRecord(scope))?.sharepoint?.state).toBe("too_large");
    }
  });
});
describe("固定Graph SharePoint client", () => {
  it("412を保持して外部例外本文を公開しない", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("synthetic private body", { status: 412 }));
    const c = createTeamsSharePointClient({
      siteId: "site",
      listId: "list",
      token: async () => "synthetic",
      fetch,
    });
    try {
      await c.patch("site", "list", "1", "e1", { Overview: "概要" });
      throw new Error("expected error");
    } catch (error) {
      expect(error).toMatchObject({ status: 412, retryable: false });
      expect(String(error)).not.toContain("synthetic private body");
    }
  });
  it("syncのscope由来ArbalestKeyで実HTTP factoryまで接続できる", async () => {
    const s = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { fields: Record<string, string> };
        return Response.json({ id: "1", eTag: "e1", fields: body.fields });
      }
      return Response.json({ value: [] });
    });
    const client = createTeamsSharePointClient({
      siteId: "site",
      listId: "list",
      token: async () => "synthetic",
      fetch,
    });
    await expect(syncTeamsSharePoint(input, { ...s, client })).resolves.toMatchObject({
      state: "applied",
    });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("$filter")).toMatch(
      /fields\/ArbalestKey eq 'teams_[a-f0-9]{64}'/,
    );
  });
  it("固定List、検索filter、POST envelope、If-Matchとredirect禁止", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "PATCH") return Response.json({});
      if (init?.method === "POST")
        return Response.json({ id: "1", eTag: "e", fields: { Overview: "概要" } });
      if (String(_url).includes("%24filter")) return Response.json({ value: [] });
      return Response.json({ id: "1", eTag: "e", fields: { Overview: "概要" } });
    });
    const c = createTeamsSharePointClient({
      siteId: "site",
      listId: "list",
      token: async () => "synthetic",
      fetch,
    });
    await c.findByKey("site", "list", `teams_${"a".repeat(64)}`);
    await c.create("site", "list", { Overview: "概要" });
    await c.patch("site", "list", "1", "etag", { Overview: "概要" });
    expect(
      fetch.mock.calls.every(
        ([url, init]) =>
          String(url).startsWith("https://graph.microsoft.com/v1.0/sites/site/lists/list/items") &&
          init?.redirect === "error",
      ),
    ).toBe(true);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ fields: { Overview: "概要" } }));
    expect(fetch.mock.calls[2]?.[1]?.headers).toMatchObject({ "If-Match": "etag" });
    await expect(c.get("site", "other", "1")).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(c.create("site", "list", { UserNotes: "危険" })).rejects.toMatchObject({
      code: "invalid_evidence",
    });
  });
});
