import type { WebClient } from "@slack/web-api";
import inject from "light-my-request";
import { describe, expect, it, vi } from "vitest";
import { createFakeLlmProvider, LlmError } from "../../src/llm/index.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import {
  createWorker,
  FAILED_TEXT,
  FILTERED_TEXT,
  type JobContext,
  type JobHandler,
} from "../../src/worker/server.js";

const NOW = new Date("2025-10-24T05:03:00.000Z");
const LOCK_TTL = 15 * 60 * 1000;

function platformError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

type SlackFake = {
  postMessage: ReturnType<typeof vi.fn>;
  postEphemeral: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
};

function fakeSlack(over: Partial<SlackFake> = {}) {
  const fake: SlackFake = {
    postMessage: over.postMessage ?? vi.fn(async () => ({ ok: true })),
    postEphemeral: over.postEphemeral ?? vi.fn(async () => ({ ok: true })),
    open: over.open ?? vi.fn(async () => ({ ok: true, channel: { id: "D1" } })),
  };
  const client = {
    chat: { postMessage: fake.postMessage, postEphemeral: fake.postEphemeral },
    conversations: { open: fake.open },
  } as unknown as WebClient;
  return { client, fake };
}

function setup(opts: { slack?: Partial<SlackFake>; maxRetryCount?: number } = {}) {
  const store = createMemoryStore({ now: () => NOW });
  const { client, fake } = fakeSlack(opts.slack);
  const worker = createWorker({
    slack: client,
    store,
    llm: createFakeLlmProvider(),
    now: () => NOW,
    maxRetryCount: opts.maxRetryCount ?? 4,
  });
  return { worker, store, slack: fake };
}

const payload = (over: Record<string, unknown> = {}) => ({
  taskName: "evt-Ev1",
  command: "summarize",
  teamId: "T1",
  channelId: "C1",
  threadTs: "1729746180.123456",
  mentionTs: "1729746200.000100",
  userId: "U1",
  requestedAt: NOW.toISOString(),
  ...over,
});

function call(
  worker: ReturnType<typeof setup>["worker"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return inject(worker.handle, {
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ok: JobHandler = async () => {};

describe("worker", () => {
  it("GET /healthz は 200 ok", async () => {
    const { worker } = setup();
    const res = await inject(worker.handle, { method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("登録していないパスは 404", async () => {
    const { worker } = setup();
    const res = await call(worker, "/jobs/nothing", payload());
    expect(res.statusCode).toBe(404);
  });

  it("登録したジョブを、payload と ctx（slack、store、llm、now、log）で呼ぶ", async () => {
    const { worker, store } = setup();
    let seen: { payload: unknown; ctx: JobContext } | undefined;
    worker.registerJob("/jobs/summarize", async (p, ctx) => {
      seen = { payload: p, ctx };
    });
    const res = await call(worker, "/jobs/summarize", payload());
    expect(res.statusCode).toBe(200);
    expect(seen?.payload).toEqual(payload());
    expect(seen?.ctx.store).toBe(store);
    expect(seen?.ctx.now()).toEqual(NOW);
    expect(typeof seen?.ctx.log).toBe("function");
    expect(seen?.ctx.slack).toBeDefined();
    expect(seen?.ctx.llm).toBeDefined();
  });

  it("同じ taskName の 2 回目は処理せず 200", async () => {
    const { worker } = setup();
    const handler = vi.fn(ok);
    worker.registerJob("/jobs/summarize", handler);
    expect((await call(worker, "/jobs/summarize", payload())).statusCode).toBe(200);
    expect((await call(worker, "/jobs/summarize", payload())).statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("本文が JSON でない、または taskName が無ければ 400", async () => {
    const { worker } = setup();
    const handler = vi.fn(ok);
    worker.registerJob("/jobs/summarize", handler);
    expect((await call(worker, "/jobs/summarize", "{not json")).statusCode).toBe(400);
    expect((await call(worker, "/jobs/summarize", { channelId: "C1" })).statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  describe("同じ対象の同時処理（R3）", () => {
    it("ロックが取れなければ「処理中です」とスレッドに返信して 200。ジョブは呼ばない", async () => {
      const { worker, store, slack } = setup();
      const handler = vi.fn(ok);
      worker.registerJob("/jobs/summarize", handler);
      await store.locks.acquire("t_C1_1729746180-123456", LOCK_TTL);
      const res = await call(worker, "/jobs/summarize", payload());
      expect(res.statusCode).toBe(200);
      expect(handler).not.toHaveBeenCalled();
      expect(slack.postMessage).toHaveBeenCalledTimes(1);
      const arg = slack.postMessage.mock.calls[0]?.[0];
      expect(arg.channel).toBe("C1");
      expect(arg.thread_ts).toBe("1729746200.000100");
      expect(arg.text).toContain("処理中");
    });

    it("対象の ID: スレッドは t_<ch>_<ts>、チャネルは c_<ch>、findings は f_<ch>", async () => {
      const { worker, store } = setup();
      const seenLocked: Record<string, string | null> = {};
      worker.registerJob("/jobs/summarize", async (p) => {
        const q = p as { channelId: string; threadTs: string | null };
        const id = q.threadTs === null ? `c_${q.channelId}` : "t_C1_1729746180-123456";
        seenLocked[q.threadTs ?? "channel"] = await store.locks.acquire(id, LOCK_TTL);
      });
      worker.registerJob("/jobs/findings", async (p) => {
        const q = p as { channelId: string };
        seenLocked.findings = await store.locks.acquire(`f_${q.channelId}`, LOCK_TTL);
      });
      await call(worker, "/jobs/summarize", payload());
      await call(worker, "/jobs/summarize", payload({ taskName: "evt-2", threadTs: null }));
      await call(
        worker,
        "/jobs/findings",
        payload({ taskName: "evt-3", command: "findings", threadTs: null, days: 30 }),
      );
      // ジョブの中で同じ ID のロックを取り直すと、worker が取っているので null になる。
      expect(seenLocked).toEqual({
        "1729746180.123456": null,
        channel: null,
        findings: null,
      });
    });

    it("成功しても失敗しても、ロックは解放される", async () => {
      const { worker, store } = setup();
      worker.registerJob("/jobs/summarize", ok);
      await call(worker, "/jobs/summarize", payload());
      expect(await store.locks.acquire("t_C1_1729746180-123456", LOCK_TTL)).not.toBeNull();
      // 失敗の側
      const second = setup();
      second.worker.registerJob("/jobs/todo", async () => {
        throw new Error("boom");
      });
      const res = await call(second.worker, "/jobs/todo", payload({ command: "todo" }));
      expect(res.statusCode).toBe(500);
      expect(await second.store.locks.acquire("t_C1_1729746180-123456", LOCK_TTL)).not.toBeNull();
    });

    it("ロックの取得に使うのはジョブごとの lockKey の指定でも変えられる（null ならロックしない）", async () => {
      const { worker, store } = setup();
      let during: string | null = "unset";
      worker.registerJob(
        "/jobs/todo-done",
        async () => {
          during = await store.locks.acquire("t_C1_1729746180-123456", LOCK_TTL);
        },
        { lockKey: () => null },
      );
      await call(worker, "/jobs/todo-done", {
        taskName: "act-1",
        todoId: "t_C1_1_t1",
        channelId: "C1",
        userId: "U1",
      });
      expect(during).not.toBeNull();
    });
  });

  describe("失敗と再試行（FR-054）", () => {
    it("一時的な失敗は 5xx（返信しない）", async () => {
      const { worker, slack } = setup();
      worker.registerJob("/jobs/summarize", async () => {
        throw new Error("llm 503");
      });
      const res = await call(worker, "/jobs/summarize", payload(), {
        "X-CloudTasks-TaskRetryCount": "1",
      });
      expect(res.statusCode).toBe(500);
      expect(slack.postMessage).not.toHaveBeenCalled();
    });

    it.each(["timeout", "rate_limit", "server"] as const)(
      "AI の一時的な失敗（LlmError %s）は、最後の試行より前なら 5xx（返信しない）",
      async (kind) => {
        const { worker, slack } = setup();
        worker.registerJob("/jobs/summarize", async () => {
          throw new LlmError(kind, "x");
        });
        const res = await call(worker, "/jobs/summarize", payload(), {
          "X-CloudTasks-TaskRetryCount": "1",
        });
        expect(res.statusCode).toBe(500);
        expect(slack.postMessage).not.toHaveBeenCalled();
      },
    );

    it.each(["schema", "config"] as const)(
      "AI の一時的でない失敗（LlmError %s）は、1 回目でも 200 にして失敗を返信する（再試行させない）",
      async (kind) => {
        const { worker, slack } = setup();
        worker.registerJob("/jobs/summarize", async () => {
          throw new LlmError(kind, "x");
        });
        const res = await call(worker, "/jobs/summarize", payload());
        expect(res.statusCode).toBe(200);
        expect(slack.postMessage).toHaveBeenCalledTimes(1);
        const arg = slack.postMessage.mock.calls[0]?.[0];
        expect(arg.thread_ts).toBe("1729746200.000100");
        expect(arg.text).toBe(FAILED_TEXT);
      },
    );

    it("安全フィルタ（LlmError content_filter）は 200 にして、その旨を返信する", async () => {
      const { worker, slack } = setup();
      worker.registerJob("/jobs/summarize", async () => {
        throw new LlmError("content_filter", "x");
      });
      const res = await call(worker, "/jobs/summarize", payload());
      expect(res.statusCode).toBe(200);
      expect(slack.postMessage).toHaveBeenCalledTimes(1);
      expect(slack.postMessage.mock.calls[0]?.[0].text).toBe(FILTERED_TEXT);
    });

    it.each([
      ["TypeError", () => new TypeError("undefined is not a function")],
      ["ReferenceError", () => new ReferenceError("x is not defined")],
      ["RangeError", () => new RangeError("bad")],
    ])(
      "実装のバグ（%s）は、1 回目でも 200 にして失敗を返信する（再試行しても直らない）",
      async (_n, make) => {
        const { worker, slack } = setup();
        worker.registerJob("/jobs/summarize", async () => {
          throw make();
        });
        const res = await call(worker, "/jobs/summarize", payload());
        expect(res.statusCode).toBe(200);
        expect(slack.postMessage).toHaveBeenCalledTimes(1);
        expect(slack.postMessage.mock.calls[0]?.[0].text).toBe(FAILED_TEXT);
      },
    );

    it("Slack の失敗など、種類が分からない失敗は一時的として 5xx", async () => {
      const { worker, slack } = setup();
      worker.registerJob("/jobs/summarize", async () => {
        throw platformError("ratelimited");
      });
      const res = await call(worker, "/jobs/summarize", payload());
      expect(res.statusCode).toBe(500);
      expect(slack.postMessage).not.toHaveBeenCalled();
    });

    it("最後の再試行で失敗したら、失敗を返信して 200", async () => {
      const { worker, slack } = setup({ maxRetryCount: 4 });
      worker.registerJob("/jobs/summarize", async () => {
        throw new Error("llm 503");
      });
      const res = await call(worker, "/jobs/summarize", payload(), {
        "X-CloudTasks-TaskRetryCount": "4",
      });
      expect(res.statusCode).toBe(200);
      expect(slack.postMessage).toHaveBeenCalledTimes(1);
      const arg = slack.postMessage.mock.calls[0]?.[0];
      expect(arg.thread_ts).toBe("1729746200.000100");
      expect(arg.text).toContain("失敗");
    });

    it("失敗した後の再試行（TaskRetryCount ≥ 1）は、重複の除去に当たらず再実行される", async () => {
      const { worker } = setup();
      let calls = 0;
      worker.registerJob("/jobs/summarize", async () => {
        calls += 1;
        if (calls === 1) throw new Error("llm 503");
      });
      const first = await call(worker, "/jobs/summarize", payload());
      expect(first.statusCode).toBe(500);
      const retry = await call(worker, "/jobs/summarize", payload(), {
        "X-CloudTasks-TaskRetryCount": "1",
      });
      expect(retry.statusCode).toBe(200);
      expect(calls).toBe(2);
    });
  });

  describe("招待されていないチャネル（FR-005）", () => {
    it.each(["not_in_channel", "channel_not_found"])(
      "%s: 呼んだ人に /invite の案内をスレッドへ返信して 200",
      async (code) => {
        const { worker, slack } = setup();
        worker.registerJob("/jobs/summarize", async () => {
          throw platformError(code);
        });
        const res = await call(worker, "/jobs/summarize", payload());
        expect(res.statusCode).toBe(200);
        expect(slack.postMessage).toHaveBeenCalledTimes(1);
        expect(slack.postMessage.mock.calls[0]?.[0].text).toContain("/invite @arbalest");
        expect(slack.postMessage.mock.calls[0]?.[0].thread_ts).toBe("1729746200.000100");
        expect(slack.postEphemeral).not.toHaveBeenCalled();
      },
    );

    it("チャネルに投稿できなければ chat.postEphemeral で呼んだ人に送る", async () => {
      const { worker, slack } = setup({
        slack: { postMessage: vi.fn(async () => Promise.reject(platformError("not_in_channel"))) },
      });
      worker.registerJob("/jobs/summarize", async () => {
        throw platformError("not_in_channel");
      });
      const res = await call(worker, "/jobs/summarize", payload());
      expect(res.statusCode).toBe(200);
      expect(slack.postEphemeral).toHaveBeenCalledTimes(1);
      const arg = slack.postEphemeral.mock.calls[0]?.[0];
      expect(arg.channel).toBe("C1");
      expect(arg.user).toBe("U1");
      expect(arg.text).toContain("/invite @arbalest");
      expect(slack.open).not.toHaveBeenCalled();
    });

    it("エフェメラルも失敗したら DM で送る", async () => {
      const postMessage = vi.fn(async (args: { channel: string }) => {
        if (args.channel === "C1") throw platformError("not_in_channel");
        return { ok: true };
      });
      const { worker, slack } = setup({
        slack: {
          postMessage,
          postEphemeral: vi.fn(async () => Promise.reject(platformError("channel_not_found"))),
        },
      });
      worker.registerJob("/jobs/summarize", async () => {
        throw platformError("channel_not_found");
      });
      const res = await call(worker, "/jobs/summarize", payload());
      expect(res.statusCode).toBe(200);
      expect(slack.open).toHaveBeenCalledWith({ users: "U1" });
      const last = postMessage.mock.calls.at(-1)?.[0] as { channel: string; text: string };
      expect(last.channel).toBe("D1");
      expect(last.text).toContain("/invite @arbalest");
    });

    it("案内の送信がすべて失敗しても 200（再試行させない）", async () => {
      const { worker } = setup({
        slack: {
          postMessage: vi.fn(async () => Promise.reject(platformError("not_in_channel"))),
          postEphemeral: vi.fn(async () => Promise.reject(platformError("not_in_channel"))),
          open: vi.fn(async () => Promise.reject(new Error("down"))),
        },
      });
      worker.registerJob("/jobs/summarize", async () => {
        throw platformError("not_in_channel");
      });
      const res = await call(worker, "/jobs/summarize", payload());
      expect(res.statusCode).toBe(200);
    });
  });

  describe("cron など taskName の無い呼び出し", () => {
    it("dedupe: false なら本文なしでも呼ぶ。ロックもしない", async () => {
      const { worker } = setup();
      const handler = vi.fn(ok);
      worker.registerJob("/cron/reminders", handler, { dedupe: false });
      const res = await inject(worker.handle, { method: "POST", url: "/cron/reminders" });
      expect(res.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      const res2 = await inject(worker.handle, { method: "POST", url: "/cron/reminders" });
      expect(res2.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("失敗は 500。最後の再試行では 200（返信先が無いのでログだけ）", async () => {
      const { worker } = setup({ maxRetryCount: 2 });
      worker.registerJob(
        "/cron/reminders",
        async () => {
          throw new Error("boom");
        },
        { dedupe: false },
      );
      const r1 = await inject(worker.handle, { method: "POST", url: "/cron/reminders" });
      expect(r1.statusCode).toBe(500);
      const r2 = await inject(worker.handle, {
        method: "POST",
        url: "/cron/reminders",
        headers: { "x-cloudtasks-taskretrycount": "2" },
      });
      expect(r2.statusCode).toBe(200);
    });
  });
});
