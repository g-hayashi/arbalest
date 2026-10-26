import { createHmac } from "node:crypto";
import { LogLevel } from "@slack/bolt";
import inject from "light-my-request";
import { describe, expect, it } from "vitest";
import { createIngressApp } from "../../src/ingress/app.js";
import { type IngressDeps, USAGE_TEXT } from "../../src/ingress/dispatch.js";
import type { EnqueueRequest } from "../../src/tasks/enqueue.js";

// 署名は SLACK_SIGNING_SECRET で計算する（Slack と同じ v0 方式）。実際の値ではなくテスト用の文字列。
const SECRET = "test-signing-secret";

function sign(body: string, ts: string, secret = SECRET): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
}

function setup(opts: { enqueueFails?: boolean } = {}) {
  const enqueued: EnqueueRequest[] = [];
  const reactions: string[] = [];
  const deps: IngressDeps = {
    botUserId: "UBOT",
    now: () => new Date("2025-10-24T05:03:00.000Z"),
    slack: {
      async addReaction(_c, _ts, name) {
        reactions.push(name);
      },
      async postMessage() {},
    },
    async enqueue(req) {
      if (opts.enqueueFails) throw new Error("tasks down");
      enqueued.push(req);
      return { created: true };
    },
  };
  const { receiver } = createIngressApp({
    signingSecret: SECRET,
    botToken: "xoxb-test-token",
    deps,
    logLevel: LogLevel.ERROR,
  });
  return { app: receiver.app, enqueued, reactions };
}

type App = ReturnType<typeof setup>["app"];

function post(
  app: App,
  body: string,
  contentType: string,
  opts: { signature?: string; timestamp?: string } = {},
) {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  return inject(app, {
    method: "POST",
    url: "/slack/events",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": opts.signature ?? sign(body, timestamp),
    },
    payload: body,
  });
}

const eventBody = (event: Record<string, unknown>, eventId = "Ev1") =>
  JSON.stringify({
    type: "event_callback",
    token: "unused",
    team_id: "T1",
    api_app_id: "A1",
    event_id: eventId,
    event_time: 1729746200,
    event,
    authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
  });

const mentionEvent = {
  type: "app_mention",
  user: "U1",
  channel: "C1",
  ts: "1729746200.000100",
  event_ts: "1729746200.000100",
  text: "<@UBOT> まとめ",
};

describe("メンションの使い方案内", () => {
  it("空メンション、自然文、抑止、実行結果と旧コマンドを案内する", () => {
    for (const text of [
      "メンションだけ",
      "根拠付きの概要",
      "取得件数・時刻範囲",
      "未完了",
      "担当者と根拠を確認できた ToDo",
      "canvas",
      "登録件数・要確認・canvas の結果",
      "見るだけ",
      "登録しないでまとめて",
      "直近7日",
      "返信のみ",
      "先週の動きを振り返って",
      "この2週間の学びは？",
      "JST",
      "月曜0時",
      "月初",
      "既定30日・最大90日",
      "`まとめ`（`summary`、`要約`）",
      "`canvas`（`キャンバス`）",
      "`todo`（`タスク`）",
      "`findings 30日`（`振り返り 14日`）",
    ]) {
      expect(USAGE_TEXT).toContain(text);
    }
    expect(USAGE_TEXT).not.toContain("メンションに続けてコマンドを書いてください");
  });
});

describe("ingress（署名の検証、FR-006）", () => {
  it("url_verification に答える", async () => {
    const { app } = setup();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" });
    const res = await post(app, body, "application/json");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("abc123");
  });

  it("署名の正しい app_mention は受け付け、タスクを積んで 200 を返す", async () => {
    const { app, enqueued, reactions } = setup();
    const res = await post(app, eventBody(mentionEvent), "application/json");
    expect(res.statusCode).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.path).toBe("/jobs/summarize");
    expect(enqueued[0]?.name).toBe("evt-Ev1");
    expect(reactions).toEqual(["eyes"]);
  });

  it.each(["<@UBOT>", "<@UBOT> この2週間の学びは？"])(
    "空と自然文も署名検証後に worker へ渡す: %s",
    async (text) => {
      const { app, enqueued, reactions } = setup();
      const res = await post(app, eventBody({ ...mentionEvent, text }), "application/json");
      expect(res.statusCode).toBe(200);
      expect(enqueued[0]?.path).toBe("/jobs/request");
      expect(enqueued[0]?.payload).toMatchObject({
        command: "request",
        requestText: text.replace("<@UBOT>", "").normalize("NFKC").trim(),
      });
      expect(reactions).toEqual(["eyes"]);
    },
  );

  it("署名の不正なものは 401 で、タスクを積まない", async () => {
    const { app, enqueued } = setup();
    const body = eventBody(mentionEvent);
    const res = await post(app, body, "application/json", {
      signature: sign(body, String(Math.floor(Date.now() / 1000)), "wrong-secret"),
    });
    expect(res.statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("本文を改ざんしたものは 401", async () => {
    const { app, enqueued } = setup();
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign(eventBody(mentionEvent), ts);
    const res = await post(app, eventBody(mentionEvent, "EvTampered"), "application/json", {
      signature,
      timestamp: ts,
    });
    expect(res.statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("署名のヘッダが無いものは 401", async () => {
    const { app, enqueued } = setup();
    const res = await inject(app, {
      method: "POST",
      url: "/slack/events",
      headers: { "content-type": "application/json" },
      payload: eventBody(mentionEvent),
    });
    expect(res.statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("古いタイムスタンプ（リプレイ）は 401", async () => {
    const { app, enqueued } = setup();
    const body = eventBody(mentionEvent);
    const old = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const res = await post(app, body, "application/json", { timestamp: old });
    expect(res.statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("タスクを積めなかったら 5xx（Slack に再送させる）", async () => {
    const { app } = setup({ enqueueFails: true });
    const res = await post(app, eventBody(mentionEvent), "application/json");
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it("✅ の reaction_added は /jobs/todo-done に積む", async () => {
    const { app, enqueued } = setup();
    const body = eventBody(
      {
        type: "reaction_added",
        user: "U2",
        reaction: "white_check_mark",
        item: { type: "message", channel: "C1", ts: "1729746180.123456" },
        event_ts: "1729746300.000300",
      },
      "Ev2",
    );
    const res = await post(app, body, "application/json");
    expect(res.statusCode).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.path).toBe("/jobs/todo-done");
    expect(enqueued[0]?.name).toBe("evt-Ev2");
  });

  it("block_actions（todo_done）は /jobs/todo-done に積み、200 を返す", async () => {
    const { app, enqueued } = setup();
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U3" },
      channel: { id: "D1" },
      container: { type: "message", channel_id: "D1" },
      actions: [
        {
          type: "button",
          action_id: "todo_done",
          block_id: "b1",
          value: "t_C1_1_k1",
          action_ts: "1729746300.000200",
        },
      ],
    });
    const body = `payload=${encodeURIComponent(payload)}`;
    const res = await post(app, body, "application/x-www-form-urlencoded");
    expect(res.statusCode).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.name).toBe("act-1729746300-000200-U3");
    expect(enqueued[0]?.path).toBe("/jobs/todo-done");
  });

  it("block_actions（canvas_open の URL ボタン）は何も積まず、200 を返す", async () => {
    const { app, enqueued } = setup();
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U3" },
      channel: { id: "C1" },
      container: { type: "message", channel_id: "C1" },
      actions: [
        {
          type: "button",
          action_id: "canvas_open",
          block_id: "b1",
          url: "https://example.slack.com/docs/T1/F1",
          action_ts: "1729746300.000200",
        },
      ],
    });
    const body = `payload=${encodeURIComponent(payload)}`;
    const res = await post(app, body, "application/x-www-form-urlencoded");
    expect(res.statusCode).toBe(200);
    expect(enqueued).toHaveLength(0);
  });

  it("GET /healthz は 200 ok", async () => {
    const { app } = setup();
    const res = await inject(app, { method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
  });
});
