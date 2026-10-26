import { describe, expect, it, vi } from "vitest";
import { TeamsApiError } from "../../src/teams/graph.js";
import { createTeamsRemindersJob, selectTeamsReminderTodos } from "../../src/teams/reminders.js";
import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";
import { actor, registration, scope, start } from "../shared/teamsStoreContract.js";

async function setup(count = 1) {
  let clock = start;
  const now = () => clock;
  const store = createMemoryTeamsWorkStore({ now });
  await store.ensureSettings({
    scope,
    actorAadId: actor,
    now: clock,
    reference: {
      serviceUrl: "https://smba.trafficmanager.net/jp/",
      conversationId: scope.channelId,
    },
  });
  for (let i = 0; i < count; i++)
    await store.register({ ...registration(String(i)), recordPolicy: "none" });
  const writer = { create: vi.fn().mockResolvedValue({ activityId: "sent" }) };
  const canSend = vi.fn().mockResolvedValue(true);
  const deps = { store, writer, now, canSend, owner: "worker", maxAttempts: 3 };
  return {
    ...deps,
    run: createTeamsRemindersJob(deps),
    setClock: (d: Date) => {
      clock = d;
    },
  };
}

describe("Teams営業日通知", () => {
  it("次営業日の全日・超過を含み、期限未定は月曜だけ", async () => {
    const s = await setup();
    const [base] = await s.store.getTodos(scope);
    if (!base) throw new Error("todo");
    const todos = ["2026-10-23", "2026-10-27T23:59:59+09:00", "2026-10-28", null].map(
      (dueIso, i) => ({ ...base, todoId: String(i), dueIso }),
    );
    expect(selectTeamsReminderTodos(todos, start).map((t) => t.todoId)).toEqual(["0", "1", "3"]);
    expect(
      selectTeamsReminderTodos(todos, new Date("2026-10-27T00:00:00Z")).map((t) => t.todoId),
    ).toEqual(["0", "1", "2"]);
    expect(selectTeamsReminderTodos(todos, new Date("2026-10-24T00:00:00Z"))).toEqual([]);
    expect(
      selectTeamsReminderTodos(
        todos.map((t) => ({ ...t, status: "done" as const })),
        start,
      ),
    ).toEqual([]);
  });
  it("09時より前・休日には送信せず、元スレッドに表示名だけを送る", async () => {
    const s = await setup();
    s.setClock(new Date("2026-10-25T23:59:59Z"));
    await s.run({}, {});
    expect(s.writer.create).not.toHaveBeenCalled();
    s.setClock(start);
    await s.run({}, {});
    const call = s.writer.create.mock.calls[0];
    expect(call?.[0]).toEqual(scope);
    expect(call?.[2].text).toContain("期限");
    expect(call?.[2].text).toContain("done T1");
    expect(call?.[2].text).toContain("停止");
    expect(JSON.stringify(call)).not.toContain(actor);
    expect(JSON.stringify(call)).not.toContain("<at>");
    await s.run({}, {});
    expect(s.writer.create).toHaveBeenCalledOnce();
  });
  it("同日snapshotは固定し、追加分は翌営業日、成功slotは再送しない", async () => {
    const s = await setup(2);
    s.writer.create
      .mockResolvedValueOnce({ activityId: "first" })
      .mockRejectedValueOnce(new TeamsApiError(503));
    await expect(s.run({}, {})).rejects.toMatchObject({ status: 503 });
    await s.store.register({ ...registration("additional"), recordPolicy: "none" });
    await s.run({}, {});
    expect(s.writer.create).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(s.writer.create.mock.calls)).not.toContain("additional");
    s.setClock(new Date("2026-10-27T00:00:00Z"));
    // 翌営業日に期限対象となる新規ToDo。
    await s.store.register({
      ...registration("tomorrow"),
      now: s.now(),
      candidate: { ...registration("tomorrow").candidate, dueIso: "2026-10-28" },
      recordPolicy: "none",
    });
    await s.run({}, {});
    expect(JSON.stringify(s.writer.create.mock.calls)).toContain("tomorrow");
  });
  it.each(["done", "off", "expired", "allowlist", "due"])(
    "送信直前の%sを除外する",
    async (kind) => {
      const s = await setup(2);
      const extend = s.store.extendEffectLease;
      vi.spyOn(s.store, "extendEffectLease").mockImplementation(async (input) => {
        const result = await extend(input);
        if (kind === "off")
          await s.store.setNotifications({
            scope,
            actorAadId: actor,
            now: s.now(),
            enabled: false,
          });
        if (kind === "expired") s.setClock(new Date(start.getTime() + 91 * 86400000));
        if (kind === "allowlist") s.canSend.mockResolvedValue(false);
        if (kind === "done" || kind === "due")
          for (const todo of await s.store.getTodos(scope)) {
            if (kind === "done")
              await s.store.markDone({
                scope,
                actorAadId: actor,
                now: s.now(),
                todoId: todo.todoId,
                expectedRevision: todo.revision,
                recordPolicy: "none",
              });
            else
              await s.store.confirmUpdate({
                scope,
                actorAadId: actor,
                now: s.now(),
                todoId: todo.todoId,
                expectedRevision: todo.revision,
                candidate: {
                  ...registration().candidate,
                  text: todo.text,
                  evidence: todo.evidence,
                  dueIso: "2027-01-01",
                },
                recordPolicy: "none",
              });
          }
        return result;
      });
      await s.run({}, {});
      expect(s.writer.create).not.toHaveBeenCalled();
    },
  );
  it.each([401, 403, 404])("%iでは通知を停止しDMへ迂回しない", async (status) => {
    const s = await setup();
    s.writer.create.mockRejectedValue(new TeamsApiError(status));
    await s.run({}, {});
    expect(await s.store.getSettings(scope)).toMatchObject({
      notificationsEnabled: false,
      disabled: status === 404,
    });
    await s.run({}, {});
    expect(s.writer.create).toHaveBeenCalledOnce();
    if (status !== 404) {
      await s.store.setNotifications({ scope, actorAadId: actor, now: s.now(), enabled: true });
      s.writer.create.mockResolvedValue({ activityId: "resumed" });
      await s.run({}, {});
      expect(s.writer.create).toHaveBeenCalledTimes(2);
    }
  });
  it("429のRetry-Afterを保持し、5xxは上限で止める", async () => {
    const s = await setup();
    s.writer.create.mockRejectedValue(new TeamsApiError(429, 120000));
    await expect(s.run({}, {})).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
    await expect(s.run({}, {})).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
    expect(s.writer.create).toHaveBeenCalledOnce();
    s.setClock(new Date(start.getTime() + 120000));
    s.writer.create.mockRejectedValue(new TeamsApiError(503));
    await expect(s.run({}, {})).rejects.toMatchObject({ status: 503 });
    await expect(s.run({}, {})).rejects.toMatchObject({ status: 503 });
    await s.run({}, {});
    expect(s.writer.create).toHaveBeenCalledTimes(3);
  });
  it("非retryableな400はfailed保持で止め、別スレッドの通知を継続する", async () => {
    const s = await setup();
    const otherScope = { ...scope, rootMessageId: "other-root" };
    await s.store.ensureSettings({
      scope: otherScope,
      actorAadId: actor,
      now: start,
      reference: {
        serviceUrl: "https://smba.trafficmanager.net/jp/",
        conversationId: scope.channelId,
      },
    });
    await s.store.register({ ...registration("other", otherScope), recordPolicy: "none" });
    s.writer.create.mockRejectedValueOnce(new TeamsApiError(400));
    await s.run({}, {});
    await s.run({}, {});
    expect(s.writer.create).toHaveBeenCalledTimes(2);
    expect(s.writer.create.mock.calls[1]?.[0]).toEqual(otherScope);
  });
  it("同日変更は固定本文を置換せず、表示名を保存する", async () => {
    const s = await setup();
    const todos = await s.store.getTodos(scope);
    await s.store.reserveRecord({
      scope,
      actorAadId: actor,
      now: start,
      expectedRevision: 0,
      snapshot: { scope, revision: 1, slots: [], todos, content: { names: { [actor]: "田中" } } },
    });
    s.writer.create.mockRejectedValueOnce(new TeamsApiError(503));
    await expect(s.run({}, {})).rejects.toMatchObject({ status: 503 });
    const todo = todos[0];
    if (!todo) throw new Error("todo");
    await s.store.confirmUpdate({
      scope,
      actorAadId: actor,
      now: start,
      todoId: todo.todoId,
      expectedRevision: todo.revision,
      candidate: {
        ...registration().candidate,
        text: todo.text,
        evidence: todo.evidence,
        dueIso: "2026-10-27",
      },
      recordPolicy: "none",
    });
    await s.run({}, {});
    const text = s.writer.create.mock.calls[1]?.[2].text;
    expect(text).toContain("田中");
    expect(text).toContain("作業 0");
    expect(text).not.toContain("2026-10-27");
    expect(text).not.toContain(actor);
  });
});
