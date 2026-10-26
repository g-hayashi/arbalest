import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchTeamsAction,
  executeTeamsAction,
  issueTeamsAction,
  type TeamsActionPayload,
} from "../../src/teams/actions.js";
import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";
import type { TeamsActionRefInput } from "../../src/teams/store/types.js";
import type { TeamsConversation } from "../../src/teams/types.js";
import { actor, at, candidate, scope, start } from "../shared/teamsStoreContract.js";

const appId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const target = { ...scope, rootMessageId: "1700000000000" };
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("合成データがありません");
  return value;
}
function activity(token: string) {
  return {
    type: "invoke",
    name: "adaptiveCard/action",
    id: "invoke-1",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/jp/",
    from: { id: "29:actor", aadObjectId: actor },
    recipient: { id: `28:${appId}` },
    conversation: {
      id: `${target.channelId};messageid=${target.rootMessageId}`,
      conversationType: "channel",
    },
    replyToId: "card-1",
    channelData: {
      tenant: { id: target.tenantId },
      team: { aadGroupId: target.teamId },
      channel: { id: target.channelId },
    },
    value: { action: { type: "Action.Execute", verb: "untrusted-verb", data: { token } } },
  };
}
async function setup(action: TeamsActionRefInput["action"] = "done") {
  let clock = start;
  const store = createMemoryTeamsWorkStore({ now: () => clock });
  const c = candidate("a", target);
  const { todo } = await store.register({
    scope: target,
    actorAadId: actor,
    now: start,
    requestId: "initial",
    mode: "new",
    candidate: c,
  });
  const ts = `${start.getTime() / 1000}.000000`;
  const conversation: TeamsConversation = {
    messages: [
      {
        ts,
        threadTs: null,
        userId: actor,
        text: present(c.evidence[0]).quote,
        edited: false,
        reactions: [],
      },
    ],
    names: new Map([[actor, "担当者"]]),
    links: new Map([[ts, present(c.evidence[0]).link]]),
    sourceIds: new Map(),
    sourceRefs: new Map([[ts, present(c.evidence[0]).ref]]),
  };
  const graph = { getThread: vi.fn().mockResolvedValue(conversation), getChannel: vi.fn() };
  const deps = {
    store,
    graph,
    appId,
    tenantId: target.tenantId,
    allowedTeamIds: new Set([target.teamId]),
    now: () => clock,
    enqueue: vi.fn().mockResolvedValue({ created: true }),
  };
  const input = {
    scope: target,
    actorAadId: actor,
    now: start,
    sourceActivityId: "card-1",
    action,
    todoId: todo.todoId,
    expectedRevision: 1,
    expireAt: at(50),
    ...(action === "register" || action === "link" || action === "confirm_update"
      ? { candidate: c }
      : {}),
  };
  const data = await issueTeamsAction(input, deps);
  async function payload(): Promise<TeamsActionPayload> {
    await dispatchTeamsAction(activity(data.token), deps);
    return present(deps.enqueue.mock.calls.at(-1))[0].payload;
  }
  return {
    deps,
    data,
    input,
    todo,
    c,
    conversation,
    payload,
    setClock: (value: Date) => {
      clock = value;
    },
  };
}

describe("Teams Action.Execute", () => {
  it("暗号学的tokenだけをカードに返し、hashだけ保存・queueへ送る", async () => {
    const s = await setup();
    const second = await issueTeamsAction(s.input, s.deps);
    expect(Object.keys(s.data)).toEqual(["token"]);
    expect(s.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(s.data.token);
    const hash = createHash("sha256").update(s.data.token).digest("hex");
    const ref = await s.deps.store.getActionRef(hash);
    expect(ref?.expireAt).toEqual(at(7));
    expect(JSON.stringify(ref)).not.toContain(s.data.token);
    const response = await dispatchTeamsAction(activity(s.data.token), s.deps);
    expect(response).toEqual({
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: "操作を受け付けました。",
    });
    const p = present(s.deps.enqueue.mock.calls[0])[0].payload;
    expect(p.scope).toEqual(target);
    expect(p.sourceActivityId).toBe("card-1");
    expect(p.tokenHash).toBe(hash);
    expect(JSON.stringify(p)).not.toContain(s.data.token);
    expect(present(s.deps.enqueue.mock.calls[0])[0].path).toBe("/jobs/teams-action");
  });

  it("台帳期限が7日より早ければ期限を切り詰める", async () => {
    const s = await setup();
    s.setClock(at(89));
    const data = await issueTeamsAction({ ...s.input, now: at(89), expireAt: at(120) }, s.deps);
    expect(
      (await s.deps.store.getActionRef(createHash("sha256").update(data.token).digest("hex")))
        ?.expireAt,
    ).toEqual(at(90));
  });

  it.each([
    "tenant",
    "team",
    "channel",
    "root",
    "missing-root",
    "card",
    "actor",
    "recipient",
    "service",
    "extra-data",
    "token",
    "missing-aad",
  ])("%s改変/転送を非公開invoke内で拒否", async (field) => {
    const s = await setup();
    const a = activity(s.data.token);
    if (field === "tenant") a.channelData.tenant.id = other;
    if (field === "team") a.channelData.team.aadGroupId = other;
    if (field === "channel") a.channelData.channel.id = "19:else@thread.tacv2";
    if (field === "root") a.conversation.id = `${target.channelId};messageid=999`;
    if (field === "missing-root") a.conversation.id = target.channelId;
    if (field === "card") a.replyToId = "forwarded-card";
    if (field === "actor") a.from.aadObjectId = other;
    if (field === "recipient") a.recipient.id = `28:${other}`;
    if (field === "service") a.serviceUrl = "https://evil.test/";
    if (field === "extra-data") Object.assign(a.value.action.data, { todoId: "injected" });
    if (field === "token") a.value.action.data.token = "unknown";
    if (field === "missing-aad") a.from.aadObjectId = "";
    const r = await dispatchTeamsAction(a, s.deps);
    expect(r.type).toBe("application/vnd.microsoft.activity.message");
    expect(r.value).not.toBe("操作を受け付けました。");
    expect(s.deps.enqueue).not.toHaveBeenCalled();
  });

  it("キュー投入失敗は受付成功にしない", async () => {
    const s = await setup();
    s.deps.enqueue.mockRejectedValue(new Error("private-token"));
    const r = await dispatchTeamsAction(activity(s.data.token), s.deps);
    expect(r.value).toContain("再操作");
    expect(r.value).not.toContain("private-token");
  });

  it("7日期限の境界を受付とworkerで拒否", async () => {
    const s = await setup();
    const p = await s.payload();
    s.setClock(at(7));
    s.deps.enqueue.mockClear();
    expect((await dispatchTeamsAction(activity(s.data.token), s.deps)).value).toContain("再取得");
    expect(s.deps.enqueue).not.toHaveBeenCalled();
    await expect(executeTeamsAction(p, s.deps)).rejects.toMatchObject({ code: "expired" });
  });

  it("別イベントの同時完了はchanged=trueが1回、正当な再操作はfalse", async () => {
    const s = await setup();
    const first = await s.payload();
    const a = activity(s.data.token);
    a.id = "invoke-2";
    await dispatchTeamsAction(a, s.deps);
    const second = present(s.deps.enqueue.mock.calls.at(-1))[0].payload;
    expect(first.taskName).not.toBe(second.taskName);
    const results = await Promise.all([
      executeTeamsAction(first, s.deps),
      executeTeamsAction(second, s.deps),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await executeTeamsAction(first, s.deps)).toEqual({ changed: false });
    expect((await s.deps.store.getTodos(target))[0]?.status).toBe("done");
  });

  it.each(["scope", "actor", "card", "task"])("workerは%sのpayload改変を拒否", async (field) => {
    const s = await setup();
    const p = await s.payload();
    if (field === "scope") p.scope = { ...p.scope, rootMessageId: "999" };
    if (field === "actor") p.actorAadId = other;
    if (field === "card") p.sourceActivityId = "forwarded";
    if (field === "task") p.taskName = "invalid";
    await expect(executeTeamsAction(p, s.deps)).rejects.toBeDefined();
    expect((await s.deps.store.getTodos(target))[0]?.status).toBe("open");
  });

  it("受付後の担当者変更をworkerで再検査（完了済みでも無権限拒否）", async () => {
    const s = await setup();
    // 登録者とは別の担当者の操作。
    await s.deps.store.confirmUpdate({
      scope: target,
      actorAadId: actor,
      now: start,
      todoId: s.todo.todoId,
      expectedRevision: 1,
      candidate: { ...s.c, assigneeAadId: other },
    });
    const data = await issueTeamsAction({ ...s.input, expectedRevision: 2 }, s.deps);
    const a = activity(data.token);
    a.from.aadObjectId = other;
    await dispatchTeamsAction(a, s.deps);
    const p = present(s.deps.enqueue.mock.calls.at(-1))[0].payload;
    await s.deps.store.confirmUpdate({
      scope: target,
      actorAadId: actor,
      now: start,
      todoId: s.todo.todoId,
      expectedRevision: 2,
      candidate: s.c,
    });
    await expect(executeTeamsAction(p, s.deps)).rejects.toMatchObject({ code: "unauthorized" });
    await s.deps.store.markDone({
      scope: target,
      actorAadId: actor,
      now: start,
      todoId: s.todo.todoId,
      expectedRevision: 3,
    });
    await expect(executeTeamsAction(p, s.deps)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("旧revisionを受付とworkerで拒否し再一覧へ案内", async () => {
    const s = await setup("confirm_update");
    const p = await s.payload();
    await s.deps.store.confirmUpdate({
      scope: target,
      actorAadId: actor,
      now: start,
      todoId: s.todo.todoId,
      expectedRevision: 1,
      candidate: { ...s.c, dueIso: "2026-10-30" },
    });
    await expect(executeTeamsAction(p, s.deps)).rejects.toMatchObject({ code: "stale_revision" });
    expect((await dispatchTeamsAction(activity(s.data.token), s.deps)).value).toContain("再取得");
  });

  it.each(["quote", "ref", "assignee", "date"])(
    "候補の%sをworkerのGraph再取得で再検証",
    async (field) => {
      const s = await setup("register");
      const p = await s.payload();
      if (field === "quote") present(s.conversation.messages[0]).text = "編集後";
      if (field === "ref")
        s.conversation.sourceRefs.set(present(s.conversation.messages[0]).ts, {
          ...present(s.c.evidence[0]).ref,
          messageId: "different",
        });
      if (field === "assignee") {
        present(s.conversation.messages[0]).userId = other;
        s.conversation.names.clear();
      }
      if (field === "date") {
        const ts = present(s.conversation.messages[0]).ts;
        present(s.conversation.messages[0]).ts = "1.000000";
        s.conversation.sourceRefs = new Map([
          ["1.000000", present(s.conversation.sourceRefs.get(ts))],
        ]);
        s.conversation.links = new Map([["1.000000", present(s.conversation.links.get(ts))]]);
      }
      await expect(executeTeamsAction(p, s.deps)).rejects.toMatchObject({
        code: "invalid_evidence",
      });
    },
  );

  it("別イベントの別件登録二重クリックもtoken単位で1回だけ登録", async () => {
    const s = await setup("register");
    const data = await issueTeamsAction(
      { ...s.input, candidate: { ...s.c, text: "同じ根拠の別作業" }, explicitNew: true },
      s.deps,
    );
    const first = activity(data.token);
    await dispatchTeamsAction(first, s.deps);
    first.id = "invoke-second";
    await dispatchTeamsAction(first, s.deps);
    const results = await Promise.all(
      s.deps.enqueue.mock.calls.map((call) => executeTeamsAction(call[0].payload, s.deps)),
    );
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(await s.deps.store.getTodos(target)).toHaveLength(2);
  });

  it.each(["register", "link", "confirm_update"] as const)(
    "正当な%sを保存候補だけから適用",
    async (action) => {
      const s = await setup(action);
      const data = await issueTeamsAction(
        {
          ...s.input,
          candidate: { ...s.c, ...(action === "confirm_update" ? { dueIso: "2026-10-30" } : {}) },
        },
        s.deps,
      );
      await dispatchTeamsAction(activity(data.token), s.deps);
      const result = await executeTeamsAction(
        present(s.deps.enqueue.mock.calls.at(-1))[0].payload,
        s.deps,
      );
      expect(result.changed).toBe(action === "confirm_update");
      expect(s.deps.graph.getThread).toHaveBeenCalledWith(
        target.teamId,
        target.channelId,
        target.rootMessageId,
      );
    },
  );

  it("Graph取得中に期限が切れた操作を適用しない", async () => {
    const s = await setup("register");
    const p = await s.payload();
    s.deps.graph.getThread.mockImplementation(async () => {
      s.setClock(at(7));
      return s.conversation;
    });
    await expect(executeTeamsAction(p, s.deps)).rejects.toMatchObject({ code: "expired" });
  });

  it("通知はmanagerだけを許し、現在の無効状態をworkerで再検査", async () => {
    const s = await setup("notifications_off");
    const a = activity(s.data.token);
    a.from.aadObjectId = other;
    expect((await dispatchTeamsAction(a, s.deps)).value).not.toBe("操作を受け付けました。");
    const p = await s.payload();
    expect(await executeTeamsAction(p, s.deps)).toEqual({ changed: true });
    expect(await executeTeamsAction(p, s.deps)).toEqual({ changed: false });
    await s.deps.store.disableThread({ scope: target, now: start });
    // storeは無効スレッドの参照を返さない。
    await expect(executeTeamsAction(p, s.deps)).rejects.toMatchObject({ code: "expired" });
  });
});
