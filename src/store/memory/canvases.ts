import type { CanvasDoc, CanvasesRepo } from "../types.js";

export class MemoryCanvasesRepo implements CanvasesRepo {
  private readonly docs = new Map<string, CanvasDoc>();

  constructor(private readonly now: () => Date) {}

  async get(channelId: string): Promise<CanvasDoc | null> {
    const doc = this.docs.get(channelId);
    return doc ? { ...doc } : null;
  }

  async set(channelId: string, canvasId: string): Promise<CanvasDoc> {
    const doc: CanvasDoc = { channelId, canvasId, createdAt: this.now().toISOString() };
    this.docs.set(channelId, doc);
    return { ...doc };
  }
}
