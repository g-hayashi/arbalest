import type { TeamsBackend, TeamsTransaction } from "./backend.js";
import { createTeamsWorkStore } from "./common.js";
import type { TeamsWorkStore, TeamsWorkStoreOptions } from "./types.js";

export function createMemoryTeamsWorkStore(options: TeamsWorkStoreOptions = {}): TeamsWorkStore {
  let documents = new Map<string, unknown>();
  let tail = Promise.resolve();
  const backend: TeamsBackend = {
    async run<T>(body: (tx: TeamsTransaction) => Promise<T>): Promise<T> {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const next = structuredClone(documents);
      const tx: TeamsTransaction = {
        async get<T>(collection: string, id: string) {
          return structuredClone(next.get(`${collection}/${id}`) ?? null) as T | null;
        },
        async list<T>(collection: string, targetId?: string) {
          return [...next.entries()]
            .filter(
              ([key, value]) =>
                key.startsWith(`${collection}/`) &&
                (targetId === undefined || (value as { targetId: string }).targetId === targetId),
            )
            .map(([, value]) => structuredClone(value) as T);
        },
        set(collection, id, value) {
          next.set(`${collection}/${id}`, structuredClone(value));
        },
      };
      try {
        const result = await body(tx);
        documents = next;
        return structuredClone(result);
      } finally {
        release();
      }
    },
  };
  return createTeamsWorkStore(backend, options);
}
