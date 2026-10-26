import type { CollectionReference } from "@google-cloud/firestore";
import { jstDateIso } from "../../util/time.js";
import { DOC_TTL_MS, expireAfter, isDueForReminder } from "../ttl.js";
import { type TodoDoc, type TodoInput, type TodosRepo, todoIdOf } from "../types.js";
import { isNotFound, withExpireAtAsDate } from "./common.js";

export class FirestoreTodosRepo implements TodosRepo {
  constructor(
    private readonly col: CollectionReference,
    private readonly now: () => Date,
  ) {}

  async get(todoId: string): Promise<TodoDoc | null> {
    const snap = await this.col.doc(todoId).get();
    const data = snap.data();
    return data ? withExpireAtAsDate<TodoDoc>(data) : null;
  }

  async upsert(input: TodoInput): Promise<TodoDoc> {
    const now = this.now();
    const todoId = todoIdOf(input.targetId, input.itemId);
    const ref = this.col.doc(todoId);
    return this.col.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      const existing = data ? withExpireAtAsDate<TodoDoc>(data) : null;
      if (existing?.status === "done") return existing;

      const doc: TodoDoc = existing
        ? {
            ...existing,
            text: input.text,
            dueIso: input.dueIso,
            dueText: input.dueText,
            assigneeUserId: input.assigneeUserId,
            listMessageTs: input.listMessageTs,
            sourceTs: [...input.sourceTs],
            updatedAt: now.toISOString(),
            expireAt: expireAfter(now, DOC_TTL_MS),
          }
        : {
            todoId,
            targetId: input.targetId,
            itemId: input.itemId,
            channelId: input.channelId,
            threadTs: input.threadTs,
            text: input.text,
            dueIso: input.dueIso,
            dueText: input.dueText,
            assigneeUserId: input.assigneeUserId,
            createdBy: input.createdBy,
            status: "open",
            listMessageTs: input.listMessageTs,
            sourceTs: [...input.sourceTs],
            lastRemindedOn: null,
            doneBy: null,
            doneAt: null,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            expireAt: expireAfter(now, DOC_TTL_MS),
          };
      tx.set(ref, doc);
      return doc;
    });
  }

  async findByMessageTs(channelId: string, messageTs: string): Promise<TodoDoc[]> {
    // channelId との複合条件は複合インデックスが要るので、ts だけで引いて channelId はコードで絞る。
    const [byList, bySource] = await Promise.all([
      this.col.where("listMessageTs", "==", messageTs).get(),
      this.col.where("sourceTs", "array-contains", messageTs).get(),
    ]);
    const found = new Map<string, TodoDoc>();
    for (const snap of [...byList.docs, ...bySource.docs]) {
      const todo = withExpireAtAsDate<TodoDoc>(snap.data());
      if (todo.channelId === channelId) found.set(todo.todoId, todo);
    }
    return [...found.values()];
  }

  async markDone(
    todoId: string,
    userId: string,
  ): Promise<{ todo: TodoDoc; changed: boolean } | null> {
    const now = this.now();
    const ref = this.col.doc(todoId);
    return this.col.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return null;
      const existing = withExpireAtAsDate<TodoDoc>(data);
      if (existing.status === "done") return { todo: existing, changed: false };
      const doc: TodoDoc = {
        ...existing,
        status: "done",
        doneBy: userId,
        doneAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expireAt: expireAfter(now, DOC_TTL_MS),
      };
      tx.set(ref, doc);
      return { todo: doc, changed: true };
    });
  }

  async findDueForReminder(today: Date): Promise<TodoDoc[]> {
    // 期限の条件は日付の計算を含むので、open だけを引いてコードで絞る（件数は少ない）。
    const snap = await this.col.where("status", "==", "open").get();
    return snap.docs
      .map((d) => withExpireAtAsDate<TodoDoc>(d.data()))
      .filter((t) => isDueForReminder(t, today));
  }

  async markReminded(todoIds: string[], today: Date): Promise<void> {
    const iso = jstDateIso(today);
    await Promise.all(
      todoIds.map(async (id) => {
        try {
          await this.col.doc(id).update({ lastRemindedOn: iso });
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }),
    );
  }
}
