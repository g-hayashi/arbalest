import type { WebClient } from "@slack/web-api";
import { NO_UNFURL } from "../slack/unfurl.js";
import type { IngressSlack } from "./dispatch.js";

/** WebClient を IngressSlack に包む（本番用）。 */
export function createIngressSlack(web: Pick<WebClient, "reactions" | "chat">): IngressSlack {
  return {
    async addReaction(channel, timestamp, name) {
      await web.reactions.add({ channel, timestamp, name });
    },
    async postMessage(channel, threadTs, text) {
      await web.chat.postMessage({ channel, thread_ts: threadTs, text, ...NO_UNFURL });
    },
  };
}
