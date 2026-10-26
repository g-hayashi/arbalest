import { describe, expect, it } from "vitest";
import {
  buildCalendarTable,
  dateToTs,
  formatJst,
  formatJstDateIsoWeekday,
  formatJstMonthDayWeekday,
  isBusinessDay,
  jstDateIso,
  nextBusinessDay,
  resolveRequestPeriod,
  startOfJstDay,
  tsToDate,
} from "../../src/util/time.js";

// 2025-10-24(金) 14:03 JST = 05:03 UTC
const FRI_1403 = new Date(Date.UTC(2025, 9, 24, 5, 3, 0));

describe("依頼された振り返り期間", () => {
  it.each([
    ["last_week", "2025-10-12T15:00:00.000Z", "2025-10-19T15:00:00.000Z"],
    ["this_week", "2025-10-19T15:00:00.000Z", FRI_1403.toISOString()],
    ["this_month", "2025-09-30T15:00:00.000Z", FRI_1403.toISOString()],
  ] as const)("%s はJSTの暦境界で確定する", (kind, start, end) => {
    expect(resolveRequestPeriod({ kind, amount: null }, FRI_1403)).toMatchObject({
      start,
      end,
      clamped: false,
    });
  });

  it("月曜JSTの0時から新しい週に切り替わる", () => {
    const monday = new Date("2026-10-25T15:00:00.000Z");
    expect(resolveRequestPeriod({ kind: "last_week", amount: null }, monday)).toMatchObject({
      start: "2026-10-18T15:00:00.000Z",
      end: monday.toISOString(),
    });
  });

  it("直近14日とこの2週間は同じ半開区間になる", () => {
    const expected = {
      start: "2025-10-10T05:03:00.000Z",
      end: FRI_1403.toISOString(),
      clamped: false,
    };
    expect(resolveRequestPeriod({ kind: "rolling_days", amount: 14 }, FRI_1403)).toMatchObject(
      expected,
    );
    expect(resolveRequestPeriod({ kind: "rolling_weeks", amount: 2 }, FRI_1403)).toMatchObject(
      expected,
    );
  });

  it("期間省略は30日、90日超過は現在から90日へ制限する", () => {
    expect(resolveRequestPeriod({ kind: "default", amount: null }, FRI_1403)).toMatchObject({
      start: "2025-09-24T05:03:00.000Z",
      end: FRI_1403.toISOString(),
      clamped: false,
    });
    expect(resolveRequestPeriod({ kind: "rolling_days", amount: 100 }, FRI_1403)).toMatchObject({
      start: "2025-07-26T05:03:00.000Z",
      end: FRI_1403.toISOString(),
      clamped: true,
    });
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, null])(
    "不正な期間 %s は実行せず確認対象にする",
    (amount) => {
      expect(resolveRequestPeriod({ kind: "rolling_days", amount }, FRI_1403)).toBeNull();
    },
  );
});

describe("ts と Date の相互変換", () => {
  it("Slack の ts をミリ秒まで Date にする", () => {
    const sec = Math.floor(FRI_1403.getTime() / 1000);
    const d = tsToDate(`${sec}.123456`);
    expect(d.getTime()).toBe(FRI_1403.getTime() + 123);
  });

  it("小数部が短くても変換できる", () => {
    const sec = Math.floor(FRI_1403.getTime() / 1000);
    expect(tsToDate(`${sec}.5`).getTime()).toBe(FRI_1403.getTime() + 500);
    expect(tsToDate(`${sec}`).getTime()).toBe(FRI_1403.getTime());
  });

  it("Date を Slack の ts 形式（秒.6桁）にする", () => {
    const sec = Math.floor(FRI_1403.getTime() / 1000);
    expect(dateToTs(new Date(FRI_1403.getTime() + 7))).toBe(`${sec}.007000`);
  });

  it("往復してもミリ秒の精度で同じになる", () => {
    const d = new Date(FRI_1403.getTime() + 321);
    expect(tsToDate(dateToTs(d)).getTime()).toBe(d.getTime());
  });

  it("不正な ts は例外にする", () => {
    expect(() => tsToDate("abc")).toThrow();
    expect(() => tsToDate("")).toThrow();
  });
});

describe("JST の表示", () => {
  it("10/24(金) 14:03 の形式にする", () => {
    expect(formatJst(FRI_1403)).toBe("10/24(金) 14:03");
  });

  it("UTC では前日でも JST の日付で表示する", () => {
    // 2025-01-05(日) 00:30 JST = 2025-01-04 15:30 UTC
    expect(formatJst(new Date(Date.UTC(2025, 0, 4, 15, 30)))).toBe("1/5(日) 00:30");
  });

  it("日付だけの形式と ISO の日付", () => {
    expect(formatJstMonthDayWeekday(FRI_1403)).toBe("10/24(金)");
    expect(jstDateIso(FRI_1403)).toBe("2025-10-24");
    expect(jstDateIso(new Date(Date.UTC(2025, 0, 4, 15, 30)))).toBe("2025-01-05");
  });

  it("基準の日と年が違えば年を付ける", () => {
    const next = new Date(Date.UTC(2027, 0, 4, 3)); // 2027-01-04(月) JST
    expect(formatJstMonthDayWeekday(next, FRI_1403)).toBe("2027/1/4(月)");
    expect(formatJst(next, FRI_1403)).toBe("2027/1/4(月) 12:00");
    expect(formatJst(FRI_1403, next)).toBe("2025/10/24(金) 14:03");
  });

  it("基準の日と年が同じなら年を付けない。JST の年で比べる", () => {
    expect(formatJst(FRI_1403, new Date(Date.UTC(2025, 0, 1)))).toBe("10/24(金) 14:03");
    // 2025-12-31 15:30 UTC = 2026-01-01 00:30 JST
    const newYear = new Date(Date.UTC(2025, 11, 31, 15, 30));
    expect(formatJst(newYear, FRI_1403)).toBe("2026/1/1(木) 00:30");
  });

  it("今日の日付を ISO と曜日で表す", () => {
    expect(formatJstDateIsoWeekday(new Date(Date.UTC(2026, 9, 23, 3)))).toBe("2026-10-23(金)");
  });
});

describe("営業日", () => {
  it("月〜金は営業日、土日は営業日でない", () => {
    expect(isBusinessDay(FRI_1403)).toBe(true);
    // 2025-10-25(土) 12:00 JST
    expect(isBusinessDay(new Date(Date.UTC(2025, 9, 25, 3)))).toBe(false);
    // 2025-10-26(日) 12:00 JST
    expect(isBusinessDay(new Date(Date.UTC(2025, 9, 26, 3)))).toBe(false);
    // 2025-10-27(月) 12:00 JST
    expect(isBusinessDay(new Date(Date.UTC(2025, 9, 27, 3)))).toBe(true);
  });

  it("UTC では日曜でも JST で月曜なら営業日", () => {
    // 2025-10-27(月) 08:00 JST = 2025-10-26 23:00 UTC
    expect(isBusinessDay(new Date(Date.UTC(2025, 9, 26, 23)))).toBe(true);
  });

  it("祝日は考慮しない（2025-11-03 文化の日は月曜で営業日）", () => {
    expect(isBusinessDay(new Date(Date.UTC(2025, 10, 3, 3)))).toBe(true);
  });

  it("startOfJstDay は JST の 0 時を返す", () => {
    expect(startOfJstDay(FRI_1403).toISOString()).toBe("2025-10-23T15:00:00.000Z");
  });

  it("nextBusinessDay: 月〜木の次は翌日の JST 0 時", () => {
    // 2025-10-23(木) 14:03 JST → 金
    const thu = new Date(FRI_1403.getTime() - 24 * 3600 * 1000);
    expect(formatJst(nextBusinessDay(thu))).toBe("10/24(金) 00:00");
  });

  it("nextBusinessDay: 金・土・日の次は月曜", () => {
    expect(formatJst(nextBusinessDay(FRI_1403))).toBe("10/27(月) 00:00");
    expect(formatJst(nextBusinessDay(new Date(Date.UTC(2025, 9, 25, 3))))).toBe("10/27(月) 00:00");
    expect(formatJst(nextBusinessDay(new Date(Date.UTC(2025, 9, 26, 3))))).toBe("10/27(月) 00:00");
  });

  it("nextBusinessDay: UTC と JST で日付がずれる時刻でも JST で数える", () => {
    // 2025-10-24(金) 23:30 JST = 14:30 UTC（UTC でも金）→ 月
    expect(formatJst(nextBusinessDay(new Date(Date.UTC(2025, 9, 24, 14, 30))))).toBe(
      "10/27(月) 00:00",
    );
    // 2025-10-25(土) 01:00 JST = 2025-10-24 16:00 UTC（UTC では金）→ 月
    expect(formatJst(nextBusinessDay(new Date(Date.UTC(2025, 9, 24, 16))))).toBe("10/27(月) 00:00");
  });
});

describe("日付の表", () => {
  it("今日の前後3週間（43日分）を M/d(曜) で並べる", () => {
    const table = buildCalendarTable(FRI_1403);
    const items = table.split(" ");
    expect(items).toHaveLength(43);
    expect(items[0]).toBe("10/3(金)");
    expect(items[21]).toBe("10/24(金)");
    expect(items[42]).toBe("11/14(金)");
    expect(items).toContain("10/27(月)");
    expect(items).toContain("10/25(土)");
  });

  it("過去側の日数を指定できる（先の 3 週間はそのまま）", () => {
    const items = buildCalendarTable(FRI_1403, 3, 14).split(" ");
    expect(items).toHaveLength(14 + 1 + 21);
    expect(items[0]).toBe("10/10(金)");
    expect(items[14]).toBe("10/24(金)");
    expect(items[35]).toBe("11/14(金)");
  });

  it("年をまたぐときは、年が変わる日から年を付ける", () => {
    // 2025-12-31(水) JST
    const items = buildCalendarTable(new Date(Date.UTC(2025, 11, 31, 3))).split(" ");
    expect(items).toHaveLength(43);
    expect(items[0]).toBe("12/10(水)");
    expect(items[21]).toBe("12/31(水)");
    expect(items[22]).toBe("2026/1/1(木)");
    expect(items[42]).toBe("2026/1/21(水)");
  });

  it("年をまたぐ例: 2027/1/4(月)", () => {
    // 2026-12-28(月) JST
    const items = buildCalendarTable(new Date(Date.UTC(2026, 11, 28, 3))).split(" ");
    expect(items).toContain("2027/1/4(月)");
    expect(items).toContain("12/31(木)");
    expect(items).not.toContain("1/4(月)");
  });

  it("年をまたがなければ年を付けない", () => {
    const items = buildCalendarTable(FRI_1403).split(" ");
    expect(items.every((s) => !/^\d{4}\//.test(s))).toBe(true);
  });

  it("年の初めが基準でも、前の年の日付は年なしのまま、年が変わる日から付ける", () => {
    // 2026-01-05(月) JST。3 週間前は 2025-12-15
    const items = buildCalendarTable(new Date(Date.UTC(2026, 0, 5, 3))).split(" ");
    expect(items[0]).toBe("12/15(月)");
    expect(items[16]).toBe("12/31(水)");
    expect(items[17]).toBe("2026/1/1(木)");
  });

  it("JST の日付を基準にする", () => {
    // 2025-10-25(土) 01:00 JST（UTC では 10/24）
    const items = buildCalendarTable(new Date(Date.UTC(2025, 9, 24, 16))).split(" ");
    expect(items[21]).toBe("10/25(土)");
  });
});
