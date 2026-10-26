import { describe, expect, it } from "vitest";
import { emptyAnalysisState, type TodoItem } from "../../src/store/types.js";
import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";
import { manageTeamsTodos, type TeamsWorkIntent } from "../../src/teams/todos.js";
import type { TeamsConversation, TeamsJobPayload } from "../../src/teams/types.js";

const now = new Date("2026-10-26T03:00:00Z");
const actor = "44444444-4444-4444-8444-444444444444";
const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  channelId: "19:test@thread.tacv2",
  rootMessageId: "100",
};
const ts = "1792972800.000000";
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("必要なテストデータがありません");
  return value;
}
const payload: TeamsJobPayload = {
  ...scope,
  platform: "teams",
  taskName: "request1",
  conversationId: `${scope.channelId};messageid=100`,
  mentionId: "101",
  userId: actor,
  serviceUrl: "https://smba.trafficmanager.net/jp/",
  requestText: "まとめ",
  requestedAt: now.toISOString(),
};
function setup(over: Partial<TodoItem> = {}) {
  const store = createMemoryTeamsWorkStore({ now: () => now });
  const conversation: TeamsConversation = {
    messages: [
      {
        ts,
        threadTs: null,
        userId: actor,
        text: "会議室を予約します",
        edited: false,
        reactions: [],
      },
    ],
    names: new Map([[actor, "田中"]]),
    links: new Map([[ts, "https://teams.microsoft.com/l/message/test/100"]]),
    sourceIds: new Map([[ts, "100"]]),
    sourceRefs: new Map([[ts, { ...scope, kind: "root", messageId: "100" }]]),
  };
  const analysis = {
    state: {
      ...emptyAnalysisState(),
      todos: [
        {
          id: "t1",
          text: "会議室を予約",
          assignee: "p7",
          dueIso: null,
          dueText: null,
          certainty: "explicit" as const,
          evidence: [ts],
          quote: "会議室を予約します",
          closed: false,
          needsReview: false,
          reviewReasons: [],
          ...over,
        },
      ],
    },
    participants: [{ id: "p7", userId: actor, name: "田中" }],
  };
  const run = (
    intent: TeamsWorkIntent = { kind: "summary", suppressTodo: false, suppressCanvas: false },
    p = payload,
  ) => manageTeamsTodos({ payload: p, intent, conversation, analysis }, { store, now: () => now });
  return { store, conversation, analysis, run };
}
describe("Teams ToDo管理", () => {
  it("参加者番号をAADへ戻し期限未定を登録、再分析でも番号と完了を維持", async () => {
    const s = setup();
    const first = await s.run();
    expect(first.changed).toBe(1);
    expect(first.todos[0]).toMatchObject({ displayNo: 1, assigneeAadId: actor });
    expect(first.record.state).toBe("reserved");
    await s.run({ kind: "done", displayNo: 1 });
    present(s.analysis.state.todos[0]).id = "t99";
    const again = await s.run();
    expect(again.changed).toBe(0);
    expect(again.todos).toHaveLength(1);
    expect(again.todos[0]?.status).toBe("done");
    expect(again.record.state).toBe("skipped");
  });
  it.each([
    { assignee: null },
    { assignee: "p404" },
    { needsReview: true },
    { certainty: "implied" as const },
    { certainty: "uncertain" as const },
    { closed: true },
    { quote: "存在しない引用" },
  ])("自動登録条件を1つでも欠く場合は登録しない: %j", async (over) => {
    const s = setup(over);
    expect((await s.run()).todos).toHaveLength(0);
  });
  it("担当者は参加者表だけでなく取得メッセージにも必要", async () => {
    const s = setup();
    present(s.conversation.messages[0]).userId = "55555555-5555-4555-8555-555555555555";
    expect((await s.run()).todos).toHaveLength(0);
  });
  it("担当未定を明示登録できるが編集された根拠は拒否", async () => {
    const s = setup({ assignee: null });
    const list = await s.run({ kind: "todo" });
    const candidate = present(list.candidates[0]).candidate;
    const added = await s.run({ kind: "register", candidate });
    expect(added.todos[0]?.assigneeAadId).toBeNull();
    expect(await s.store.getRecord(scope)).toBeNull();
    present(s.conversation.messages[0]).text = "取り消します";
    expect((await s.run({ kind: "register", candidate })).rejected).toContain("invalid_evidence");
  });
  it("担当/期限変更は確認まで保持、本文変化は関連付けか別件登録を要求", async () => {
    const s = setup();
    const first = await s.run();
    const todo = present(first.todos[0]);
    present(s.analysis.state.todos[0]).dueIso = "2026-10-30";
    const proposed = await s.run();
    expect(proposed.candidates[0]?.match?.kind).toBe("update_proposal");
    expect(proposed.todos[0]?.dueIso).toBeNull();
    await s.run({
      kind: "confirm_update",
      candidate: present(proposed.candidates[0]).candidate,
      todoId: todo.todoId,
      expectedRevision: todo.revision,
    });
    expect((await s.store.getTodos(scope))[0]?.dueIso).toBe("2026-10-30");
    present(s.analysis.state.todos[0]).text = "別の会議室を予約";
    const ambiguous = await s.run();
    expect(ambiguous.candidates[0]?.match?.kind).toBe("ambiguous");
    const current = present(ambiguous.todos[0]);
    await s.run({
      kind: "link",
      candidate: present(ambiguous.candidates[0]).candidate,
      todoId: current.todoId,
      expectedRevision: current.revision,
    });
    expect(await s.store.getTodos(scope)).toHaveLength(1);
    await s.run(
      {
        kind: "register",
        candidate: present(ambiguous.candidates[0]).candidate,
        explicitNew: true,
      },
      { ...payload, taskName: "request2" },
    );
    expect(await s.store.getTodos(scope)).toHaveLength(2);
  });
  it("doneの番号はscope限定、無権限操作で変更しない", async () => {
    const s = setup();
    await s.run();
    expect(
      (
        await s.run(
          { kind: "done", displayNo: 1 },
          { ...payload, userId: "55555555-5555-4555-8555-555555555555" },
        )
      ).rejected,
    ).toContain("unauthorized");
    expect(
      (await s.run({ kind: "done", displayNo: 1 }, { ...payload, rootMessageId: "other" }))
        .rejected,
    ).toContain("not_found");
  });
  it.each([
    { kind: "summary", suppressTodo: true, suppressCanvas: true },
    { kind: "canvas" },
    { kind: "todo" },
    { kind: "findings" },
  ] as TeamsWorkIntent[])("副作用境界 %j", async (intent) => {
    const s = setup();
    const result = await s.run(intent);
    expect(result.todos).toHaveLength(0);
    expect(result.record.state).toBe(intent.kind === "canvas" ? "reserved" : "skipped");
  });
  it("todoとcanvasの抑止は独立、概要だけでは記録しない", async () => {
    const s = setup();
    const result = await s.run({ kind: "summary", suppressTodo: true, suppressCanvas: false });
    expect(result.todos).toHaveLength(0);
    expect(result.record.state).toBe("reserved");
    const second = setup();
    expect(
      (await second.run({ kind: "summary", suppressTodo: false, suppressCanvas: true })).record
        .state,
    ).toBe("skipped");
    expect(await second.store.getRecord(scope)).toBeNull();
    const empty = setup();
    empty.analysis.state.todos = [];
    expect((await empty.run()).record.state).toBe("skipped");
  });
  it("候補消失や抽出上のclosedから既存台帳を変更しない", async () => {
    const s = setup();
    await s.run();
    present(s.analysis.state.todos[0]).closed = true;
    expect((await s.run()).todos[0]?.status).toBe("open");
    s.analysis.state.todos = [];
    expect((await s.run()).todos).toHaveLength(1);
  });
  it("既存記録がある場合もcanvas抑止ではrecord/effectを更新しない", async () => {
    const s = setup();
    await s.run();
    const previous = present(await s.store.getRecord(scope));
    const effect = await s.store.getEffect(previous.operationId);
    present(s.analysis.state.todos[0]).text = "別の作業";
    await s.run({ kind: "summary", suppressTodo: false, suppressCanvas: true });
    expect(await s.store.getRecord(scope)).toEqual(previous);
    expect(await s.store.getEffect(previous.operationId)).toEqual(effect);
  });
});
