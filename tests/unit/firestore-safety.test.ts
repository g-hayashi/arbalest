import { describe, expect, it } from "vitest";
import { assertSafeTestDatabase, newTestPrefix } from "../shared/firestoreSafety.js";

describe("Firestore のテストの安全のための約束（R9）", () => {
  it("(default) と空は拒否し、arbalest-test は通す", () => {
    expect(() => assertSafeTestDatabase("(default)")).toThrow();
    expect(() => assertSafeTestDatabase(" (default) ")).toThrow();
    expect(() => assertSafeTestDatabase("")).toThrow();
    expect(() => assertSafeTestDatabase("arbalest-test")).not.toThrow();
  });

  it("接頭辞は t<日時>_<乱数>_ の形で、呼ぶたびに変わる", () => {
    const p = newTestPrefix(new Date(Date.UTC(2025, 9, 24, 5, 3, 0)));
    expect(p).toMatch(/^t20251024050300_[0-9a-f]{8}_$/);
    expect(newTestPrefix()).not.toBe(newTestPrefix());
  });
});
