import type { CollectionReference } from "@google-cloud/firestore";
import { EVENT_TTL_MS, expireAfter } from "../ttl.js";
import type { EventsRepo, RequestProgress, RequestProgressInput } from "../types.js";
import { isAlreadyExists, withExpireAtAsDate } from "./common.js";

export class FirestoreEventsRepo implements EventsRepo {
  constructor(
    private readonly col: CollectionReference,
    private readonly now: () => Date,
  ) {}

  /** `create()` は文書が既にあれば ALREADY_EXISTS で失敗する（R3）。 */
  async markProcessed(taskName: string): Promise<boolean> {
    const now = this.now();
    try {
      await this.col.doc(taskName).create({
        createdAt: now.toISOString(),
        expireAt: expireAfter(now, EVENT_TTL_MS),
      });
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  }

  async getRequestProgress(taskName: string): Promise<RequestProgress | null> {
    const data = (await this.col.doc(taskName).get()).data();
    if (data?.requestProgress === undefined) return null;
    const value = withExpireAtAsDate<RequestProgress>({
      ...data.requestProgress,
      updatedAt: data.updatedAt,
      expireAt: data.expireAt,
    });
    return value.expireAt > this.now() ? value : null;
  }

  async saveRequestProgress(
    taskName: string,
    input: RequestProgressInput,
  ): Promise<RequestProgress> {
    const ref = this.col.doc(taskName);
    return this.col.firestore.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data();
      const old = data?.requestProgress as RequestProgressInput | undefined;
      if (
        old !== undefined &&
        (old.targetId !== input.targetId ||
          old.channelId !== input.channelId ||
          old.threadTs !== input.threadTs ||
          old.mentionTs !== input.mentionTs)
      ) {
        throw new TypeError("同じ taskName の依頼対象が一致しません");
      }
      const now = this.now();
      const updatedAt = now.toISOString();
      const expireAt = expireAfter(now, EVENT_TTL_MS);
      tx.set(
        ref,
        { requestProgress: input, updatedAt, expireAt },
        { mergeFields: ["requestProgress", "updatedAt", "expireAt"] },
      );
      return { ...input, updatedAt, expireAt };
    });
  }
}
