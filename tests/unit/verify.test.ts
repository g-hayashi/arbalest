import { describe, expect, it } from "vitest";
import {
  detectWeekdays,
  normalizeQuote,
  partitionKnownRefs,
  REASON,
  type VerifyContext,
  verifyDate,
  verifyItem,
} from "../../src/analysis/verify.js";
import { jstTs } from "../fixtures/schedule-thread.js";

// 2026-10-23(金) の会話。m1=10:02、m2=10:30
const ctx: VerifyContext = {
  texts: new Map([
    ["m1", "定例の日程を決めたいです。@佐藤 @鈴木 候補は\n・10/28(水) 15:00"],
    ["m2", "28日なら、大丈夫です！"],
  ]),
  mIdToTs: new Map([
    ["m1", jstTs(10, 2)],
    ["m2", jstTs(10, 30)],
  ]),
  participantIds: new Set(["p1", "p2", "p3"]),
  today: new Date(Date.UTC(2026, 9, 23, 6)),
};

describe("normalizeQuote（V2）", () => {
  it("NFKC にして、空白・句読点・記号を除く", () => {
    expect(normalizeQuote("28日なら、大丈夫です！")).toBe("28日なら大丈夫です");
    expect(normalizeQuote("ＡＢＣ　１２３")).toBe("ABC123");
    expect(normalizeQuote("ｶﾀｶﾅ")).toBe("カタカナ");
    expect(normalizeQuote("a ⏎ b〜c\n(d)")).toBe("abcd");
  });

  it("文字の違い（大文字・小文字、別の語）は区別する", () => {
    expect(normalizeQuote("ABC")).not.toBe(normalizeQuote("abc"));
  });
});

describe("verifyItem: V1 根拠（evidence）", () => {
  it("存在する m-id だけ残し、ts に戻す。重複は 1 つにする", () => {
    const r = verifyItem({ evidence: ["m2", "m9", "m2", "m1"] }, ctx);
    expect(r.evidence).toEqual(["m2", "m1"]);
    expect(r.evidenceTs).toEqual([jstTs(10, 30), jstTs(10, 2)]);
    expect(r.needsReview).toBe(false);
    expect(r.reviewReasons).toEqual([]);
  });

  it("1 つも残らなければ needsReview", () => {
    const r = verifyItem({ evidence: ["m8", "m9"] }, ctx);
    expect(r.evidence).toEqual([]);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons).toContain(REASON.noEvidence);
  });

  it("evidence が空でも needsReview", () => {
    expect(verifyItem({ evidence: [] }, ctx).needsReview).toBe(true);
  });
});

describe("verifyItem: V2 quote", () => {
  it("正規化した quote が根拠のメッセージに含まれれば問題なし", () => {
    const r = verifyItem({ evidence: ["m2"], quote: "28日なら大丈夫です" }, ctx);
    expect(r.needsReview).toBe(false);
  });

  it("全角・半角・空白・句読点の違いは無視する", () => {
    expect(
      verifyItem({ evidence: ["m2"], quote: "２８日なら 大丈夫です。" }, ctx).needsReview,
    ).toBe(false);
  });

  it("改行をまたぐ引用も、記号を除いて照合する", () => {
    const r = verifyItem({ evidence: ["m1"], quote: "候補は ⏎ ・10/28(水) 15:00" }, ctx);
    expect(r.needsReview).toBe(false);
  });

  it("根拠のどれかに含まれればよい", () => {
    expect(verifyItem({ evidence: ["m1", "m2"], quote: "大丈夫です" }, ctx).needsReview).toBe(
      false,
    );
  });

  it("含まれなければ needsReview", () => {
    const r = verifyItem({ evidence: ["m2"], quote: "29日なら大丈夫です" }, ctx);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons).toContain(REASON.quoteNotFound);
  });

  it("根拠に挙げていないメッセージにだけ含まれる quote は含まれない扱い", () => {
    const r = verifyItem({ evidence: ["m2"], quote: "定例の日程を決めたい" }, ctx);
    expect(r.reviewReasons).toContain(REASON.quoteNotFound);
  });

  it("記号だけ・空の quote は含まれない扱い", () => {
    expect(verifyItem({ evidence: ["m2"], quote: "！？" }, ctx).reviewReasons).toContain(
      REASON.quoteNotFound,
    );
    expect(verifyItem({ evidence: ["m2"], quote: "" }, ctx).needsReview).toBe(true);
  });

  it("quote を渡さなければ照合しない", () => {
    expect(verifyItem({ evidence: ["m2"] }, ctx).needsReview).toBe(false);
  });
});

describe("verifyItem: V3 参加者", () => {
  it("参加者の表にある ID なら問題なし。null は未指定", () => {
    const r = verifyItem({ evidence: ["m1"], participants: ["p1", null, "p3"] }, ctx);
    expect(r.needsReview).toBe(false);
    expect(r.invalidParticipants).toEqual([]);
  });

  it("表にない ID は needsReview にして、invalidParticipants に入れる", () => {
    const r = verifyItem({ evidence: ["m1"], participants: ["p1", "p9"] }, ctx);
    expect(r.needsReview).toBe(true);
    expect(r.invalidParticipants).toEqual(["p9"]);
    expect(r.reviewReasons).toContain(`${REASON.unknownParticipant}: p9`);
  });
});

describe("detectWeekdays", () => {
  it("(火)、（火）、(火曜)、火曜日 を曜日として拾う。10月28日 の「月」は拾わない", () => {
    expect(detectWeekdays("10/28(火) 15:00")).toEqual(["火"]);
    expect(detectWeekdays("28日（火）")).toEqual(["火"]);
    expect(detectWeekdays("来週の水曜日か木曜")).toEqual(["水", "木"]);
    expect(detectWeekdays("(月曜)")).toEqual(["月"]);
    expect(detectWeekdays("10月28日の15時")).toEqual([]);
    expect(detectWeekdays("")).toEqual([]);
  });
});

describe("verifyDate（V4）", () => {
  const msgTs = jstTs(10, 2); // 2026-10-23(金)

  it("正しい日付で、曜日の記述がなければ問題なし", () => {
    expect(verifyDate("2026-10-28", { messageTs: msgTs })).toEqual({
      dateIso: "2026-10-28",
      needsReview: false,
      reasons: [],
    });
  });

  it("null はそのまま（日付なし）", () => {
    expect(verifyDate(null, { messageTs: msgTs })).toEqual({
      dateIso: null,
      needsReview: false,
      reasons: [],
    });
  });

  it("日付として不正なら null にして needsReview", () => {
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "2026/10/28",
      "10/28",
      "abc",
      "2026-10-28T00:00",
    ]) {
      const r = verifyDate(bad, { messageTs: msgTs });
      expect(r.dateIso).toBeNull();
      expect(r.needsReview).toBe(true);
      expect(r.reasons).toContain(`${REASON.invalidDate}: ${bad}`);
    }
  });

  it("元の表現の曜日が一致すれば問題なし", () => {
    // 2026-10-28 は水曜、2026-10-27 が火曜
    expect(
      verifyDate("2026-10-27", { messageTs: msgTs, sourceText: "10/27(火) 15:00" }).needsReview,
    ).toBe(false);
    expect(
      verifyDate("2026-10-27", { messageTs: msgTs, sourceText: "火曜日の午後" }).needsReview,
    ).toBe(false);
  });

  it("曜日が一致しなければ needsReview（日付は残す）", () => {
    const r = verifyDate("2026-10-28", { messageTs: msgTs, sourceText: "10/28(火) 15:00" });
    expect(r.dateIso).toBe("2026-10-28");
    expect(r.needsReview).toBe(true);
    expect(r.reasons).toContain(REASON.weekdayMismatch);
  });

  it("曜日が複数あれば、どれかに一致すればよい", () => {
    const text = "27日(火)か28日(水)";
    expect(verifyDate("2026-10-28", { messageTs: msgTs, sourceText: text }).needsReview).toBe(
      false,
    );
    expect(verifyDate("2026-10-29", { messageTs: msgTs, sourceText: text }).needsReview).toBe(true);
  });

  it("発言の日より 30 日以上前なら needsReview。29 日前までは問題なし", () => {
    // 発言は 2026-10-23。30 日前は 2026-09-23
    expect(verifyDate("2026-09-23", { messageTs: msgTs }).needsReview).toBe(true);
    expect(verifyDate("2026-09-23", { messageTs: msgTs }).reasons).toContain(REASON.oldDate);
    expect(verifyDate("2026-09-24", { messageTs: msgTs }).needsReview).toBe(false);
    expect(verifyDate("2025-10-28", { messageTs: msgTs }).needsReview).toBe(true);
  });

  it("未来の日付は古くない。発言の日は JST で数える", () => {
    expect(verifyDate("2027-10-28", { messageTs: msgTs }).needsReview).toBe(false);
    // 2026-10-24 00:30 JST の発言なら、30 日前は 2026-09-24
    const late = jstTs(24, 30); // 24 時 = 翌日 0 時 なので 2026-10-24 00:30 JST
    expect(verifyDate("2026-09-24", { messageTs: late }).needsReview).toBe(true);
    expect(verifyDate("2026-09-25", { messageTs: late }).needsReview).toBe(false);
  });
});

describe("verifyItem: V4 日付", () => {
  it("日付を検証し、結果の日付（不正は null）を返す。基準は最後の根拠の発言の日", () => {
    const r = verifyItem(
      {
        evidence: ["m1", "m2"],
        dates: [
          { dateIso: "2026-10-28", sourceText: "10/28(火)" },
          { dateIso: "2026-02-30" },
          { dateIso: null },
        ],
      },
      ctx,
    );
    expect(r.dates).toEqual(["2026-10-28", null, null]);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons).toContain(REASON.weekdayMismatch);
    expect(r.reviewReasons).toContain(`${REASON.invalidDate}: 2026-02-30`);
  });

  it("根拠がなければ今日を基準にする", () => {
    const r = verifyItem({ evidence: ["m9"], dates: [{ dateIso: "2026-09-01" }] }, ctx);
    expect(r.reviewReasons).toContain(REASON.oldDate);
  });

  it("理由は重複して並べない", () => {
    const r = verifyItem(
      { evidence: ["m1"], dates: [{ dateIso: "2026-01-01" }, { dateIso: "2026-01-02" }] },
      ctx,
    );
    expect(r.reviewReasons.filter((x) => x === REASON.oldDate)).toHaveLength(1);
  });
});

describe("partitionKnownRefs（V5）", () => {
  const existing = new Set(["k1", "t1", "q1"]);
  type Op = { ref: string | null; text: string };

  it("既存の ID を参照する操作と、新規（ref: null）は残し、実在しない ID は捨てる", () => {
    const ops: Op[] = [
      { ref: "k1", text: "a" },
      { ref: null, text: "b" },
      { ref: "k9", text: "c" },
      { ref: "t1", text: "d" },
    ];
    const { kept, dropped } = partitionKnownRefs(ops, (o) => o.ref, existing);
    expect(kept.map((o) => o.text)).toEqual(["a", "b", "d"]);
    expect(dropped.map((o) => o.text)).toEqual(["c"]);
  });

  it("close のように必ず ID を持つ操作も同じ", () => {
    const { kept, dropped } = partitionKnownRefs(
      [{ ref: "t1" }, { ref: "t2" }],
      (o) => o.ref,
      existing,
    );
    expect(kept).toEqual([{ ref: "t1" }]);
    expect(dropped).toEqual([{ ref: "t2" }]);
  });
});
