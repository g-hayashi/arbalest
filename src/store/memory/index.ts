import type { CollectionName, Store } from "../types.js";
import { MemoryCanvasesRepo } from "./canvases.js";
import { MemoryChunkCacheRepo } from "./chunkCache.js";
import { MemoryEventsRepo } from "./events.js";
import { MemoryLocksRepo } from "./locks.js";
import { MemoryTargetsRepo } from "./targets.js";
import { MemoryTodosRepo } from "./todos.js";

export type MemoryStore = Store & {
  targets: MemoryTargetsRepo;
  todos: MemoryTodosRepo;
  canvases: MemoryCanvasesRepo;
  chunkCache: MemoryChunkCacheRepo;
  locks: MemoryLocksRepo;
  events: MemoryEventsRepo;
  /** TTL の欄の値を読む（テスト用）。canvases は TTL を持たないので常に null。 */
  expireAtOf(collection: CollectionName, id: string): Date | null;
};

/** メモリのストア。時刻はテストで固定できるよう `now` を注入できる。 */
export function createMemoryStore(options: { now?: () => Date } = {}): MemoryStore {
  const now = options.now ?? (() => new Date());
  const targets = new MemoryTargetsRepo(now);
  const todos = new MemoryTodosRepo(now);
  const canvases = new MemoryCanvasesRepo(now);
  const chunkCache = new MemoryChunkCacheRepo(now);
  const locks = new MemoryLocksRepo(now);
  const events = new MemoryEventsRepo(now);
  return {
    targets,
    todos,
    canvases,
    chunkCache,
    locks,
    events,
    expireAtOf(collection, id) {
      switch (collection) {
        case "targets":
          return targets.expireAtOf(id);
        case "todos":
          return todos.expireAtOf(id);
        case "chunk_cache":
          return chunkCache.expireAtOf(id);
        case "processed_events":
          return events.expireAtOf(id);
        case "job_locks":
          return locks.expireAtOf(id);
        case "canvases":
          return null;
      }
    },
  };
}
