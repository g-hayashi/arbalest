import type { Firestore } from "@google-cloud/firestore";

type Document = { path: string; id: string };
type Query = {
  collection: string;
  field?: string;
  value?: unknown;
  doc: (id: string) => Document;
  where: (field: string, op: string, value: unknown) => Query;
};
/** 外部接続なし。read-before-writeとrollbackを実SDKと同じ呼出し境界で検査する。 */
export class FakeTeamsFirestore {
  documents = new Map<string, Record<string, unknown>>();
  private tail = Promise.resolve();
  collection(name: string): Query {
    return {
      collection: name,
      doc: (id) => ({ path: `${name}/${id}`, id }),
      where: (field, op, value) => {
        if (op !== "==") throw new Error("unsupported query");
        return { ...this.collection(name), field, value };
      },
    };
  }
  async runTransaction<T>(
    body: (transaction: {
      get: (ref: Document | Query) => Promise<unknown>;
      set: (ref: Document, value: Record<string, unknown>) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const next = structuredClone(this.documents);
    let writing = false;
    try {
      const result = await body({
        get: async (ref) => {
          if (writing) throw new Error("Firestore reads must precede writes");
          if ("path" in ref)
            return { exists: next.has(ref.path), data: () => structuredClone(next.get(ref.path)) };
          return {
            docs: [...next.entries()]
              .filter(
                ([path, value]) =>
                  path.startsWith(`${ref.collection}/`) &&
                  (!ref.field || value[ref.field] === ref.value),
              )
              .map(([path, value]) => ({
                id: path.slice(ref.collection.length + 1),
                data: () => structuredClone(value),
              })),
          };
        },
        set: (ref, value) => {
          writing = true;
          next.set(ref.path, structuredClone(value));
        },
      });
      this.documents = next;
      return result;
    } finally {
      release();
    }
  }
  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}
