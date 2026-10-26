import { DOC_TTL_MS, expireAfter } from "../ttl.js";
import type { ChunkCacheRepo } from "../types.js";

export class MemoryChunkCacheRepo implements ChunkCacheRepo {
  private readonly docs = new Map<string, { value: unknown[]; expireAt: Date }>();

  constructor(private readonly now: () => Date) {}

  async get(key: string): Promise<unknown[] | null> {
    const doc = this.docs.get(key);
    return doc ? structuredClone(doc.value) : null;
  }

  async put(key: string, value: unknown[]): Promise<void> {
    this.docs.set(key, {
      value: structuredClone(value),
      expireAt: expireAfter(this.now(), DOC_TTL_MS),
    });
  }

  expireAtOf(id: string): Date | null {
    return this.docs.get(id)?.expireAt ?? null;
  }
}
