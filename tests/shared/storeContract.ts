import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CollectionName, Store, TargetInput, TodoInput } from "../../src/store/types.js";
import { emptyAnalysisState } from "../../src/store/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** テストで進められる時計。 */
export type TestClock = {
  now: () => Date;
  set(date: Date): void;
  advance(ms: number): void;
};

export function createTestClock(start: Date): TestClock {
  let current = start;
  return {
    now: () => new Date(current.getTime()),
    set: (d) => {
      current = d;
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

export type StoreHarness = {
  store: Store;
  /** TTL の欄（expireAt）の値を直接読む。無ければ null。 */
  expireAtOf(collection: CollectionName, id: string): Promise<Date | null>;
};

export type StoreFactory = (now: () => Date) => Promise<StoreHarness>;

// 2025-10-24(金) 14:03 JST
export const START = new Date(Date.UTC(2025, 9, 24, 5, 3, 0));

/** 9:00 JST の時刻。 */
function jst9(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}

function targetInput(over: Partial<TargetInput> = {}): TargetInput {
  return {
    targetId: "t_C1_1729746180-123456",
    kind: "thread",
    channelId: "C1",
    threadTs: "1729746180.123456",
    lastAnalyzedTs: "1729746200.000100",
    analyzedDigest: { "1729746180.123456": "abcdef012345" },
    promptVersion: "v1",
    participants: [{ id: "p1", userId: "U1", name: "田中" }],
    state: {
      ...emptyAnalysisState(),
      topics: [
        {
          id: "k1",
          title: "日程",
          evidence: ["1729746180.123456"],
          requiredParticipants: ["p1"],
          options: [
            {
              id: "o1",
              label: "10/30",
              dateIso: "2025-10-30",
              evidence: ["1729746180.123456"],
              needsReview: false,
              reviewReasons: [],
            },
          ],
          needsReview: false,
          reviewReasons: [],
        },
      ],
    },
    nextSeq: { k: 1, o: 1 },
    canvasSectionMarker: null,
    ...over,
  };
}

function todoInput(over: Partial<TodoInput> = {}): TodoInput {
  return {
    targetId: "t_C1_1",
    itemId: "t1",
    channelId: "C1",
    threadTs: "1729746180.123456",
    text: "資料を送る",
    dueIso: null,
    dueText: null,
    assigneeUserId: "U2",
    createdBy: "U1",
    listMessageTs: "1729746300.000100",
    sourceTs: ["1729746200.000100"],
    ...over,
  };
}

/**
 * メモリ版と Firestore 版で共有する振る舞いのテスト（T006、T007）。
 * テストごとに新しいストアを作る（Firestore 版はテストごとに別の接頭辞）。
 */
export function describeStoreContract(
  name: string,
  factory: StoreFactory,
  options: { skip?: boolean; afterAll?: () => Promise<void> } = {},
): void {
  describe.skipIf(options.skip ?? false)(`${name}: ストアの共通の振る舞い`, () => {
    const clock = createTestClock(START);
    let h: StoreHarness;
    let store: Store;

    beforeEach(async () => {
      clock.set(START);
      h = await factory(clock.now);
      store = h.store;
    });

    afterAll(async () => {
      await options.afterAll?.();
    });

    describe("targets", () => {
      it("無ければ null を返す", async () => {
        expect(await store.targets.get("t_C9_1")).toBeNull();
      });

      it("put した値をそのまま get できる。updatedAt と expireAt（+90 日）を設定する", async () => {
        const saved = await store.targets.put(targetInput());
        expect(saved.updatedAt).toBe(START.toISOString());
        expect(saved.expireAt.getTime()).toBe(START.getTime() + 90 * DAY_MS);

        const got = await store.targets.get("t_C1_1729746180-123456");
        expect(got).toEqual(saved);
        expect(got?.state.topics[0]?.options[0]?.dateIso).toBe("2025-10-30");
        expect(got?.analyzedDigest).toEqual({ "1729746180.123456": "abcdef012345" });
        expect(got?.canvasSectionMarker).toBeNull();
        expect((await h.expireAtOf("targets", "t_C1_1729746180-123456"))?.getTime()).toBe(
          START.getTime() + 90 * DAY_MS,
        );
      });

      it("再度 put すると置き換え、expireAt は最後の更新から 90 日になる", async () => {
        await store.targets.put(targetInput());
        clock.advance(10 * DAY_MS);
        await store.targets.put(targetInput({ promptVersion: "v2", canvasSectionMarker: "arb:1" }));
        const got = await store.targets.get("t_C1_1729746180-123456");
        expect(got?.promptVersion).toBe("v2");
        expect(got?.canvasSectionMarker).toBe("arb:1");
        expect(got?.updatedAt).toBe(clock.now().toISOString());
        expect(got?.expireAt.getTime()).toBe(clock.now().getTime() + 90 * DAY_MS);
      });

      it("チャネルの直近（threadTs が null）も保存できる", async () => {
        await store.targets.put(targetInput({ targetId: "c_C1", kind: "channel", threadTs: null }));
        const got = await store.targets.get("c_C1");
        expect(got?.kind).toBe("channel");
        expect(got?.threadTs).toBeNull();
      });
    });

    describe("todos", () => {
      it("upsert で open の ToDo を作る（todoId は targetId_itemId）", async () => {
        const todo = await store.todos.upsert(
          todoInput({ dueIso: "2025-10-31", dueText: "来週金曜" }),
        );
        expect(todo.todoId).toBe("t_C1_1_t1");
        expect(todo.status).toBe("open");
        expect(todo.lastRemindedOn).toBeNull();
        expect(todo.doneBy).toBeNull();
        expect(todo.doneAt).toBeNull();
        expect(todo.expireAt.getTime()).toBe(START.getTime() + 90 * DAY_MS);
        expect(await store.todos.get("t_C1_1_t1")).toEqual(todo);
        expect((await h.expireAtOf("todos", "t_C1_1_t1"))?.getTime()).toBe(
          START.getTime() + 90 * DAY_MS,
        );
      });

      it("無い ToDo は null", async () => {
        expect(await store.todos.get("nope")).toBeNull();
      });

      it("未完了の ToDo への upsert は値を更新し、createdBy は変えない。expireAt は更新から 90 日", async () => {
        await store.todos.upsert(todoInput());
        clock.advance(5 * DAY_MS);
        const updated = await store.todos.upsert(
          todoInput({
            text: "資料を送る（修正）",
            dueIso: "2025-11-05",
            dueText: "来週水曜",
            assigneeUserId: null,
            createdBy: "U9",
            listMessageTs: "1729999999.000100",
            sourceTs: ["1729746200.000100", "1729746210.000200"],
          }),
        );
        expect(updated.text).toBe("資料を送る（修正）");
        expect(updated.dueIso).toBe("2025-11-05");
        expect(updated.assigneeUserId).toBeNull();
        expect(updated.createdBy).toBe("U1");
        expect(updated.listMessageTs).toBe("1729999999.000100");
        expect(updated.sourceTs).toHaveLength(2);
        expect(updated.updatedAt).toBe(clock.now().toISOString());
        expect(updated.expireAt.getTime()).toBe(clock.now().getTime() + 90 * DAY_MS);
      });

      it("完了済みの ToDo への upsert は何も変えない", async () => {
        await store.todos.upsert(todoInput());
        await store.todos.markDone("t_C1_1_t1", "U2");
        clock.advance(DAY_MS);
        const again = await store.todos.upsert(todoInput({ text: "別の文面" }));
        expect(again.status).toBe("done");
        expect(again.text).toBe("資料を送る");
      });

      it("markDone は open → done にし、expireAt を完了から 90 日にする", async () => {
        await store.todos.upsert(todoInput());
        clock.advance(2 * DAY_MS);
        const r = await store.todos.markDone("t_C1_1_t1", "U2");
        expect(r?.changed).toBe(true);
        expect(r?.todo.status).toBe("done");
        expect(r?.todo.doneBy).toBe("U2");
        expect(r?.todo.doneAt).toBe(clock.now().toISOString());
        expect(r?.todo.expireAt.getTime()).toBe(clock.now().getTime() + 90 * DAY_MS);
        expect((await store.todos.get("t_C1_1_t1"))?.status).toBe("done");
      });

      it("markDone を 2 回呼んでも 2 回目は changed = false で、値は変わらない", async () => {
        await store.todos.upsert(todoInput());
        await store.todos.markDone("t_C1_1_t1", "U2");
        clock.advance(DAY_MS);
        const r = await store.todos.markDone("t_C1_1_t1", "U3");
        expect(r?.changed).toBe(false);
        expect(r?.todo.doneBy).toBe("U2");
      });

      it("存在しない ToDo の markDone は null", async () => {
        expect(await store.todos.markDone("nope", "U1")).toBeNull();
      });

      it("findByMessageTs は一覧のメッセージと根拠のメッセージのどちらでも見つける", async () => {
        await store.todos.upsert(todoInput());
        await store.todos.upsert(
          todoInput({
            itemId: "t2",
            listMessageTs: "1729746300.000100",
            sourceTs: ["1729746222.000300"],
          }),
        );
        const byList = await store.todos.findByMessageTs("C1", "1729746300.000100");
        expect(byList.map((t) => t.itemId).sort()).toEqual(["t1", "t2"]);
        const bySource = await store.todos.findByMessageTs("C1", "1729746222.000300");
        expect(bySource.map((t) => t.itemId)).toEqual(["t2"]);
        expect(await store.todos.findByMessageTs("C2", "1729746300.000100")).toEqual([]);
        expect(await store.todos.findByMessageTs("C1", "9999999999.000000")).toEqual([]);
      });

      describe("findDueForReminder（contracts/http-and-tasks.md#リマインドの対象）", () => {
        async function seed(items: Record<string, Partial<TodoInput>>): Promise<void> {
          for (const [itemId, over] of Object.entries(items)) {
            await store.todos.upsert(todoInput({ itemId, ...over }));
          }
        }
        async function dueIds(today: Date): Promise<string[]> {
          return (await store.todos.findDueForReminder(today)).map((t) => t.itemId).sort();
        }

        it("木曜: 期限切れ、今日、次の営業日（金曜）が対象。土曜以降と期限なしは対象外", async () => {
          await seed({
            past: { dueIso: "2025-10-22" },
            today: { dueIso: "2025-10-23" },
            next: { dueIso: "2025-10-24" },
            sat: { dueIso: "2025-10-25" },
            later: { dueIso: "2025-10-30" },
            none: { dueIso: null },
          });
          expect(await dueIds(jst9(2025, 10, 23))).toEqual(["next", "past", "today"]);
        });

        it("金曜: 次の営業日は月曜なので、土日と月曜の分も含む。火曜は含まない", async () => {
          await seed({
            fri: { dueIso: "2025-10-24" },
            sat: { dueIso: "2025-10-25" },
            mon: { dueIso: "2025-10-27" },
            tue: { dueIso: "2025-10-28" },
          });
          expect(await dueIds(jst9(2025, 10, 24))).toEqual(["fri", "mon", "sat"]);
        });

        it("期限のない ToDo は月曜だけ対象にする", async () => {
          await seed({ none: { dueIso: null } });
          expect(await dueIds(jst9(2025, 10, 24))).toEqual([]);
          expect(await dueIds(jst9(2025, 10, 27))).toEqual(["none"]);
          expect(await dueIds(jst9(2025, 10, 28))).toEqual([]);
        });

        it("完了済みは対象外", async () => {
          await seed({ a: { dueIso: "2025-10-20" }, b: { dueIso: "2025-10-20" } });
          await store.todos.markDone("t_C1_1_a", "U1");
          expect(await dueIds(jst9(2025, 10, 23))).toEqual(["b"]);
        });

        it("今日すでに送ったものは除く。markReminded は updatedAt と expireAt を変えない", async () => {
          await seed({ a: { dueIso: "2025-10-20" }, b: { dueIso: "2025-10-20" } });
          const before = await store.todos.get("t_C1_1_a");
          clock.advance(DAY_MS);
          await store.todos.markReminded(["t_C1_1_a"], jst9(2025, 10, 23));
          const after = await store.todos.get("t_C1_1_a");
          expect(after?.lastRemindedOn).toBe("2025-10-23");
          expect(after?.updatedAt).toBe(before?.updatedAt);
          expect(after?.expireAt).toEqual(before?.expireAt);
          expect(await dueIds(jst9(2025, 10, 23))).toEqual(["b"]);
          // 翌日にはまた対象になる
          expect(await dueIds(jst9(2025, 10, 24))).toEqual(["a", "b"]);
        });

        it("JST の日付で判定する（UTC では前日でも、JST で月曜なら月曜）", async () => {
          await seed({ none: { dueIso: null } });
          // 2025-10-27 08:59 JST = 2025-10-26 23:59 UTC
          expect(await dueIds(new Date(Date.UTC(2025, 9, 26, 23, 59, 0)))).toEqual(["none"]);
          // 2025-10-26 23:59 JST（日曜）
          expect(await dueIds(new Date(Date.UTC(2025, 9, 26, 14, 59, 0)))).toEqual([]);
        });
      });
    });

    describe("canvases", () => {
      it("無ければ null。set して get できる。上書きもできる", async () => {
        expect(await store.canvases.get("C1")).toBeNull();
        const c = await store.canvases.set("C1", "F123");
        expect(c).toEqual({ channelId: "C1", canvasId: "F123", createdAt: START.toISOString() });
        expect(await store.canvases.get("C1")).toEqual(c);
        await store.canvases.set("C1", "F456");
        expect((await store.canvases.get("C1"))?.canvasId).toBe("F456");
      });
    });

    describe("chunk_cache", () => {
      it("無ければ null。put した配列を get できる。expireAt は +90 日", async () => {
        expect(await store.chunkCache.get("abc")).toBeNull();
        const value = [
          { title: "候補", evidence: ["1.1"] },
          { title: "候補2", evidence: [] },
        ];
        await store.chunkCache.put("abc", value);
        expect(await store.chunkCache.get("abc")).toEqual(value);
        expect((await h.expireAtOf("chunk_cache", "abc"))?.getTime()).toBe(
          START.getTime() + 90 * DAY_MS,
        );
      });

      it("空の配列も保存できる", async () => {
        await store.chunkCache.put("empty", []);
        expect(await store.chunkCache.get("empty")).toEqual([]);
      });
    });

    describe("processed_events", () => {
      it("replyChunksを保存し、入力と取得結果の変更を保存値から分離する", async () => {
        const input = {
          targetId: "teams_target",
          channelId: "teams_channel",
          threadTs: "100",
          mentionTs: "101",
          stages: {},
          messages: {},
          replyChunks: ["完成した返信1", "完成した返信2"],
        };
        const saved = await store.events.saveRequestProgress("teams-snapshot", input);
        expect(saved.replyChunks).toEqual(["完成した返信1", "完成した返信2"]);
        input.replyChunks[0] = "入力の変更";
        const first = await store.events.getRequestProgress("teams-snapshot");
        expect(first?.replyChunks).toEqual(["完成した返信1", "完成した返信2"]);
        if (first?.replyChunks !== undefined) first.replyChunks[0] = "取得結果の変更";
        expect((await store.events.getRequestProgress("teams-snapshot"))?.replyChunks).toEqual([
          "完成した返信1",
          "完成した返信2",
        ]);
      });
      it("依頼の段階と返信をtaskNameごとに保存し、重複除去と7日TTLを維持する", async () => {
        expect(await store.events.getRequestProgress("evt-run")).toBeNull();
        await store.events.markProcessed("evt-run");
        const input = {
          targetId: "t_C1_1",
          channelId: "C1",
          threadTs: "1",
          mentionTs: "2",
          stages: { todos: "done" as const, canvas: "skipped" as const },
          messages: { "summary:0": "3" },
        };
        const saved = await store.events.saveRequestProgress("evt-run", input);
        expect(saved.updatedAt).toBe(START.toISOString());
        expect(await store.events.markProcessed("evt-run")).toBe(false);
        expect(await store.events.getRequestProgress("evt-other")).toBeNull();
        expect(await store.events.getRequestProgress("evt-run")).toEqual(saved);
        expect((await h.expireAtOf("processed_events", "evt-run"))?.getTime()).toBe(
          START.getTime() + 7 * DAY_MS,
        );
        await expect(
          store.events.saveRequestProgress("evt-run", { ...input, targetId: "t_C2_1" }),
        ).rejects.toThrow();
        clock.advance(7 * DAY_MS);
        expect(await store.events.getRequestProgress("evt-run")).toBeNull();
      });

      it("markProcessed は初回 true、2 回目以降は false。expireAt は +7 日", async () => {
        expect(await store.events.markProcessed("evt-1")).toBe(true);
        expect(await store.events.markProcessed("evt-1")).toBe(false);
        expect(await store.events.markProcessed("evt-2")).toBe(true);
        expect((await h.expireAtOf("processed_events", "evt-1"))?.getTime()).toBe(
          START.getTime() + 7 * DAY_MS,
        );
      });

      it("同時に呼んでも 1 つだけが true になる", async () => {
        const results = await Promise.all([
          store.events.markProcessed("evt-9"),
          store.events.markProcessed("evt-9"),
          store.events.markProcessed("evt-9"),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    describe("job_locks", () => {
      const TTL = 15 * 60 * 1000;

      it("取れたらトークン（文字列）、有効なリースがあれば null、別の対象は独立", async () => {
        const token = await store.locks.acquire("t_C1_1", TTL);
        expect(typeof token).toBe("string");
        expect(token).not.toBe("");
        expect(await store.locks.acquire("t_C1_1", TTL)).toBeNull();
        const other = await store.locks.acquire("t_C1_2", TTL);
        expect(typeof other).toBe("string");
        expect((await h.expireAtOf("job_locks", "t_C1_1"))?.getTime()).toBe(START.getTime() + TTL);
      });

      it("release すると取り直せる。release の後の release は何もしない", async () => {
        const token = await store.locks.acquire("t_C1_1", TTL);
        expect(token).not.toBeNull();
        await store.locks.release("t_C1_1", token as string);
        await store.locks.release("t_C1_1", token as string);
        expect(await store.locks.acquire("t_C1_1", TTL)).not.toBeNull();
      });

      it("トークンが違う release は何も消さない", async () => {
        const token = await store.locks.acquire("t_C1_1", TTL);
        await store.locks.release("t_C1_1", "wrong-token");
        expect(await store.locks.acquire("t_C1_1", TTL)).toBeNull();
        await store.locks.release("t_C1_1", token as string);
        expect(await store.locks.acquire("t_C1_1", TTL)).not.toBeNull();
      });

      it("リースの期限が切れたら取り直せる", async () => {
        await store.locks.acquire("t_C1_1", TTL);
        clock.advance(TTL - 1);
        expect(await store.locks.acquire("t_C1_1", TTL)).toBeNull();
        clock.advance(2);
        expect(await store.locks.acquire("t_C1_1", TTL)).not.toBeNull();
      });

      it("期限切れの後に別の所有者が取ったロックを、前の所有者は消せない", async () => {
        const first = await store.locks.acquire("t_C1_1", TTL);
        clock.advance(TTL + 1);
        const second = await store.locks.acquire("t_C1_1", TTL);
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
        await store.locks.release("t_C1_1", first as string);
        // 2 番目の所有者のリースは残っているので、取れない。
        expect(await store.locks.acquire("t_C1_1", TTL)).toBeNull();
        await store.locks.release("t_C1_1", second as string);
        expect(await store.locks.acquire("t_C1_1", TTL)).not.toBeNull();
      });

      it("同時に取っても 1 つだけがトークンを得る", async () => {
        const results = await Promise.all([
          store.locks.acquire("t_C1_7", TTL),
          store.locks.acquire("t_C1_7", TTL),
          store.locks.acquire("t_C1_7", TTL),
        ]);
        expect(results.filter((r) => r !== null)).toHaveLength(1);
      });
    });
  });
}
