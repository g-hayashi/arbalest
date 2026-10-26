import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../src/store/memory/index.js";
import { createTestClock, describeStoreContract, START } from "../shared/storeContract.js";

describeStoreContract("メモリ", async (now) => {
  const store = createMemoryStore({ now });
  return {
    store,
    expireAtOf: async (collection, id) => store.expireAtOf(collection, id),
  };
});

describe("メモリのストア固有の振る舞い", () => {
  it("保存した値を後から書き換えても、ストアの中身は変わらない（参照を共有しない）", async () => {
    const clock = createTestClock(START);
    const store = createMemoryStore({ now: clock.now });
    const saved = await store.targets.put({
      targetId: "c_C1",
      kind: "channel",
      channelId: "C1",
      threadTs: null,
      lastAnalyzedTs: "1.0",
      analyzedDigest: {},
      promptVersion: "v1",
      participants: [],
      state: { topics: [], responses: [], statements: [], todos: [], questions: [] },
      nextSeq: {},
      canvasSectionMarker: null,
    });
    saved.participants.push({ id: "p1", userId: "U1", name: "x" });
    const got = await store.targets.get("c_C1");
    // 旧保存形式には overview がなくても、安全に空配列として読める。
    expect(got?.state.overview).toEqual([]);
    expect(got?.participants).toEqual([]);
    got?.participants.push({ id: "p2", userId: "U2", name: "y" });
    expect((await store.targets.get("c_C1"))?.participants).toEqual([]);
  });

  it("now を省略すると現在時刻を使う", async () => {
    const store = createMemoryStore();
    expect(await store.events.markProcessed("evt-x")).toBe(true);
  });
});
