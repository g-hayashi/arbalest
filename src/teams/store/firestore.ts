import type { Firestore } from "@google-cloud/firestore";
import type { TeamsBackend, TeamsCollection, TeamsTransaction } from "./backend.js";
import { createTeamsWorkStore } from "./common.js";
import type { TeamsWorkStore, TeamsWorkStoreOptions } from "./types.js";

/** 接続は起動側から注入する。資格情報取得や実DB生成はここでは行わない。 */
export function createFirestoreTeamsWorkStore(
  options: TeamsWorkStoreOptions & { firestore: Firestore; collectionPrefix: string },
): TeamsWorkStore {
  const { firestore, collectionPrefix } = options;
  if (collectionPrefix.includes("/")) throw new TypeError("Invalid collection prefix");
  const col = (name: TeamsCollection) => firestore.collection(`${collectionPrefix}${name}`);
  const backend: TeamsBackend = {
    run: (body) =>
      firestore.runTransaction(async (transaction) => {
        // SDKの「全readの後にwrite」を維持する。業務処理内のread-your-writesも提供する。
        const writes = new Map<
          string,
          { collection: TeamsCollection; id: string; value: unknown }
        >();
        const tx: TeamsTransaction = {
          async get<T>(collection: TeamsCollection, id: string) {
            const pending = writes.get(`${collection}/${id}`);
            if (pending) return structuredClone(pending.value) as T;
            const snapshot = await transaction.get(col(collection).doc(id));
            return snapshot.exists ? (decode(snapshot.data()) as T) : null;
          },
          async list<T>(collection: TeamsCollection, targetId?: string) {
            const query =
              targetId === undefined
                ? col(collection)
                : col(collection).where("targetId", "==", targetId);
            const snapshot = await transaction.get(query);
            const values = new Map(snapshot.docs.map((doc) => [doc.id, decode(doc.data())]));
            for (const pending of writes.values()) {
              if (
                pending.collection === collection &&
                (targetId === undefined ||
                  (pending.value as { targetId: string }).targetId === targetId)
              )
                values.set(pending.id, structuredClone(pending.value));
            }
            return [...values.values()] as T[];
          },
          set(collection, id, value) {
            writes.set(`${collection}/${id}`, { collection, id, value: structuredClone(value) });
          },
        };
        const result = await body(tx);
        for (const write of writes.values())
          transaction.set(
            col(write.collection).doc(write.id),
            write.value as Record<string, unknown>,
          );
        return structuredClone(result);
      }),
  };
  return createTeamsWorkStore(backend, options);
}

/** Firestore TimestampはTTLを含めDateへ復元し、SDK固有オブジェクトを外へ渡さない。 */
function decode(value: unknown): unknown {
  if (value instanceof Date) return new Date(value);
  if (value !== null && typeof value === "object") {
    if ("toDate" in value && typeof value.toDate === "function") return value.toDate();
    if (Array.isArray(value)) return value.map(decode);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}
