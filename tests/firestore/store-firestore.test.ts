import { Firestore } from "@google-cloud/firestore";
import { toDate } from "../../src/store/firestore/common.js";
import { FirestoreStore } from "../../src/store/firestore/index.js";
import { assertSafeTestDatabase, newTestPrefix } from "../shared/firestoreSafety.js";
import { describeStoreContract } from "../shared/storeContract.js";

// R9: FIRESTORE_TEST_DATABASE がなければ飛ばす。(default) なら始めずに失敗させる。
// 実行は利用者が `npm run test:firestore` で行う（ADC が必要）。
const databaseId = process.env.FIRESTORE_TEST_DATABASE;
if (databaseId !== undefined && databaseId !== "") assertSafeTestDatabase(databaseId);

const enabled = databaseId !== undefined && databaseId !== "";
const stores: FirestoreStore[] = [];
let shared: Firestore | undefined;

function sharedFirestore(): Firestore {
  shared ??= new Firestore({
    ...(process.env.GCP_PROJECT ? { projectId: process.env.GCP_PROJECT } : {}),
    databaseId: databaseId as string,
    ignoreUndefinedProperties: true,
  });
  return shared;
}

describeStoreContract(
  "Firestore",
  async (now) => {
    // テストごとに別の接頭辞にして、前のテストのデータが混ざらないようにする。
    const store = new FirestoreStore({
      databaseId: databaseId as string,
      collectionPrefix: newTestPrefix(),
      firestore: sharedFirestore(),
      now,
    });
    stores.push(store);
    return {
      store,
      expireAtOf: async (collection, id) => {
        const snap = await store.db.collection(store.collectionName(collection)).doc(id).get();
        const data = snap.data();
        return data ? toDate(data.expireAt) : null;
      },
    };
  },
  {
    skip: !enabled,
    afterAll: async () => {
      // 自分が作った接頭辞のデータだけを消す。
      await Promise.all(stores.map((s) => s.deleteAll()));
      stores.length = 0;
      await shared?.terminate();
      shared = undefined;
    },
  },
);
