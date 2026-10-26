import { describe, expect, it, vi } from "vitest";
import { TeamsApiError } from "../../src/teams/graph.js";
import type { TeamsRecordWriter } from "../../src/teams/records.js";
import {
  flushTeamsTodoCards,
  recoverTeamsRecord,
  renderTeamsRecordSnapshot,
  reserveTeamsTodoCards,
  syncTeamsRecord,
} from "../../src/teams/records.js";
import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";
import { actor, candidate, registration, scope, start } from "../shared/teamsStoreContract.js";

async function setup(texts = ["表示"]) {
  let clock = start;
  const now = () => clock;
  const store = createMemoryTeamsWorkStore({ now });
  await store.ensureSettings({
    scope,
    actorAadId: actor,
    now: start,
    reference: {
      serviceUrl: "https://smba.trafficmanager.net/jp/",
      conversationId: `${scope.channelId};messageid=${scope.rootMessageId}`,
    },
  });
  await store.reserveRecord({
    scope,
    actorAadId: actor,
    now: start,
    expectedRevision: 0,
    snapshot: { scope, revision: 1, slots: texts, todos: [] },
  });
  const writer = {
    create: vi.fn<TeamsRecordWriter["create"]>().mockResolvedValue({ activityId: "post" }),
    update: vi.fn<TeamsRecordWriter["update"]>().mockResolvedValue(undefined),
  };
  return {
    store,
    writer,
    now,
    owner: "worker",
    setClock: (date: Date) => {
      clock = date;
    },
  };
}
const input = { scope, revision: 1 };
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("必要なテスト値がありません");
  return value;
}

describe("Teams管理投稿", () => {
  it("7件以上の操作を最大3件のActionSetへ分割し全tokenを残す", async () => {
    const s = await setup();
    const { todo } = await s.store.register({ ...registration(), recordPolicy: "none" });
    const payload = { ...scope, taskName: "many-cards", userId: actor };
    const outcome = {
      names: {},
      candidates: [],
      todos: Array.from({ length: 7 }, (_, index) => ({ ...todo, displayNo: index + 1 })),
      changed: 0,
      rejected: [],
      record: { state: "skipped" as const, revision: null, operationId: null },
    };
    await reserveTeamsTodoCards({ payload, outcome }, s);
    await flushTeamsTodoCards({ payload, activityId: "list", text: "一覧" }, s);
    const card = present(s.writer.update.mock.calls[0])?.[3].card as {
      body: { type: string; actions?: { title: string; data: Record<string, string> }[] }[];
    };
    const sets = card.body.filter((element) => element.type === "ActionSet");
    expect(sets).toHaveLength(3);
    expect(sets.every((element) => (element.actions?.length ?? 0) <= 3)).toBe(true);
    const actions = sets.flatMap((element) => element.actions ?? []);
    expect(actions).toHaveLength(8);
    for (const action of actions) expect(Object.keys(action.data)).toEqual(["token"]);
  });
  it("create前にcreatingを保存し、ID確定後はupdateだけで再表示する", async () => {
    const s = await setup();
    s.writer.create.mockImplementation(async () => {
      expect((await s.store.getRecord(scope))?.slots[0]?.state).toBe("creating");
      return { activityId: "post" };
    });
    expect(await syncTeamsRecord(input, s)).toMatchObject({ state: "applied" });
    await syncTeamsRecord(input, s);
    expect(s.writer.create).toHaveBeenCalledOnce();
    const record = present(await s.store.getRecord(scope));
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...record.snapshot, revision: 2, slots: ["更新"] },
    });
    await syncTeamsRecord({ scope, revision: 2 }, s);
    expect(s.writer.update).toHaveBeenCalledWith(scope, expect.anything(), "post", {
      text: "更新",
    });
  });
  it.each(["empty", "network", "save"])("%sの作成結果不明は自動再作成しない", async (kind) => {
    const s = await setup();
    if (kind === "empty") s.writer.create.mockResolvedValue({ activityId: "" });
    if (kind === "network") s.writer.create.mockRejectedValue(new TeamsApiError(503));
    if (kind === "save") {
      const original = s.store.saveRecord;
      vi.spyOn(s.store, "saveRecord").mockImplementation(async (value) => {
        if (value.slots?.some((slot) => slot.state === "applied")) throw new Error("database");
        return original(value);
      });
    }
    await expect(syncTeamsRecord(input, s)).rejects.toMatchObject({ code: "delivery_unknown" });
    await syncTeamsRecord(input, s);
    expect(s.writer.create).toHaveBeenCalledOnce();
    const record = present(await s.store.getRecord(scope));
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...record.snapshot, revision: 2 },
    });
    await syncTeamsRecord({ scope, revision: 2 }, s);
    expect(s.writer.create).toHaveBeenCalledOnce();
  });
  it("最新revisionとleaseを送信直前にも検査する", async () => {
    const s = await setup();
    await expect(syncTeamsRecord({ scope, revision: 2 }, s)).rejects.toMatchObject({
      code: "superseded",
    });
    const original = s.store.extendEffectLease;
    vi.spyOn(s.store, "extendEffectLease").mockImplementation(async (value) => {
      s.setClock(new Date(start.getTime() + 60_000));
      return original(value);
    });
    await expect(syncTeamsRecord(input, s)).rejects.toMatchObject({ code: "lease_lost" });
    expect(s.writer.create).not.toHaveBeenCalled();
  });
  it.each(["scope", "ownership"])("保存slotの%s不一致はupdateしない", async (kind) => {
    const s = await setup();
    const record = present(await s.store.getRecord(scope));
    const slot = present(record.slots[0]);
    slot.activityId = "other-post";
    if (kind === "scope") slot.scope = { ...scope, rootMessageId: "other" };
    else slot.botOwned = false;
    vi.spyOn(s.store, "getRecord").mockResolvedValue(record);
    await expect(syncTeamsRecord(input, s)).rejects.toMatchObject({ code: "invalid_scope" });
    expect(s.writer.update).not.toHaveBeenCalled();
    expect(s.writer.create).not.toHaveBeenCalled();
  });
  it.each(["lease", "revision"])(
    "create中の%s喪失は後続workerでも自動再作成しない",
    async (kind) => {
      const s = await setup();
      s.writer.create.mockImplementation(async () => {
        if (kind === "lease") s.setClock(new Date(start.getTime() + 60_000));
        else {
          const record = present(await s.store.getRecord(scope));
          await s.store.reserveRecord({
            scope,
            actorAadId: actor,
            now: start,
            expectedRevision: 1,
            snapshot: { ...record.snapshot, revision: 2 },
          });
        }
        return { activityId: "created-but-not-saved" };
      });
      await expect(syncTeamsRecord(input, s)).rejects.toMatchObject({ code: "delivery_unknown" });
      await syncTeamsRecord({ scope, revision: kind === "revision" ? 2 : 1 }, s);
      expect(s.writer.create).toHaveBeenCalledOnce();
      expect((await s.store.getRecord(scope))?.slots[0]?.state).toBe("delivery_unknown");
    },
  );
  it("明示再作成だけが結果不明から新規作成を再開できる", async () => {
    const s = await setup();
    s.writer.create.mockResolvedValueOnce({ activityId: "" });
    await expect(syncTeamsRecord(input, s)).rejects.toMatchObject({ code: "delivery_unknown" });
    await recoverTeamsRecord(
      { ...input, actorAadId: actor, slot: 0, mode: "recreate", acknowledgeDuplicate: true },
      s,
    );
    await syncTeamsRecord(input, s);
    expect(s.writer.create).toHaveBeenCalledTimes(2);
    expect((await s.store.getRecord(scope))?.slots[0]?.activityId).toBe("post");
  });
  it.each(["slot", "snapshot"])("再読込%s上限違反は送信を止める", async (kind) => {
    const s = await setup();
    const record = present(await s.store.getRecord(scope));
    if (kind === "slot") record.snapshot.slots = ["x".repeat(8001)];
    else record.snapshot.content = "x".repeat(256 * 1024);
    vi.spyOn(s.store, "getRecord").mockResolvedValue(record);
    await expect(syncTeamsRecord(input, s)).rejects.toMatchObject({
      code: kind === "slot" ? "too_large" : "snapshot_too_large",
    });
    expect(s.writer.create).not.toHaveBeenCalled();
  });
  it("縮小slotは統合済みに更新し、404は明示再取得まで再作成しない", async () => {
    const s = await setup(["a", "b"]);
    s.writer.create
      .mockResolvedValueOnce({ activityId: "a" })
      .mockResolvedValueOnce({ activityId: "b" });
    await syncTeamsRecord(input, s);
    const old = present(await s.store.getRecord(scope));
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 1,
      snapshot: { ...old.snapshot, revision: 2, slots: ["merged"] },
    });
    s.writer.update.mockRejectedValueOnce(new TeamsApiError(404));
    await syncTeamsRecord({ scope, revision: 2 }, s);
    await syncTeamsRecord({ scope, revision: 2 }, s);
    expect(s.writer.create).toHaveBeenCalledTimes(2);
    await syncTeamsRecord({ scope, revision: 2, explicitRefresh: true }, s);
    expect(s.writer.create).toHaveBeenCalledTimes(3);
    expect(s.writer.update).toHaveBeenCalledWith(scope, expect.anything(), "b", {
      text: "この内容は統合済み",
    });
  });
  it("管理者の再関連付けは外部のscope/bot所有を検査し、明示再作成は重複確認が必須", async () => {
    const s = await setup();
    s.writer.create.mockResolvedValue({ activityId: "" });
    await expect(syncTeamsRecord(input, s)).rejects.toMatchObject({ code: "delivery_unknown" });
    const recovery = {
      ...input,
      actorAadId: actor,
      slot: 0,
      mode: "relink" as const,
      activityId: "found",
    };
    const verifyActivity = vi
      .fn()
      .mockResolvedValue({ scope: { ...scope, rootMessageId: "other" }, botOwned: true });
    await expect(recoverTeamsRecord(recovery, { ...s, verifyActivity })).rejects.toMatchObject({
      code: "invalid_scope",
    });
    verifyActivity.mockResolvedValue({ scope, botOwned: false });
    await expect(recoverTeamsRecord(recovery, { ...s, verifyActivity })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      recoverTeamsRecord({ ...recovery, mode: "recreate", acknowledgeDuplicate: false }, s),
    ).rejects.toMatchObject({ code: "delivery_unknown" });
    verifyActivity.mockResolvedValue({ scope, botOwned: true });
    await recoverTeamsRecord(recovery, { ...s, verifyActivity });
    await syncTeamsRecord(input, s);
    expect(s.writer.create).toHaveBeenCalledOnce();
    expect(s.writer.update).toHaveBeenCalledWith(scope, expect.anything(), "found", {
      text: "表示",
    });
  });
  it("rendererは以前の分析表示を保持して現在の台帳で差し替える", () => {
    const previous = {
      scope,
      revision: 1,
      todos: [],
      slots: ["## 会話の概要\n分析\n## 登録済みToDo\n旧台帳"],
    };
    const snapshot = renderTeamsRecordSnapshot({ scope, revision: 2, todos: [], previous });
    expect(snapshot.slots.join("\n")).toContain("分析");
    expect(snapshot.slots.join("\n")).not.toContain("旧台帳");
  });
  it("修復はappliedの最新表示を再適用するが新規createしない", async () => {
    const s = await setup();
    await syncTeamsRecord(input, s);
    await syncTeamsRecord({ ...input, repair: true }, s);
    expect(s.writer.create).toHaveBeenCalledOnce();
    expect(s.writer.update).toHaveBeenCalledOnce();
  });
  it("明示todoは候補がなくてもopen台帳の完了カードを付加する", async () => {
    const s = await setup();
    const { todo } = await s.store.register({ ...registration(), recordPolicy: "none" });
    const payload = { ...scope, taskName: "done-card", userId: actor };
    const outcome = {
      names: {},
      candidates: [],
      todos: [todo],
      changed: 0,
      rejected: [],
      record: { state: "skipped" as const, revision: null, operationId: null },
    };
    await reserveTeamsTodoCards({ payload, outcome }, s);
    await flushTeamsTodoCards({ payload, activityId: "list", text: "一覧" }, s);
    expect(JSON.stringify(s.writer.update.mock.calls)).toContain("完了: T1");
    expect(JSON.stringify(s.writer.update.mock.calls)).toContain("通知停止");
    await s.store.setNotifications({ scope, actorAadId: actor, now: start, enabled: false });
    const resumePayload = { ...payload, taskName: "resume-card" };
    await reserveTeamsTodoCards({ payload: resumePayload, outcome }, s);
    await flushTeamsTodoCards(
      { payload: resumePayload, activityId: "resume-list", text: "一覧" },
      s,
    );
    expect(JSON.stringify(s.writer.update.mock.calls)).toContain("通知再開");
  });
  it("巨大カードはtoken参照の発行前に全体を拒否する", async () => {
    const s = await setup();
    const put = vi.spyOn(s.store, "putActionRef");
    const payload = { ...scope, taskName: "large-card", userId: actor };
    const outcome = {
      names: {},
      candidates: Array.from({ length: 20 }, () => ({
        candidate: { ...candidate(), text: "作業".repeat(500) },
        match: { candidateIndex: 0, kind: "new" as const, todoIds: [], status: null, changes: {} },
        rejected: null,
      })),
      todos: [],
      changed: 0,
      rejected: [],
      record: { state: "skipped" as const, revision: null, operationId: null },
    };
    await reserveTeamsTodoCards({ payload, outcome }, s);
    await expect(
      flushTeamsTodoCards({ payload, activityId: "list", text: "一覧" }, s),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(put).not.toHaveBeenCalled();
    expect(s.writer.update).not.toHaveBeenCalled();
  });
  it("台帳表示は保存済み表示名と根拠を維持する", async () => {
    const s = await setup();
    const { todo } = await s.store.register({ ...registration(), recordPolicy: "none" });
    const snapshot = renderTeamsRecordSnapshot({
      scope,
      revision: 2,
      todos: [todo],
      previous: {
        scope,
        revision: 1,
        slots: ["分析"],
        todos: [],
        content: { names: { [actor]: "田中" } },
      },
    });
    expect(snapshot.slots.join("\n")).toContain("田中");
    expect(snapshot.slots.join("\n")).toContain(present(todo.evidence[0]).link);
    expect(snapshot.slots.join("\n")).not.toContain(actor);
  });
  it("カードは保存済み返信IDへupdateし、snapshot/effectにはraw tokenを保存しない", async () => {
    const s = await setup();
    const payload = { ...scope, taskName: "synthetic-request", userId: actor };
    const outcome = {
      names: {},
      candidates: [
        {
          candidate: candidate(),
          match: {
            candidateIndex: 0,
            kind: "new" as const,
            todoIds: [],
            status: null,
            changes: {},
          },
          rejected: null,
        },
      ],
      todos: [],
      changed: 0,
      rejected: [],
      record: { state: "skipped" as const, revision: null, operationId: null },
    };
    await reserveTeamsTodoCards({ payload, outcome }, s);
    await flushTeamsTodoCards({ payload, activityId: "saved-reply", text: "候補" }, s);
    expect(s.writer.create).not.toHaveBeenCalled();
    const call = present(s.writer.update.mock.calls[0]);
    expect(call[2]).toBe("saved-reply");
    const card = call[3].card as { body: { actions?: { data: { token: string } }[] }[] };
    const token = present(card.body.flatMap((element) => element.actions ?? [])[0]).data.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(await s.store.getEffect("cards_synthetic-request"))).not.toContain(token);
    await flushTeamsTodoCards({ payload, activityId: "saved-reply", text: "候補" }, s);
    expect(s.writer.update).toHaveBeenCalledOnce();
  });
});
