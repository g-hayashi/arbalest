import { DOC_TTL_MS, expireAfter } from "../ttl.js";
import {
  normalizeAnalysisState,
  type TargetDoc,
  type TargetInput,
  type TargetsRepo,
} from "../types.js";

export class MemoryTargetsRepo implements TargetsRepo {
  private readonly docs = new Map<string, TargetDoc>();

  constructor(private readonly now: () => Date) {}

  async get(targetId: string): Promise<TargetDoc | null> {
    const doc = this.docs.get(targetId);
    return doc ? structuredClone({ ...doc, state: normalizeAnalysisState(doc.state) }) : null;
  }

  async put(target: TargetInput): Promise<TargetDoc> {
    const now = this.now();
    const doc: TargetDoc = {
      ...structuredClone(target),
      state: structuredClone(normalizeAnalysisState(target.state)),
      updatedAt: now.toISOString(),
      expireAt: expireAfter(now, DOC_TTL_MS),
    };
    this.docs.set(doc.targetId, doc);
    return structuredClone(doc);
  }

  expireAtOf(id: string): Date | null {
    return this.docs.get(id)?.expireAt ?? null;
  }
}
