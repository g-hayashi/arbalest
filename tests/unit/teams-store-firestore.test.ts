import { expect, it } from "vitest";
import { COLLECTION_NAMES } from "../../src/store/firestore/index.js";
import { createFirestoreTeamsWorkStore } from "../../src/teams/store/firestore.js";
import { FakeTeamsFirestore } from "../shared/fakeTeamsFirestore.js";
import { registration, scope, start, teamsStoreContract } from "../shared/teamsStoreContract.js";

teamsStoreContract("Teams Firestore store", (now) =>
  createFirestoreTeamsWorkStore({
    firestore: new FakeTeamsFirestore().asFirestore(),
    collectionPrefix: "test_",
    now,
  }),
);

it("FirestoreはToDoとanchorを別文書にしSlackのcollection一覧へ混入しない", async () => {
  const db = new FakeTeamsFirestore();
  const store = createFirestoreTeamsWorkStore({
    firestore: db.asFirestore(),
    collectionPrefix: "test_",
    now: () => start,
  });
  await store.register(registration("a"));
  await store.register(registration("b"));
  expect(
    [...db.documents.keys()].filter((key) => key.startsWith("test_teams_todos/")),
  ).toHaveLength(2);
  expect(
    [...db.documents.keys()].filter((key) => key.startsWith("test_teams_todo_anchors/")),
  ).toHaveLength(2);
  expect([...db.documents.keys()].every((key) => key.startsWith("test_teams_"))).toBe(true);
  expect(COLLECTION_NAMES.some((name) => name.startsWith("teams_"))).toBe(false);
});

it.each([
  ["teams_records", "oversized", "snapshot_too_large"],
  ["teams_effects", "oversized", "snapshot_too_large"],
  ["teams_records", "slot", "too_large"],
  ["teams_effects", "slot", "too_large"],
  ["teams_records", "revision", "invalid_evidence"],
  ["teams_todos", "status", "invalid_evidence"],
] as const)("Firestoreの再読込で%sの%s破損を拒否", async (collection, corruption, code) => {
  const db = new FakeTeamsFirestore();
  const store = createFirestoreTeamsWorkStore({
    firestore: db.asFirestore(),
    collectionPrefix: "test_",
    now: () => start,
  });
  await store.register(registration());
  const entry = [...db.documents.entries()].find(([key]) => key.startsWith(`test_${collection}/`));
  if (!entry) throw new Error("missing document");
  const [key, value] = entry;
  const snapshot = value.snapshot as Record<string, unknown>;
  if (corruption === "oversized") snapshot.content = "あ".repeat(100_000);
  if (corruption === "slot") snapshot.slots = ["x".repeat(8001)];
  if (corruption === "revision") snapshot.revision = 0;
  if (corruption === "status") value.status = "unknown";
  db.documents.set(key, value);
  const read =
    collection === "teams_records"
      ? store.getRecord(scope)
      : collection === "teams_effects"
        ? store.getEffect(value.operationId as string)
        : store.getTodos(scope);
  await expect(read).rejects.toMatchObject({ code });
});
