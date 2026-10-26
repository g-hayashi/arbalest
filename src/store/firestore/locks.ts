import { randomUUID } from "node:crypto";
import type { CollectionReference } from "@google-cloud/firestore";
import { expireAfter } from "../ttl.js";
import type { LocksRepo } from "../types.js";
import { toDate } from "./common.js";

export class FirestoreLocksRepo implements LocksRepo {
  constructor(
    private readonly col: CollectionReference,
    private readonly now: () => Date,
  ) {}

  /** トランザクションでリースを取る（R3）。有効なリースがあれば null、取れたら所有者のトークン。 */
  async acquire(targetId: string, ttlMs: number): Promise<string | null> {
    const now = this.now();
    const ref = this.col.doc(targetId);
    return this.col.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data && toDate(data.expireAt).getTime() > now.getTime()) return null;
      const token = randomUUID();
      tx.set(ref, { token, acquiredAt: now.toISOString(), expireAt: expireAfter(now, ttlMs) });
      return token;
    });
  }

  /** トークンが一致するときだけ消す（期限切れの後に別の所有者が取ったリースを消さない）。 */
  async release(targetId: string, token: string): Promise<void> {
    const ref = this.col.doc(targetId);
    await this.col.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.token === token) tx.delete(ref);
    });
  }
}
