import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../src/store/memory/index.js";
import type {
  TeamsScope,
  TeamsTodoCandidate,
  TeamsWorkStore,
} from "../../src/teams/store/types.js";

export const scope: TeamsScope = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  channelId: "19:Channel@thread.tacv2",
  rootMessageId: "Root",
};
export const actor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const start = new Date("2026-10-26T00:00:00Z");
const day = 86_400_000;
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value");
  return value;
}
export const at = (days: number) => new Date(start.getTime() + days * day);
export function candidate(id = "a", target = scope): TeamsTodoCandidate {
  return {
    text: `作業 ${id}`,
    evidence: [
      {
        ref: { ...target, kind: "reply", messageId: id },
        quote: `作業 ${id}`,
        link: "https://teams.microsoft.com/l/message/channel/message",
        sourceCreatedAt: start.toISOString(),
      },
    ],
    assigneeAadId: actor,
    dueIso: null,
    dueText: null,
    certainty: "explicit",
    needsReview: false,
    closed: false,
  };
}
export function registration(id = "a", target = scope) {
  return {
    scope: target,
    actorAadId: actor,
    now: start,
    requestId: id,
    mode: "new" as const,
    candidate: candidate(id, target),
  };
}
export function teamsStoreContract(name: string, factory: (now: () => Date) => TeamsWorkStore) {
  describe(name, () => {
    it("自動通知停止は保持期限と最終人操作時刻を延長しない", async () => {
      let clock = start;
      const store = factory(() => clock);
      const before = await store.ensureSettings({ scope, actorAadId: actor, now: clock });
      clock = at(1);
      await store.stopNotifications({ scope, now: clock });
      expect(await store.getSettings(scope)).toMatchObject({
        notificationsEnabled: false,
        expireAt: before.expireAt,
        lastHumanUpdatedAt: before.lastHumanUpdatedAt,
      });
    });
    it("記録抑止と既存限定は新規effectを作らず、既存限定の完了は既存記録だけ更新", async () => {
      const store = factory(() => start);
      await store.register({ ...registration("a"), recordPolicy: "none" });
      await store.register({ ...registration("b"), recordPolicy: "existing_only" });
      expect(await store.getRecord(scope)).toBeNull();
      await store.register(registration("c"));
      const previous = present(await store.getRecord(scope));
      const first = present((await store.getTodos(scope))[0]);
      await store.markDone({
        scope,
        actorAadId: actor,
        now: start,
        todoId: first.todoId,
        expectedRevision: first.revision,
        recordPolicy: "none",
      });
      expect(await store.getRecord(scope)).toEqual(previous);
      const second = present((await store.getTodos(scope)).find((todo) => todo.status === "open"));
      await store.markDone({
        scope,
        actorAadId: actor,
        now: start,
        todoId: second.todoId,
        expectedRevision: second.revision,
        recordPolicy: "existing_only",
      });
      const record = present(await store.getRecord(scope));
      expect(record.desiredRevision).toBe(previous.desiredRevision + 1);
      expect(
        (await store.getEffect(record.operationId))?.snapshot.todos.filter(
          (todo) => todo.status === "done",
        ),
      ).toHaveLength(2);
    });
    it("採番・要求/anchor冪等性・二重完了の不変条件（生成入力と同時実行）", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (count) => {
          const store = factory(() => start);
          const results = await Promise.all(
            Array.from({ length: count * 2 }, (_, i) =>
              store.register(registration(String(i % count))),
            ),
          );
          expect(results.filter((r) => r.changed)).toHaveLength(count);
          const todos = await store.getTodos(scope);
          expect(todos.map((t) => t.displayNo).sort((a, b) => a - b)).toEqual(
            Array.from({ length: count }, (_, i) => i + 1),
          );
          const first = todos[0];
          if (!first) throw new Error("missing");
          const done = await Promise.all(
            Array.from({ length: 8 }, () =>
              store.markDone({
                scope,
                actorAadId: actor,
                now: start,
                todoId: first.todoId,
                expectedRevision: 1,
              }),
            ),
          );
          expect(done.filter((r) => r.changed)).toHaveLength(1);
          const record = await store.getRecord(scope);
          expect(record?.desiredRevision).toBe(count + 1);
          expect(record?.snapshot.todos.find((t) => t.todoId === first.todoId)?.status).toBe(
            "done",
          );
          const effect = await store.getEffect(record?.operationId ?? "");
          expect(effect?.snapshot).toEqual(record?.snapshot);
        }),
        { numRuns: 12 },
      );
    });

    it("別要求でもanchorを再利用し、入力と出力の参照を隔離する", async () => {
      const store = factory(() => start);
      const input = registration();
      const first = await store.register(input);
      input.candidate.text = "破壊";
      first.todo.text = "破壊";
      const again = await store.register({ ...registration(), requestId: "retry" });
      expect(again.changed).toBe(false);
      expect(again.todo.text).toBe("作業 a");
      present(again.todo.evidence[0]).quote = "破壊";
      expect((await store.getTodos(scope))[0]?.evidence[0]?.quote).toBe("作業 a");
      expect((await store.getSettings(scope))?.nextDisplayNo).toBe(2);
    });

    it("同じ要求IDを別候補へ使い回せない", async () => {
      const store = factory(() => start);
      await store.register(registration());
      await expect(store.register({ ...registration("b"), requestId: "a" })).rejects.toMatchObject({
        code: "conflict",
      });
      expect(await store.getTodos(scope)).toHaveLength(1);
    });

    it("scopeの全要素を隔離しUUIDだけを正規化する", async () => {
      const store = factory(() => start);
      await store.register(registration());
      expect(
        await store.getTodos({ ...scope, tenantId: scope.tenantId.toUpperCase() }),
      ).toHaveLength(1);
      for (const field of ["tenantId", "teamId", "channelId", "rootMessageId"] as const) {
        const foreign = {
          ...scope,
          [field]:
            field.endsWith("Id") && (field === "tenantId" || field === "teamId")
              ? other
              : `${scope[field]}OTHER`,
        };
        expect(await store.getTodos(foreign)).toEqual([]);
        await expect(
          store.register({ ...registration("b", foreign), candidate: candidate() }),
        ).rejects.toMatchObject({ code: "invalid_scope" });
      }
      expect(await store.getTodos({ ...scope, channelId: scope.channelId.toLowerCase() })).toEqual(
        [],
      );
    });

    it("曖昧候補/担当期限の差は自動登録せず、明示別件だけ追加する", async () => {
      const store = factory(() => start);
      await store.register(registration());
      const changed = {
        ...registration(),
        requestId: "different",
        candidate: { ...candidate(), text: "別作業" },
      };
      await expect(store.register({ ...changed, automatic: true })).rejects.toMatchObject({
        code: "ambiguous",
      });
      await expect(store.register(changed)).rejects.toMatchObject({ code: "ambiguous" });
      expect((await store.register({ ...changed, explicitNew: true })).changed).toBe(true);
      await expect(store.register({ ...registration(), requestId: "again" })).rejects.toMatchObject(
        { code: "ambiguous" },
      );
    });

    it("完了済みでも無権限を拒否し、旧revisionの更新を拒否する", async () => {
      const store = factory(() => start);
      const { todo } = await store.register(registration());
      await expect(
        store.markDone({
          scope,
          actorAadId: other,
          now: start,
          todoId: todo.todoId,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await store.markDone({
        scope,
        actorAadId: actor,
        now: start,
        displayNo: 1,
        expectedRevision: 1,
      });
      await expect(
        store.markDone({
          scope,
          actorAadId: other,
          now: start,
          todoId: todo.todoId,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        store.confirmUpdate({
          scope,
          actorAadId: actor,
          now: start,
          todoId: todo.todoId,
          expectedRevision: 1,
          candidate: candidate(),
        }),
      ).rejects.toMatchObject({ code: "stale_revision" });
    });

    it("担当者と登録者だけが更新し、関連付けの根拠をanchorと一緒に保持する", async () => {
      const store = factory(() => start);
      const { todo } = await store.register(registration());
      const update = {
        scope,
        actorAadId: actor,
        now: at(1),
        todoId: todo.todoId,
        expectedRevision: 1,
        candidate: { ...candidate(), assigneeAadId: other, dueIso: "2026-10-30" },
      };
      const updated = await store.confirmUpdate(update);
      expect(updated.todo.revision).toBe(2);
      expect(updated.todo.expireAt).toEqual(at(91));
      const linked = await store.register({
        ...registration("b"),
        now: at(2),
        actorAadId: other,
        mode: "link",
        todoId: todo.todoId,
        expectedRevision: 2,
      });
      expect(linked.todo.evidence).toHaveLength(2);
      expect(linked.todo.text).toBe(todo.text);
      expect(linked.todo.assigneeAadId).toBe(other);
      expect(
        (
          await store.register({
            ...registration("b"),
            now: at(2),
            actorAadId: other,
            mode: "link",
            todoId: todo.todoId,
            expectedRevision: 2,
          })
        ).changed,
      ).toBe(false);
      expect(
        (
          await store.markDone({
            scope,
            actorAadId: actor,
            now: at(2),
            todoId: todo.todoId,
            expectedRevision: 3,
          })
        ).changed,
      ).toBe(true);
    });

    it("保持90日境界で拒否し、自動再分析/リトライで期限を延長しない", async () => {
      let clock = start;
      const store = factory(() => clock);
      const { todo } = await store.register(registration());
      clock = at(89);
      const again = await store.register({ ...registration(), now: clock, automatic: true });
      expect(again.todo.expireAt).toEqual(at(90));
      clock = at(90);
      expect(await store.getTodos(scope)).toEqual([]);
      expect(await store.getSettings(scope)).toBeNull();
      expect(await store.getRecord(scope)).toBeNull();
      await expect(
        store.markDone({
          scope,
          actorAadId: actor,
          now: clock,
          todoId: todo.todoId,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "expired" });
      await expect(
        store.register({ ...registration("old"), now: clock, automatic: true }),
      ).rejects.toMatchObject({ code: "expired" });
    });

    it("自動新規登録は検証済みの明示未完了候補のみ", async () => {
      const store = factory(() => start);
      for (const patch of [
        { assigneeAadId: null },
        { closed: true },
        { needsReview: true },
        { certainty: "implied" as const },
      ]) {
        await expect(
          store.register({
            ...registration(),
            automatic: true,
            candidate: { ...candidate(), ...patch },
          }),
        ).rejects.toMatchObject({ code: "invalid_evidence" });
      }
      expect(await store.getTodos(scope)).toEqual([]);
    });

    it("managerを初回だけ固定し認証済みreferenceを更新、別scopeへ波及しない", async () => {
      const store = factory(() => start);
      await store.ensureSettings({
        scope,
        actorAadId: actor,
        now: start,
        reference: {
          serviceUrl: "https://smba.trafficmanager.net/region/",
          conversationId: scope.channelId,
        },
      });
      const result = await store.ensureSettings({
        scope,
        actorAadId: other,
        now: at(1),
        reference: {
          serviceUrl: "https://smba.trafficmanager.net/region/",
          conversationId: `${scope.channelId};messageid=${scope.rootMessageId}`,
        },
      });
      expect(result.managerAadId).toBe(actor);
      expect(result.conversationId).toBe(`${scope.channelId};messageid=${scope.rootMessageId}`);
      expect(result.expireAt).toEqual(at(90));
      await expect(
        store.setNotifications({ scope, actorAadId: other, now: start, enabled: false }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(
        (await store.setNotifications({ scope, actorAadId: actor, now: start, enabled: false }))
          .notificationsEnabled,
      ).toBe(false);
      expect(await store.getSettings({ ...scope, rootMessageId: "other" })).toBeNull();
      await store.disableThread({ scope, now: start });
      await expect(store.register(registration())).rejects.toMatchObject({ code: "disabled" });
    });

    it("日次予約はsnapshotを差し替えず、送信前の無効化を検査する", async () => {
      const store = factory(() => start);
      await store.register(registration());
      const record = await store.getRecord(scope);
      if (!record) throw new Error("missing");
      const input = {
        operationId: "daily",
        scope,
        kind: "reminder" as const,
        revision: record.desiredRevision,
        snapshot: record.snapshot,
        expireAt: at(90),
        now: start,
      };
      const first = await store.reserveEffect(input);
      await store.register(registration("b"));
      const latest = present(await store.getRecord(scope));
      const second = await store.reserveEffect({
        ...input,
        snapshot: latest.snapshot,
        revision: latest.desiredRevision,
      });
      expect(second.created).toBe(false);
      expect(second.effect.snapshot).toEqual(first.effect.snapshot);
      expect(await store.claimEffect("daily", "worker", start)).not.toBeNull();
      await store.setNotifications({ scope, actorAadId: actor, now: start, enabled: false });
      expect(await store.claimEffect("daily", "other", at(1))).toBeNull();
    });

    it("通知Retry-Afterの保存と再読込で待機中claimを拒否し試行回数を増やさない", async () => {
      let clock = start;
      const store = factory(() => clock);
      await store.register(registration());
      const record = present(await store.getRecord(scope));
      await store.reserveEffect({
        operationId: "retry-after",
        scope,
        kind: "reminder",
        revision: record.desiredRevision,
        snapshot: record.snapshot,
        expireAt: at(90),
        now: clock,
      });
      const lease = present(await store.claimEffect("retry-after", "worker", clock));
      const nextAttemptAt = new Date(start.getTime() + 120000);
      await store.saveEffect({
        scope,
        operationId: lease.operationId,
        owner: lease.leaseOwner,
        fencingToken: lease.fencingToken,
        now: clock,
        state: "failed",
        nextAttemptAt,
      });
      expect((await store.getEffect(lease.operationId))?.nextAttemptAt).toEqual(nextAttemptAt);
      expect(await store.claimEffect(lease.operationId, "worker", clock)).toBeNull();
      expect((await store.getEffect(lease.operationId))?.attempts).toBe(1);
      clock = nextAttemptAt;
      expect(await store.claimEffect(lease.operationId, "worker", clock)).toMatchObject({
        attempts: 2,
      });
    });

    it("所有者/fencing/期限/最新revisionで旧worker保存を拒否し延長可能", async () => {
      const store = factory(() => start);
      await store.register(registration());
      const record = present(await store.getRecord(scope));
      const lease = present(await store.claimEffect(record.operationId, "a", start));
      expect(await store.claimEffect(record.operationId, "b", start)).toBeNull();
      await expect(
        store.saveEffect({
          scope,
          operationId: record.operationId,
          owner: "b",
          fencingToken: lease.fencingToken,
          now: start,
          state: "applied",
        }),
      ).rejects.toMatchObject({ code: "lease_lost" });
      const renewed = await store.extendEffectLease({
        scope,
        operationId: record.operationId,
        owner: "a",
        fencingToken: lease.fencingToken,
        now: new Date(start.getTime() + 1000),
      });
      expect(renewed.leaseUntil.getTime()).toBeGreaterThan(lease.leaseUntil.getTime());
      await expect(
        store.saveEffect({
          scope,
          operationId: record.operationId,
          owner: "a",
          fencingToken: lease.fencingToken,
          now: renewed.leaseUntil,
          state: "applied",
        }),
      ).rejects.toMatchObject({ code: "lease_lost" });
      const next = present(await store.claimEffect(record.operationId, "b", renewed.leaseUntil));
      expect(next.fencingToken).toBeGreaterThan(lease.fencingToken);
      await expect(
        store.saveEffect({
          scope,
          operationId: record.operationId,
          owner: "a",
          fencingToken: lease.fencingToken,
          now: renewed.leaseUntil,
          state: "applied",
        }),
      ).rejects.toMatchObject({ code: "lease_lost" });
      await store.register(registration("b"));
      await expect(
        store.saveEffect({
          scope,
          operationId: record.operationId,
          owner: "b",
          fencingToken: next.fencingToken,
          now: renewed.leaseUntil,
          state: "applied",
        }),
      ).rejects.toMatchObject({ code: "superseded" });
    });

    it("snapshot/slot超過は採番も含めrollbackする", async () => {
      const store = factory(() => start);
      await expect(
        store.register({
          ...registration(),
          candidate: { ...candidate(), text: "あ".repeat(100_000) },
        }),
      ).rejects.toMatchObject({ code: "snapshot_too_large" });
      expect(await store.getTodos(scope)).toEqual([]);
      expect((await store.register(registration())).todo.displayNo).toBe(1);
      const record = present(await store.getRecord(scope));
      await expect(
        store.reserveEffect({
          scope,
          now: start,
          operationId: "large",
          kind: "reply",
          revision: 1,
          expireAt: at(90),
          snapshot: { ...record.snapshot, slots: ["x".repeat(8001)] },
        }),
      ).rejects.toMatchObject({ code: "too_large" });
    });

    it("record進捗保存は保持期限・snapshotを変えずリースを要求する", async () => {
      const store = factory(() => start);
      await store.register(registration());
      const record = present(await store.getRecord(scope));
      const lease = present(await store.claimEffect(record.operationId, "a", start));
      await store.saveRecord({
        scope,
        now: start,
        operationId: record.operationId,
        owner: "a",
        fencingToken: lease.fencingToken,
        revision: 1,
        snapshot: record.snapshot,
        progress: { teams: "applied" },
      });
      expect((await store.getRecord(scope))?.expireAt).toEqual(at(90));
      expect((await store.getRecord(scope))?.progress.teams).toBe("applied");
      await expect(
        store.saveRecord({
          scope,
          now: start,
          operationId: record.operationId,
          owner: "a",
          fencingToken: lease.fencingToken,
          revision: 1,
          snapshot: { ...record.snapshot, slots: ["差替え"] },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await store.listRecords()).toHaveLength(1);
      expect(await store.listSettings()).toHaveLength(1);
    });

    it("返信先の認証済みURL/スレッド境界を保存時にも検査する", async () => {
      const store = factory(() => start);
      const input = { scope, actorAadId: actor, now: start };
      await expect(
        store.ensureSettings({
          ...input,
          reference: {
            serviceUrl: "https://evil.example/region/",
            conversationId: scope.channelId,
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_scope" });
      await expect(
        store.ensureSettings({
          ...input,
          reference: {
            serviceUrl: "https://smba.trafficmanager.net/region/",
            conversationId: `${scope.channelId};messageid=other`,
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_scope" });
      expect(await store.getSettings(scope)).toBeNull();
    });

    it("過去payloadのnowで期限を回避せず、古い新規根拠を拒否する", async () => {
      let clock = start;
      const store = factory(() => clock);
      await store.register(registration());
      clock = at(90);
      await expect(store.register(registration())).rejects.toMatchObject({ code: "expired" });
      const fresh = { ...scope, rootMessageId: "new-thread" };
      await expect(
        store.register({ ...registration("b", fresh), now: clock, automatic: true }),
      ).rejects.toMatchObject({ code: "expired" });
      expect(await store.getSettings(fresh)).toBeNull();
    });

    it("Teams登録はSlack検索/リマインドへ混入しない", async () => {
      const store = factory(() => start);
      const slack = createMemoryStore({ now: () => start });
      await store.register({
        ...registration(),
        candidate: { ...candidate(), dueIso: "2026-10-26" },
      });
      expect(await slack.todos.findByMessageTs(scope.channelId, "a")).toEqual([]);
      expect(await slack.todos.findDueForReminder(start)).toEqual([]);
    });

    it("creatingのリース失効は自動再作成せずdelivery_unknownへ移す", async () => {
      const store = factory(() => start);
      await store.register(registration());
      const previous = present(await store.getRecord(scope));
      const record = await store.reserveRecord({
        scope,
        actorAadId: actor,
        now: start,
        expectedRevision: 1,
        snapshot: { ...previous.snapshot, revision: 2, slots: ["表示"] },
      });
      const lease = present(await store.claimEffect(record.operationId, "worker", start));
      await store.saveRecord({
        scope,
        now: start,
        operationId: record.operationId,
        owner: "worker",
        fencingToken: lease.fencingToken,
        revision: 2,
        snapshot: record.snapshot,
        slots: record.slots.map((slot) => ({ ...slot, state: "creating" })),
      });
      expect(await store.claimEffect(record.operationId, "retry", lease.leaseUntil)).toBeNull();
      expect((await store.getEffect(record.operationId))?.state).toBe("delivery_unknown");
      expect((await store.getRecord(scope))?.slots[0]?.state).toBe("delivery_unknown");
    });

    it("管理投稿復旧はmanager/最新revision/非稼働lease/保持期限をtransaction検査する", async () => {
      let clock = start;
      const store = factory(() => clock);
      await store.register(registration());
      const previous = present(await store.getRecord(scope));
      const record = await store.reserveRecord({
        scope,
        actorAadId: actor,
        now: start,
        expectedRevision: 1,
        snapshot: { ...previous.snapshot, revision: 2, slots: ["表示"] },
      });
      const recovery = {
        scope,
        actorAadId: actor,
        now: start,
        expectedRevision: 2,
        slot: 0,
        activityId: "found",
      };
      await expect(store.recoverRecord({ ...recovery, actorAadId: other })).rejects.toMatchObject({
        code: "unauthorized",
      });
      await expect(store.recoverRecord({ ...recovery, expectedRevision: 1 })).rejects.toMatchObject(
        { code: "stale_revision" },
      );
      const lease = present(await store.claimEffect(record.operationId, "worker", start));
      await expect(store.recoverRecord(recovery)).rejects.toMatchObject({ code: "lease_lost" });
      clock = lease.leaseUntil;
      await store.recoverRecord({ ...recovery, now: clock });
      expect((await store.getRecord(scope))?.slots[0]?.activityId).toBe("found");
      clock = at(90);
      await expect(store.recoverRecord({ ...recovery, now: clock })).rejects.toMatchObject({
        code: "expired",
      });
    });

    it("別slotが所有するactivityIdへの再関連付けを拒否する", async () => {
      const store = factory(() => start);
      await store.ensureSettings({ scope, actorAadId: actor, now: start });
      await store.reserveRecord({
        scope,
        actorAadId: actor,
        now: start,
        expectedRevision: 0,
        snapshot: { scope, revision: 1, slots: ["a", "b"], todos: [] },
      });
      const recovery = {
        scope,
        actorAadId: actor,
        now: start,
        expectedRevision: 1,
        slot: 0,
        activityId: "same-post",
      };
      await store.recoverRecord(recovery);
      await store.recoverRecord(recovery);
      await expect(store.recoverRecord({ ...recovery, slot: 1 })).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("操作参照はhashだけ保存し7日/親保持の早い期限、再利用上書きを拒否", async () => {
      let clock = start;
      const store = factory(() => clock);
      const { todo } = await store.register(registration());
      const tokenHash = "a".repeat(64);
      const input = {
        scope,
        actorAadId: actor,
        now: start,
        tokenHash,
        sourceActivityId: "card",
        action: "done" as const,
        todoId: todo.todoId,
        expectedRevision: 1,
        expireAt: at(30),
      };
      await store.putActionRef(input);
      expect((await store.getActionRef(tokenHash))?.expireAt).toEqual(at(7));
      await expect(
        store.putActionRef({ ...input, sourceActivityId: "other" }),
      ).rejects.toMatchObject({ code: "conflict" });
      clock = at(7);
      expect(await store.getActionRef(tokenHash)).toBeNull();
      clock = at(89);
      await store.putActionRef({
        ...input,
        now: clock,
        tokenHash: "b".repeat(64),
        expireAt: at(100),
      });
      expect((await store.getActionRef("b".repeat(64)))?.expireAt).toEqual(at(90));
      await expect(
        store.putActionRef({ ...input, tokenHash: "raw-secret-token" }),
      ).rejects.toMatchObject({ code: "invalid_evidence" });
    });
  });
}
