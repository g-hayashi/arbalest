/**
 * リマインド（T022、T023）。US2 のシナリオ 2、4、SC-007、spec の Edge Cases（退出した担当者）。
 * 時刻は JST で固定する。2026-10-26 は月曜、10-29 は木曜、10-30 は金曜、10-31 は土曜。
 */
import inject from "light-my-request";
import { describe, expect, it, vi } from "vitest";
import { REMINDERS_PATH, TODO_DONE_ACTION_ID } from "../../src/jobs/types.js";
import { createFakeLlmProvider } from "../../src/llm/index.js";
import { createMemoryStore, type MemoryStore } from "../../src/store/memory/index.js";
import { todoIdOf } from "../../src/store/types.js";
import { remindersJob } from "../../src/worker/jobs/reminders.js";
import { createWorker, type JobContext } from "../../src/worker/server.js";
import { createFakeSlack } from "../shared/fakeSlack.js";

/** JST の 9:00。 */
const at = (month: number, day: number) => new Date(Date.UTC(2026, month - 1, day, 0, 0, 0));
const MON = at(10, 26);
const THU = at(10, 29);
const FRI = at(10, 30);
const SAT = at(10, 31);

const TANAKA = "U0TANAKA";
const SATO = "U0SATO";
const SUZUKI = "U0SUZUKI";
const NAMES = new Map([
  [TANAKA, "田中"],
  [SATO, "佐藤"],
  [SUZUKI, "鈴木"],
]);

const CHANNEL = "C1";
const THREAD_TS = "1792000000.000100";
const TARGET_ID = `t_${CHANNEL}_${THREAD_TS.replace(".", "-")}`;

type Seed = {
  id: string;
  dueIso?: string | null;
  assignee?: string | null;
  createdBy?: string;
  done?: boolean;
  text?: string;
};

async function seed(store: MemoryStore, s: Seed) {
  const todo = await store.todos.upsert({
    targetId: TARGET_ID,
    itemId: s.id,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    text: s.text ?? `ToDo ${s.id}`,
    dueIso: s.dueIso ?? null,
    dueText: null,
    assigneeUserId: s.assignee === undefined ? TANAKA : s.assignee,
    createdBy: s.createdBy ?? SATO,
    listMessageTs: "1792000001.000000",
    sourceTs: [THREAD_TS],
  });
  if (s.done) await store.todos.markDone(todo.todoId, TANAKA);
  return todo.todoId;
}

function setup(now: Date, options: { deleted?: string[] } = {}) {
  const store = createMemoryStore({ now: () => now });
  const slack = createFakeSlack(NAMES, { deleted: new Set(options.deleted ?? []) });
  const state = { now };
  const ctx: JobContext = {
    slack: slack.client,
    store,
    llm: createFakeLlmProvider(),
    now: () => state.now,
    log: vi.fn() as unknown as JobContext["log"],
  };
  return {
    store,
    slack,
    ctx,
    setNow(d: Date) {
      state.now = d;
    },
  };
}

type AnyBlock = { type: string; text?: { text: string }; accessory?: { value?: string } };
const textOf = (post: { text: string; blocks?: unknown[] }) =>
  ((post.blocks ?? []) as AnyBlock[]).map((b) => b.text?.text ?? "").join("\n");
const buttonValues = (post: { blocks?: unknown[] }) =>
  ((post.blocks ?? []) as AnyBlock[])
    .map((b) => b.accessory?.value)
    .filter((v): v is string => v !== undefined);

const run = (h: ReturnType<typeof setup>) => remindersJob({}, h.ctx);

describe("リマインドの対象（US2 シナリオ 2、4、SC-007）", () => {
  it("木曜の朝: 次の営業日（金曜）が期限のものと期限切れに送る。月曜以降の期限、期限なし、完了済みには送らない", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "due-fri", dueIso: "2026-10-30" });
    await seed(h.store, { id: "overdue", dueIso: "2026-10-27" });
    await seed(h.store, { id: "due-mon", dueIso: "2026-11-02" });
    await seed(h.store, { id: "no-due" });
    await seed(h.store, { id: "done", dueIso: "2026-10-30", done: true });

    await run(h);

    expect(h.slack.posts).toHaveLength(1);
    const post = h.slack.posts[0] as { channel: string; text: string; blocks?: unknown[] };
    expect(post.channel).toBe(TANAKA);
    expect(buttonValues(post).sort()).toEqual(
      [todoIdOf(TARGET_ID, "due-fri"), todoIdOf(TARGET_ID, "overdue")].sort(),
    );
    expect(h.slack.ephemerals).toEqual([]);
  });

  it("金曜の朝: 月曜が期限のものも含める。火曜以降の期限は含めない", async () => {
    const h = setup(FRI);
    await seed(h.store, { id: "due-mon", dueIso: "2026-11-02" });
    await seed(h.store, { id: "due-tue", dueIso: "2026-11-03" });
    await seed(h.store, { id: "no-due" });

    await run(h);

    expect(h.slack.posts).toHaveLength(1);
    expect(buttonValues(h.slack.posts[0] as { blocks?: unknown[] })).toEqual([
      todoIdOf(TARGET_ID, "due-mon"),
    ]);
  });

  it("土曜: 月曜が期限のものだけ。期限なしは送らない", async () => {
    const h = setup(SAT);
    await seed(h.store, { id: "due-mon", dueIso: "2026-11-02" });
    await seed(h.store, { id: "no-due" });

    await run(h);

    expect(h.slack.posts).toHaveLength(1);
    expect(buttonValues(h.slack.posts[0] as { blocks?: unknown[] })).toEqual([
      todoIdOf(TARGET_ID, "due-mon"),
    ]);
  });

  it("月曜の朝: 期限のない ToDo にも送る", async () => {
    const h = setup(MON);
    await seed(h.store, { id: "no-due" });
    await seed(h.store, { id: "due-tue", dueIso: "2026-10-27" });
    await seed(h.store, { id: "due-wed", dueIso: "2026-10-28" });

    await run(h);

    expect(h.slack.posts).toHaveLength(1);
    expect(buttonValues(h.slack.posts[0] as { blocks?: unknown[] }).sort()).toEqual(
      [todoIdOf(TARGET_ID, "no-due"), todoIdOf(TARGET_ID, "due-tue")].sort(),
    );
  });

  it("対象がなければ何も送らない", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "no-due" });
    await run(h);
    expect(h.slack.posts).toEqual([]);
  });

  it("同じ日の再実行では二重に送らない。翌日には、まだ未完了なら送る", async () => {
    const h = setup(THU);
    const id = await seed(h.store, { id: "due-fri", dueIso: "2026-10-30" });

    await run(h);
    await run(h);
    expect(h.slack.posts).toHaveLength(1);
    expect((await h.store.todos.get(id))?.lastRemindedOn).toBe("2026-10-29");

    h.setNow(FRI);
    await run(h);
    expect(h.slack.posts).toHaveLength(2);
  });

  it("完了にした ToDo には、その後のリマインドを送らない", async () => {
    const h = setup(THU);
    const id = await seed(h.store, { id: "due-fri", dueIso: "2026-10-30" });
    await h.store.todos.markDone(id, TANAKA);
    await run(h);
    expect(h.slack.posts).toEqual([]);
  });
});

describe("宛先と本文", () => {
  it("1 人に 1 通。担当者ごとに DM（channel = userId）を送り、担当者がいなければ登録した人に送る", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "a1", dueIso: "2026-10-30", assignee: TANAKA });
    await seed(h.store, { id: "a2", dueIso: "2026-10-29", assignee: TANAKA });
    await seed(h.store, { id: "b1", dueIso: "2026-10-30", assignee: SUZUKI });
    await seed(h.store, { id: "u1", dueIso: "2026-10-30", assignee: null, createdBy: SATO });

    await run(h);

    const byChannel = new Map(h.slack.posts.map((p) => [p.channel, p]));
    expect(h.slack.posts).toHaveLength(3);
    expect([...byChannel.keys()].sort()).toEqual([SATO, SUZUKI, TANAKA].sort());
    for (const p of h.slack.posts) expect(p.thread_ts).toBeUndefined();
    expect(buttonValues(byChannel.get(TANAKA) as { blocks?: unknown[] }).sort()).toEqual(
      [todoIdOf(TARGET_ID, "a1"), todoIdOf(TARGET_ID, "a2")].sort(),
    );
    expect(buttonValues(byChannel.get(SATO) as { blocks?: unknown[] })).toEqual([
      todoIdOf(TARGET_ID, "u1"),
    ]);
  });

  it("各 ToDo に完了のボタン（todo_done）と元のスレッドへのリンクを付ける", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "a1", dueIso: "2026-10-30", text: "会議室を予約する" });
    await run(h);

    const post = h.slack.posts[0] as { text: string; blocks?: unknown[] };
    const blocks = (post.blocks ?? []) as { accessory?: { action_id?: string } }[];
    expect(blocks.some((b) => b.accessory?.action_id === TODO_DONE_ACTION_ID)).toBe(true);
    const text = textOf(post);
    expect(text).toContain("会議室を予約する");
    expect(text).toContain("10/30(金)");
    expect(text).toContain(
      `https://example.slack.com/archives/${CHANNEL}/p${THREAD_TS.replace(".", "")}`,
    );
  });

  it("期限切れは、期限切れと分かる形で示す（FR-024）。期限内のものには付けない", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "late", dueIso: "2026-10-27", text: "遅れている件" });
    await seed(h.store, { id: "soon", dueIso: "2026-10-30", text: "明日の件" });
    await run(h);

    const lines = textOf(h.slack.posts[0] as { text: string; blocks?: unknown[] }).split("\n");
    expect(lines.find((l) => l.includes("遅れている件"))).toContain("期限切れ");
    expect(lines.find((l) => l.includes("明日の件"))).not.toContain("期限切れ");
  });

  it("ToDo の本文の `<!channel>` はメンションにならない", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "x", dueIso: "2026-10-30", text: "<!channel> に連絡" });
    await run(h);
    const text = textOf(h.slack.posts[0] as { text: string; blocks?: unknown[] });
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
  });

  it("50 ブロックを超える分は、続きの DM に分ける", async () => {
    const h = setup(THU);
    for (let i = 0; i < 60; i++) await seed(h.store, { id: `n${i}`, dueIso: "2026-10-30" });
    await run(h);
    expect(h.slack.posts.length).toBeGreaterThan(1);
    for (const p of h.slack.posts) {
      expect(p.channel).toBe(TANAKA);
      expect((p.blocks ?? []).length).toBeLessThanOrEqual(50);
    }
    const sent = h.slack.posts.flatMap((p) => buttonValues(p));
    expect(new Set(sent).size).toBe(60);
  });

  it("DM の送信に失敗した宛先は記録せず、他の宛先には送る。例外にして再試行させ、再試行では失敗した分だけ送る", async () => {
    const h = setup(THU);
    const a = await seed(h.store, { id: "a", dueIso: "2026-10-30", assignee: TANAKA });
    const b = await seed(h.store, { id: "b", dueIso: "2026-10-30", assignee: SUZUKI });
    const original = h.slack.client.chat.postMessage;
    let failTanaka = true;
    (h.slack.client.chat as unknown as { postMessage: unknown }).postMessage = async (args: {
      channel: string;
    }) => {
      if (args.channel === TANAKA && failTanaka) throw new Error("ratelimited");
      return (original as (a: unknown) => Promise<unknown>)(args);
    };

    await expect(run(h)).rejects.toThrow("ratelimited");
    expect(h.slack.posts.map((p) => p.channel)).toEqual([SUZUKI]);
    expect((await h.store.todos.get(a))?.lastRemindedOn).toBeNull();
    expect((await h.store.todos.get(b))?.lastRemindedOn).toBe("2026-10-29");

    failTanaka = false;
    await run(h);
    expect(h.slack.posts.map((p) => p.channel)).toEqual([SUZUKI, TANAKA]);
  });
});

describe("退出・削除された担当者（T023）", () => {
  it("担当者が deleted なら、宛先を登録した人に替え、「担当者が不在です」と名前を添える", async () => {
    const h = setup(THU, { deleted: [TANAKA] });
    const id = await seed(h.store, {
      id: "gone",
      dueIso: "2026-10-30",
      assignee: TANAKA,
      createdBy: SATO,
      text: "引き継ぎ資料を作る",
    });
    await seed(h.store, { id: "mine", dueIso: "2026-10-30", assignee: SATO, createdBy: SATO });

    await run(h);

    // 田中には送らず、佐藤に 1 通
    expect(h.slack.posts).toHaveLength(1);
    const post = h.slack.posts[0] as { channel: string; text: string; blocks?: unknown[] };
    expect(post.channel).toBe(SATO);
    const lines = textOf(post).split("\n");
    const gone = lines.find((l) => l.includes("引き継ぎ資料を作る"));
    expect(gone).toContain("担当者が不在です");
    expect(gone).toContain("田中");
    const mine = lines.find((l) => l.includes("ToDo mine"));
    expect(mine).not.toContain("担当者が不在です");
    expect(buttonValues(post)).toContain(id);
    expect((await h.store.todos.get(id))?.lastRemindedOn).toBe("2026-10-29");
  });

  it("担当者が在籍していれば、不在の表示は付けない", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "ok", dueIso: "2026-10-30" });
    await run(h);
    expect(textOf(h.slack.posts[0] as { text: string; blocks?: unknown[] })).not.toContain("不在");
  });
});

describe("worker 経由", () => {
  it("/cron/reminders は taskName なしで呼べて、200 を返す", async () => {
    const h = setup(THU);
    await seed(h.store, { id: "a1", dueIso: "2026-10-30" });
    const worker = createWorker({
      slack: h.slack.client,
      store: h.store,
      llm: createFakeLlmProvider(),
      now: () => THU,
    });
    worker.registerJob(REMINDERS_PATH, remindersJob, { dedupe: false });

    const res = await inject(worker.handle, { method: "POST", url: REMINDERS_PATH });
    expect(res.statusCode).toBe(200);
    expect(h.slack.posts).toHaveLength(1);
  });
});
