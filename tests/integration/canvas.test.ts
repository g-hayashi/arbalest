/**
 * canvas への書き出し（T026）。US3 のシナリオ 1〜3、FR-030〜032、SC-008。
 * フェイクの Slack（canvas 含む）と LLM、メモリのストアを使う。
 */
import inject from "light-my-request";
import { describe, expect, it, vi } from "vitest";
import type { SummarizePatch } from "../../src/analysis/schemas.js";
import { JOB_PATHS, type JobPayload } from "../../src/jobs/types.js";
import { createFakeLlmProvider, LlmError, type LlmRequest } from "../../src/llm/index.js";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { dateToTs } from "../../src/util/time.js";
import { CANVAS_IN_CHANNEL_TEXT, canvasJob } from "../../src/worker/jobs/canvas.js";
import { createWorker, FILTERED_TEXT, type JobContext } from "../../src/worker/server.js";
import { createFakeCanvas, type FakeCanvasOptions } from "../shared/fakeCanvas.js";
import { createFakeSlack } from "../shared/fakeSlack.js";

/** 2026-10-23(金) 18:00 JST */
const NOW = new Date(Date.UTC(2026, 9, 23, 9, 0, 0));
const jst = (h: number, m: number) => dateToTs(new Date(Date.UTC(2026, 9, 23, h - 9, m, 0)));

const TANAKA = "U0TANAKA";
const SATO = "U0SATO";
const SUZUKI = "U0SUZUKI";
const NAMES = new Map([
  [TANAKA, "田中"],
  [SATO, "佐藤"],
  [SUZUKI, "鈴木"],
]);

const CHANNEL = "C1";
const T_A = jst(10, 0);
const T_B = jst(11, 0);
const markerOf = (ts: string) => `〔arb:${ts}〕`;
const targetIdOf = (ts: string) => `t_${CHANNEL}_${ts.replace(".", "-")}`;

const EMPTY_PATCH: SummarizePatch = {
  overview: [],
  topics: [],
  responses: [],
  statements: [],
  todos: [],
  questions: [],
  close: [],
};

function mid(input: string, snippet: string): string {
  const line = input.split("\n").find((l) => /^\[m\d+\]/.test(l) && l.includes(snippet));
  const id = line === undefined ? undefined : /^\[(m\d+)\]/.exec(line)?.[1];
  if (id === undefined) throw new Error(`メッセージがありません: ${snippet}`);
  return id;
}

function pid(input: string, name: string): string {
  const line = /^participants: (.*)$/m.exec(input)?.[1] ?? "";
  const found = line
    .split(" ")
    .find((s) => s.endsWith(`=${name}`))
    ?.split("=")[0];
  if (found === undefined) throw new Error(`参加者がいません: ${name}`);
  return found;
}

const todo = (
  req: LlmRequest<unknown>,
  snippet: string,
  text: string,
  assignee: string | null,
): SummarizePatch["todos"][number] => ({
  ref: null,
  evidence: [mid(req.input, snippet)],
  quote: snippet,
  text,
  assignee: assignee === null ? null : pid(req.input, assignee),
  due_iso: null,
  due_text: null,
  certainty: "explicit",
});

/** スレッド A の初回: 会議室の予約（田中）。追加の発言（印刷）があれば 資料の印刷。スレッド B: 別件。 */
const handler = (req: LlmRequest<unknown>): SummarizePatch => {
  if (req.input.includes("別件")) {
    return {
      ...EMPTY_PATCH,
      todos: [todo(req, "別件の準備をお願いします", "別件を準備する", "佐藤")],
    };
  }
  if (req.input.includes("印刷")) {
    return {
      ...EMPTY_PATCH,
      todos: [todo(req, "資料の印刷をお願いします", "資料を印刷する", null)],
    };
  }
  return {
    ...EMPTY_PATCH,
    todos: [todo(req, "会議室を予約してください", "会議室を予約する", "田中")],
  };
};

const threadA = () => [
  {
    ts: T_A,
    user: SUZUKI,
    text: "田中さん、会議室を予約してください",
    thread_ts: T_A,
    reply_count: 1,
  },
  { ts: jst(10, 10), user: TANAKA, text: "了解です", thread_ts: T_A },
];
const threadB = () => [
  {
    ts: T_B,
    user: SATO,
    text: "佐藤さん、別件の準備をお願いします",
    thread_ts: T_B,
    reply_count: 1,
  },
  { ts: jst(11, 10), user: SATO, text: "はい", thread_ts: T_B },
];

const payload = (over: Partial<JobPayload> = {}): JobPayload => ({
  taskName: "evt-1",
  command: "canvas",
  teamId: "T1",
  channelId: CHANNEL,
  threadTs: T_A,
  mentionTs: T_A,
  userId: SATO,
  requestedAt: NOW.toISOString(),
  ...over,
});

function setup(
  options: {
    canvas?: FakeCanvasOptions;
    handler?: (req: LlmRequest<unknown>) => SummarizePatch;
  } = {},
) {
  const canvas = createFakeCanvas(options.canvas);
  const store = createMemoryStore({ now: () => NOW });
  const slack = createFakeSlack(NAMES, { canvas });
  slack.setThread(T_A, threadA());
  slack.setThread(T_B, threadB());
  const llm = createFakeLlmProvider({ summarize_patch: options.handler ?? handler });
  const ctx: JobContext = {
    slack: slack.client,
    store,
    llm,
    now: () => NOW,
    log: vi.fn() as unknown as JobContext["log"],
  };
  return { canvas, store, slack, llm, ctx };
}

const headers = (c: ReturnType<typeof createFakeCanvas>) =>
  c.blocks().filter((b) => b.kind === "header");

describe("canvas への書き出し（US3 シナリオ 1）", () => {
  it("チャネル canvas を作り、そのスレッドの節を書き、スレッドに canvas へのリンクを返信する", async () => {
    const h = setup();
    await canvasJob(payload(), h.ctx);

    expect(h.canvas.canvasId()).toBe("F0CANVAS1");
    expect(h.canvas.calls.creates).toBe(1);
    const blocks = h.canvas.blocks();
    expect(blocks.map((b) => b.kind)).toEqual(["header", "text"]);
    expect(blocks[0]?.text).toContain(markerOf(T_A));
    expect(blocks[0]?.text).toContain("調整:");
    expect(blocks[1]?.text).toContain(markerOf(T_A));
    expect(blocks[1]?.text).toContain("☐ 会議室を予約する — ![](@U0TANAKA)");
    expect(blocks[1]?.text).toContain(`![](@${SATO})`); // 呼んだ人

    // スレッドに 1 件だけ返信（リンク付き）。宛先は payload の mentionTs
    expect(h.slack.posts).toHaveLength(1);
    const post = h.slack.posts[0];
    expect(post).toMatchObject({ channel: CHANNEL, thread_ts: T_A });
    // リンクは本文ではなく URL ボタンにする（本文に URL を置くと canvas のプレビューが展開される）
    expect(post?.text).not.toContain("https://");
    expect(h.slack.allText()).not.toContain("https://");
    expect(h.slack.buttons()).toEqual([
      expect.objectContaining({
        postIndex: 0,
        label: "canvas を開く",
        actionId: "canvas_open",
        url: expect.stringContaining("F0CANVAS1"),
      }),
    ]);
    expect(post).toMatchObject({ unfurl_links: false, unfurl_media: false });

    // targets に目印を保存、canvases に ID を保存
    expect((await h.store.targets.get(targetIdOf(T_A)))?.canvasSectionMarker).toBe(markerOf(T_A));
    expect((await h.store.canvases.get(CHANNEL))?.canvasId).toBe("F0CANVAS1");
  });

  it("files.info が使えなくても、ワークスペースの URL から canvas へのリンクを作る", async () => {
    const h = setup({ canvas: { filesInfoFails: true } });
    await canvasJob(payload(), h.ctx);
    expect(h.slack.buttons().map((b) => b.url)).toEqual([
      "https://example.slack.com/docs/T1/F0CANVAS1",
    ]);
    expect(h.slack.allText()).not.toContain("https://");
  });
});

describe("canvas の再実行（US3 シナリオ 2・3、SC-008）", () => {
  it("同じスレッドの再実行では、節が増えずに最新のまとめで置き換わる。他の節と人の書いた内容は変わらない", async () => {
    const h = setup();
    h.canvas.humanAppend("# 人のメモ\n\n人が書いた段落");
    await canvasJob(payload({ taskName: "a1" }), h.ctx);
    await canvasJob(
      payload({ taskName: "b1", threadTs: T_B, mentionTs: T_B, userId: TANAKA }),
      h.ctx,
    );
    h.canvas.humanAppend("あとから人が書いた段落");
    expect(headers(h.canvas)).toHaveLength(3); // 人のメモ + A + B
    const before = h.canvas.blocks();
    const sectionB = before.filter((b) => b.text.includes(markerOf(T_B)));

    // 会話が進んだ後に A を再実行
    h.slack.setThread(T_A, [
      ...threadA(),
      { ts: jst(10, 30), user: SUZUKI, text: "資料の印刷をお願いします", thread_ts: T_A },
    ]);
    await canvasJob(payload({ taskName: "a2", mentionTs: jst(17, 0) }), h.ctx);

    const text = h.canvas.text();
    expect(headers(h.canvas)).toHaveLength(3);
    expect(h.canvas.blocks()).toHaveLength(before.length);
    // A の節は最新に
    expect(text).toContain("☐ 資料を印刷する");
    expect(text).toContain("☐ 会議室を予約する");
    // 目印は節ごとに見出しと本文の 1 回ずつ
    expect(text.split(markerOf(T_A)).length - 1).toBe(2);
    // B の節と人の書いた内容は、そのまま
    expect(h.canvas.blocks().filter((b) => b.text.includes(markerOf(T_B)))).toEqual(sectionB);
    expect(text).toContain("人が書いた段落");
    expect(text).toContain("あとから人が書いた段落");
    // 作り直さず、返信は毎回 1 件
    expect(h.canvas.calls.creates).toBe(1);
    expect(h.slack.posts).toHaveLength(3);
  });

  it("同じスレッドを何度呼んでも、節は 1 つのまま（SC-008）", async () => {
    const h = setup();
    for (let i = 0; i < 4; i++) {
      await canvasJob(payload({ taskName: `a${i}`, mentionTs: jst(17, i) }), h.ctx);
    }
    expect(h.canvas.blocks()).toHaveLength(2);
    expect(headers(h.canvas)).toHaveLength(1);
  });

  it("別のスレッドは別の節になる", async () => {
    const h = setup();
    await canvasJob(payload(), h.ctx);
    await canvasJob(payload({ taskName: "b1", threadTs: T_B, mentionTs: T_B }), h.ctx);

    expect(headers(h.canvas)).toHaveLength(2);
    expect(h.canvas.text()).toContain("☐ 別件を準備する");
    expect(h.canvas.text()).toContain("☐ 会議室を予約する");
    expect(h.canvas.calls.creates).toBe(1);
    expect((await h.store.targets.get(targetIdOf(T_B)))?.canvasSectionMarker).toBe(markerOf(T_B));
    // それぞれのスレッドに返信
    expect(h.slack.posts.map((p) => p.thread_ts)).toEqual([T_A, T_B]);
  });

  it("既にチャネル canvas があれば、作らずにそれを使う", async () => {
    const h = setup({ canvas: { existingCanvasId: "FEXIST" } });
    await canvasJob(payload(), h.ctx);
    expect(h.canvas.calls.creates).toBe(0);
    expect(h.slack.buttons()[0]?.url).toContain("FEXIST");
    expect(h.slack.posts[0]?.text).not.toContain("FEXIST");
  });
});

describe("canvas のその他の経路", () => {
  it("チャネルで直接呼ばれたら、スレッドの中で呼ぶよう案内する（AI も canvas も使わない）", async () => {
    const h = setup();
    await canvasJob(payload({ threadTs: null, mentionTs: jst(17, 0) }), h.ctx);

    expect(h.slack.posts).toHaveLength(1);
    expect(h.slack.posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: jst(17, 0) });
    expect(h.slack.posts[0]?.text).toBe(CANVAS_IN_CHANNEL_TEXT);
    expect(h.llm.calls).toHaveLength(0);
    expect(h.canvas.calls.creates).toBe(0);
    expect(h.canvas.calls.edits).toHaveLength(0);
  });

  it("AI の安全フィルタに該当したら、その旨を返信し、canvas には書かない", async () => {
    const h = setup({
      handler: () => {
        throw new LlmError("content_filter", "filtered");
      },
    });
    await expect(canvasJob(payload(), h.ctx)).resolves.toBeUndefined();
    expect(h.slack.posts).toHaveLength(1);
    expect(h.slack.posts[0]?.text).toBe(FILTERED_TEXT);
    expect(h.canvas.calls.edits).toHaveLength(0);
    expect(h.canvas.calls.creates).toBe(0);
  });

  it("安全フィルタ以外の AI の失敗は、そのまま投げる", async () => {
    const h = setup({
      handler: () => {
        throw new LlmError("timeout", "timeout");
      },
    });
    await expect(canvasJob(payload(), h.ctx)).rejects.toThrow("timeout");
    expect(h.slack.posts).toHaveLength(0);
    expect(h.canvas.calls.edits).toHaveLength(0);
  });

  it("/jobs/canvas が worker に登録でき、スレッドのロックの下で動く", async () => {
    const h = setup();
    const worker = createWorker({
      slack: h.slack.client,
      store: h.store,
      llm: h.llm,
      now: () => NOW,
    });
    worker.registerJob<JobPayload>(JOB_PATHS.canvas, canvasJob);

    const res = await inject(worker.handle, {
      method: "POST",
      url: JOB_PATHS.canvas,
      payload: payload(),
    });
    expect(res.statusCode).toBe(200);
    expect(headers(h.canvas)).toHaveLength(1);
    expect(h.slack.posts).toHaveLength(1);
  });
});
