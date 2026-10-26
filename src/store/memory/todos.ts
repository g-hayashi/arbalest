import { jstDateIso } from "../../util/time.js";
import { DOC_TTL_MS, expireAfter, isDueForReminder } from "../ttl.js";
import { type TodoDoc, type TodoInput, type TodosRepo, todoIdOf } from "../types.js";

export class MemoryTodosRepo implements TodosRepo {
  private readonly docs = new Map<string, TodoDoc>();

  constructor(private readonly now: () => Date) {}

  async get(todoId: string): Promise<TodoDoc | null> {
    const doc = this.docs.get(todoId);
    return doc ? structuredClone(doc) : null;
  }

  async upsert(input: TodoInput): Promise<TodoDoc> {
    const now = this.now();
    const todoId = todoIdOf(input.targetId, input.itemId);
    const existing = this.docs.get(todoId);
    if (existing?.status === "done") return structuredClone(existing);

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
    this.docs.set(todoId, doc);
    return structuredClone(doc);
  }

  async findByMessageTs(channelId: string, messageTs: string): Promise<TodoDoc[]> {
    return [...this.docs.values()]
      .filter(
        (t) =>
          t.channelId === channelId &&
          (t.listMessageTs === messageTs || t.sourceTs.includes(messageTs)),
      )
      .map((t) => structuredClone(t));
  }

  async markDone(
    todoId: string,
    userId: string,
  ): Promise<{ todo: TodoDoc; changed: boolean } | null> {
    const existing = this.docs.get(todoId);
    if (!existing) return null;
    if (existing.status === "done") return { todo: structuredClone(existing), changed: false };
    const now = this.now();
    const doc: TodoDoc = {
      ...existing,
      status: "done",
      doneBy: userId,
      doneAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expireAt: expireAfter(now, DOC_TTL_MS),
    };
    this.docs.set(todoId, doc);
    return { todo: structuredClone(doc), changed: true };
  }

  async findDueForReminder(today: Date): Promise<TodoDoc[]> {
    return [...this.docs.values()]
      .filter((t) => isDueForReminder(t, today))
      .map((t) => structuredClone(t));
  }

  async markReminded(todoIds: string[], today: Date): Promise<void> {
    const iso = jstDateIso(today);
    for (const id of todoIds) {
      const existing = this.docs.get(id);
      if (existing) this.docs.set(id, { ...existing, lastRemindedOn: iso });
    }
  }

  expireAtOf(id: string): Date | null {
    return this.docs.get(id)?.expireAt ?? null;
  }
}
