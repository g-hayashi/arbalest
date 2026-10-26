import { randomUUID } from "node:crypto";
import { expireAfter } from "../ttl.js";
import type { LocksRepo } from "../types.js";

type Lease = { token: string; expireAt: Date };

export class MemoryLocksRepo implements LocksRepo {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly now: () => Date) {}

  async acquire(targetId: string, ttlMs: number): Promise<string | null> {
    const now = this.now();
    const current = this.leases.get(targetId);
    if (current && current.expireAt.getTime() > now.getTime()) return null;
    const token = randomUUID();
    this.leases.set(targetId, { token, expireAt: expireAfter(now, ttlMs) });
    return token;
  }

  async release(targetId: string, token: string): Promise<void> {
    if (this.leases.get(targetId)?.token === token) this.leases.delete(targetId);
  }

  expireAtOf(id: string): Date | null {
    return this.leases.get(id)?.expireAt ?? null;
  }
}
