import { Firestore } from "@google-cloud/firestore";
import type { CollectionName, Store } from "../types.js";
import { FirestoreCanvasesRepo } from "./canvases.js";
import { FirestoreChunkCacheRepo } from "./chunkCache.js";
import { FirestoreEventsRepo } from "./events.js";
import { FirestoreLocksRepo } from "./locks.js";
import { FirestoreTargetsRepo } from "./targets.js";
import { FirestoreTodosRepo } from "./todos.js";

export type FirestoreStoreOptions = {
  /** `(default)` か、テスト用なら `arbalest-test`。 */
  databaseId: string;
  /** コレクション名の接頭辞。本番は空文字、テストは `t<日時>_<乱数>_`（R9）。 */
  collectionPrefix: string;
  /** 省略すると ADC から決まるプロジェクトを使う。 */
  projectId?: string;
  /** すでにある接続を共有したいとき。 */
  firestore?: Firestore;
  /** テストで時刻を固定するため。省略すると現在時刻。 */
  now?: () => Date;
};

export const COLLECTION_NAMES: readonly CollectionName[] = [
  "targets",
  "todos",
  "canvases",
  "chunk_cache",
  "processed_events",
  "job_locks",
];

export class FirestoreStore implements Store {
  readonly db: Firestore;
  readonly databaseId: string;
  readonly collectionPrefix: string;
  readonly targets: FirestoreTargetsRepo;
  readonly todos: FirestoreTodosRepo;
  readonly canvases: FirestoreCanvasesRepo;
  readonly chunkCache: FirestoreChunkCacheRepo;
  readonly locks: FirestoreLocksRepo;
  readonly events: FirestoreEventsRepo;

  constructor(options: FirestoreStoreOptions) {
    this.databaseId = options.databaseId;
    this.collectionPrefix = options.collectionPrefix;
    this.db =
      options.firestore ??
      new Firestore({
        ...(options.projectId ? { projectId: options.projectId } : {}),
        databaseId: options.databaseId,
        // 値が undefined の欄は保存しない（null との違いを保つため、明示的に null を入れる欄だけが残る）
        ignoreUndefinedProperties: true,
      });
    const now = options.now ?? (() => new Date());
    const col = (name: CollectionName) => this.db.collection(this.collectionName(name));
    this.targets = new FirestoreTargetsRepo(col("targets"), now);
    this.todos = new FirestoreTodosRepo(col("todos"), now);
    this.canvases = new FirestoreCanvasesRepo(col("canvases"), now);
    this.chunkCache = new FirestoreChunkCacheRepo(col("chunk_cache"), now);
    this.locks = new FirestoreLocksRepo(col("job_locks"), now);
    this.events = new FirestoreEventsRepo(col("processed_events"), now);
  }

  collectionName(name: CollectionName): string {
    return `${this.collectionPrefix}${name}`;
  }

  /** この接頭辞のコレクションをすべて消す（テストの後始末用）。 */
  async deleteAll(): Promise<void> {
    await Promise.all(
      COLLECTION_NAMES.map((name) =>
        this.db.recursiveDelete(this.db.collection(this.collectionName(name))),
      ),
    );
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }
}
