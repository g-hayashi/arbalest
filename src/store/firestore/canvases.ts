import type { CollectionReference } from "@google-cloud/firestore";
import type { CanvasDoc, CanvasesRepo } from "../types.js";

export class FirestoreCanvasesRepo implements CanvasesRepo {
  constructor(
    private readonly col: CollectionReference,
    private readonly now: () => Date,
  ) {}

  async get(channelId: string): Promise<CanvasDoc | null> {
    const snap = await this.col.doc(channelId).get();
    return (snap.data() as CanvasDoc | undefined) ?? null;
  }

  async set(channelId: string, canvasId: string): Promise<CanvasDoc> {
    const doc: CanvasDoc = { channelId, canvasId, createdAt: this.now().toISOString() };
    await this.col.doc(channelId).set(doc);
    return doc;
  }
}
