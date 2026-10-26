import { EVENT_TTL_MS, expireAfter } from "../ttl.js";
import type { EventsRepo, RequestProgress, RequestProgressInput } from "../types.js";

export class MemoryEventsRepo implements EventsRepo {
  private readonly docs = new Map<string, Date>();
  private readonly progress = new Map<string, RequestProgress>();

  constructor(private readonly now: () => Date) {}

  async markProcessed(taskName: string): Promise<boolean> {
    if (this.docs.has(taskName)) return false;
    this.docs.set(taskName, expireAfter(this.now(), EVENT_TTL_MS));
    return true;
  }

  async getRequestProgress(taskName: string): Promise<RequestProgress | null> {
    const value = this.progress.get(taskName);
    return value !== undefined && value.expireAt > this.now() ? structuredClone(value) : null;
  }

  async saveRequestProgress(
    taskName: string,
    input: RequestProgressInput,
  ): Promise<RequestProgress> {
    const old = this.progress.get(taskName);
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
    const value = {
      ...structuredClone(input),
      updatedAt: now.toISOString(),
      expireAt: expireAfter(now, EVENT_TTL_MS),
    };
    this.progress.set(taskName, value);
    this.docs.set(taskName, value.expireAt);
    return structuredClone(value);
  }

  expireAtOf(id: string): Date | null {
    return this.docs.get(id) ?? null;
  }
}
