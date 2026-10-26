import type { CollectionReference } from "@google-cloud/firestore";
import { DOC_TTL_MS, expireAfter } from "../ttl.js";
import type { ChunkCacheRepo } from "../types.js";

export class FirestoreChunkCacheRepo implements ChunkCacheRepo {
  constructor(
    private readonly col: CollectionReference,
    private readonly now: () => Date,
  ) {}

  async get(key: string): Promise<unknown[] | null> {
    const snap = await this.col.doc(key).get();
    const data = snap.data();
    return data ? (data.value as unknown[]) : null;
  }

  async put(key: string, value: unknown[]): Promise<void> {
    const now = this.now();
    await this.col.doc(key).set({
      value,
      createdAt: now.toISOString(),
      expireAt: expireAfter(now, DOC_TTL_MS),
    });
  }
}
