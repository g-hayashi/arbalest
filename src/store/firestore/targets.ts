import type { CollectionReference } from "@google-cloud/firestore";
import { DOC_TTL_MS, expireAfter } from "../ttl.js";
import {
  normalizeAnalysisState,
  type TargetDoc,
  type TargetInput,
  type TargetsRepo,
} from "../types.js";
import { withExpireAtAsDate } from "./common.js";

export class FirestoreTargetsRepo implements TargetsRepo {
  constructor(
    private readonly col: CollectionReference,
    private readonly now: () => Date,
  ) {}

  async get(targetId: string): Promise<TargetDoc | null> {
    const snap = await this.col.doc(targetId).get();
    const data = snap.data();
    if (!data) return null;
    const doc = withExpireAtAsDate<TargetDoc>(data);
    return { ...doc, state: normalizeAnalysisState(doc.state) };
  }

  async put(target: TargetInput): Promise<TargetDoc> {
    const now = this.now();
    const doc: TargetDoc = {
      ...target,
      state: normalizeAnalysisState(target.state),
      updatedAt: now.toISOString(),
      expireAt: expireAfter(now, DOC_TTL_MS),
    };
    await this.col.doc(target.targetId).set(doc);
    return doc;
  }
}
