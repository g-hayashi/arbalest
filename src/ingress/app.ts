/**
 * ingress の Bolt アプリ（R2）。ExpressReceiver に processBeforeResponse: true を指定し、
 * ハンドラの中でタスクを積み終えてから ack する。署名の検証は Bolt に任せる（不正なら 401）。
 */
import { App, ExpressReceiver, type LogLevel } from "@slack/bolt";
import { CANVAS_OPEN_ACTION_ID } from "../jobs/types.js";
import {
  dispatchAppMention,
  dispatchBlockActions,
  dispatchReactionAdded,
  type IngressDeps,
} from "./dispatch.js";

export type IngressAppOptions = {
  /** SLACK_SIGNING_SECRET */
  signingSecret: string;
  /** SLACK_BOT_TOKEN */
  botToken: string;
  /** auth.test の bot_id。bot_message の自己判定にだけ使う。無ければ botUserId で代用する。 */
  botId?: string;
  deps: IngressDeps;
  logLevel?: LogLevel;
};

export function createIngressApp(options: IngressAppOptions): {
  app: App;
  receiver: ExpressReceiver;
} {
  const { deps } = options;
  const receiver = new ExpressReceiver({
    signingSecret: options.signingSecret,
    processBeforeResponse: true,
    logLevel: options.logLevel,
  });
  const app = new App({
    // token ではなく authorize を渡す。token だと Bolt が最初のイベントで auth.test を呼ぶため。
    // botUserId は起動時に取って deps に渡してある。ingress は Bolt の client を使わない（deps.slack を使う）。
    authorize: async () => ({
      botToken: options.botToken,
      botUserId: deps.botUserId,
      botId: options.botId ?? deps.botUserId,
    }),
    receiver,
    logLevel: options.logLevel,
  });

  receiver.app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });

  app.event("app_mention", async ({ event, body }) => {
    await dispatchAppMention(event, { event_id: body.event_id, team_id: body.team_id }, deps);
  });

  app.event("reaction_added", async ({ event, body }) => {
    await dispatchReactionAdded(event, { event_id: body.event_id, team_id: body.team_id }, deps);
  });

  app.action("todo_done", async ({ ack, body }) => {
    await dispatchBlockActions(body as unknown as Parameters<typeof dispatchBlockActions>[0], deps);
    await ack();
  });

  // canvas を開く URL ボタン。押したときの block_actions には ack だけ返す（未知の action として 404 にしない）。
  app.action(CANVAS_OPEN_ACTION_ID, async ({ ack }) => {
    await ack();
  });

  // 積めなかったときは Bolt の既定（ログだけ）にせず、投げ直して 5xx にする。Slack が再送する。
  app.error(async (error) => {
    throw error;
  });

  return { app, receiver };
}
