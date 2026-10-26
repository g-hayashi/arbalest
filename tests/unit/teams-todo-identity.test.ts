import { describe, expect, it } from "vitest";
import {
  matchTeamsTodos,
  type TeamsEvidence,
  type TeamsScope,
  type TeamsTodoCandidate,
  type TeamsTodoIdentity,
  TeamsWorkError,
} from "../../src/teams/todo-identity.js";

const scope: TeamsScope = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  channelId: "19:Channel@thread.tacv2",
  rootMessageId: "Root",
};
const assignee = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function evidence(messageId = "reply", quote = "資料を3部用意する"): TeamsEvidence {
  return {
    ref: { ...scope, kind: "reply", messageId },
    quote,
    link: `https://teams.microsoft.com/l/message/${encodeURIComponent(scope.channelId)}/${messageId}`,
    sourceCreatedAt: "2026-10-26T01:00:00Z",
  };
}
function candidate(overrides: Partial<TeamsTodoCandidate> = {}): TeamsTodoCandidate {
  return {
    text: "資料を3部用意する",
    evidence: [evidence()],
    assigneeAadId: assignee,
    dueIso: "2026-10-30",
    dueText: "10月30日",
    certainty: "explicit",
    needsReview: false,
    closed: false,
    ...overrides,
  };
}
function todo(overrides: Partial<TeamsTodoIdentity> = {}): TeamsTodoIdentity {
  const { text, evidence, assigneeAadId, dueIso, dueText } = candidate();
  return {
    todoId: "todo-a",
    scope,
    text,
    evidence,
    assigneeAadId,
    dueIso,
    dueText,
    status: "open",
    ...overrides,
  };
}
function match(candidates = [candidate()], existing = [todo()]) {
  return matchTeamsTodos({ scope, candidates, existing });
}

describe("Teams ToDo の同一性", () => {
  it("候補順・既存順・根拠順によらず双方1件の完全一致だけIDを引き継ぐ", () => {
    const a = candidate({ evidence: [evidence("a"), evidence("b")] });
    const b = candidate({ text: "会議室を予約する", evidence: [evidence("c", "予約する")] });
    const oldA = todo({ evidence: [...a.evidence].reverse() });
    const oldB = todo({ ...b, todoId: "todo-b", scope, status: "done" });
    expect(match([b, a], [oldA, oldB])).toEqual([
      { candidateIndex: 0, kind: "existing", todoIds: ["todo-b"], status: "done", changes: {} },
      { candidateIndex: 1, kind: "existing", todoIds: ["todo-a"], status: "open", changes: {} },
    ]);
    expect(match([a, b], [oldB, oldA]).map((item) => item.todoIds)).toEqual([
      ["todo-a"],
      ["todo-b"],
    ]);
  });

  it("空白だけを正規化し、リンクと作成日時の表現差を同一性へ混ぜない", () => {
    const changed = evidence();
    changed.quote = "  資料を3部用意する \n ";
    changed.link += `?tenantId=${scope.tenantId}`;
    changed.sourceCreatedAt = "2026-10-26T01:00:00.000Z";
    expect(
      match([candidate({ text: "\t資料を3部用意する\n", evidence: [changed] })])[0]?.kind,
    ).toBe("existing");
  });

  it.each([
    "資料を3部用意しない",
    "資料を4部用意する",
    "10月31日に資料を3部用意する",
    "資料を3部用意する。",
  ])("否定・数字・日付・記号の差を自動継承しない: %s", (text) => {
    expect(match([candidate({ text })])[0]).toMatchObject({
      kind: "ambiguous",
      todoIds: ["todo-a"],
      status: null,
    });
  });

  it("担当者と期限の差分は更新提案とし、既存の完了状態を維持する", () => {
    expect(
      match(
        [candidate({ assigneeAadId: null, dueIso: null, dueText: null, closed: false })],
        [todo({ status: "done" })],
      )[0],
    ).toEqual({
      candidateIndex: 0,
      kind: "update_proposal",
      todoIds: ["todo-a"],
      status: "done",
      changes: {
        assigneeAadId: { from: assignee, to: null },
        dueIso: { from: "2026-10-30", to: null },
        dueText: { from: "10月30日", to: null },
      },
    });
    expect(match([candidate({ closed: true })])[0]?.status).toBe("open");
    expect(match([candidate()], [todo({ status: "done" })])[0]?.status).toBe("done");
  });

  it.each([
    [evidence("reply", "引用の編集")],
    [evidence(), evidence("追加")],
    [evidence("reply", "別の引用")],
  ])("同じ元メッセージの引用編集・根拠追加を曖昧にする", (...items) => {
    expect(match([candidate({ evidence: items })])[0]?.kind).toBe("ambiguous");
  });

  it("根拠の削減も曖昧にする", () => {
    expect(
      match([candidate()], [todo({ evidence: [evidence(), evidence("追加")] })])[0]?.kind,
    ).toBe("ambiguous");
  });

  it("同一根拠の複数作業は本文が一致しても自動継承しない", () => {
    const second = todo({ todoId: "todo-b", text: "資料を送付する" });
    expect(match([candidate()], [second, todo()])[0]).toMatchObject({
      kind: "ambiguous",
      todoIds: ["todo-a", "todo-b"],
      status: null,
    });
  });

  it("候補同士が同じ根拠を使う場合は重複と別作業の双方を曖昧にする", () => {
    for (const second of [candidate(), candidate({ text: "資料を送付する" })]) {
      expect(match([candidate(), second]).map((item) => item.kind)).toEqual([
        "ambiguous",
        "ambiguous",
      ]);
      expect(match([candidate(), second], []).map((item) => item.kind)).toEqual([
        "ambiguous",
        "ambiguous",
      ]);
    }
  });

  it("同文面でも元メッセージが違えば新規、親と同じ生IDの返信も区別する", () => {
    expect(match([candidate({ evidence: [evidence("other")] })])[0]).toMatchObject({
      kind: "new",
      todoIds: [],
      status: null,
    });
    const root = evidence("Root");
    root.ref.kind = "root";
    expect(
      match([candidate({ evidence: [evidence("Root")] })], [todo({ evidence: [root] })])[0]?.kind,
    ).toBe("new");
  });

  it("完了済みの別作業へ状態を誤継承せず、消えた既存は変更しない", () => {
    const existing = [todo({ status: "done" })];
    const before = structuredClone(existing);
    expect(match([candidate({ text: "資料を送付する" })], existing)[0]?.status).toBeNull();
    expect(match([], existing)).toEqual([]);
    expect(existing).toEqual(before);
  });

  it("UUIDの大文字小文字を正規化して照合し不透明IDを保持する", () => {
    const existing = todo({
      scope: { ...scope, tenantId: scope.tenantId.toUpperCase() },
      assigneeAadId: assignee.toUpperCase(),
    });
    expect(match([candidate()], [existing])[0]?.kind).toBe("existing");
    expect(match([candidate({ evidence: [evidence("REPLY")] })])[0]?.kind).toBe("new");
  });

  it.each(["tenantId", "teamId", "channelId", "rootMessageId"] as const)(
    "別%sの既存や根拠を拒否する",
    (field) => {
      const foreignScope = { ...scope, [field]: "other" };
      expect(() => match([candidate()], [todo({ scope: foreignScope })])).toThrowError(
        expect.objectContaining({ code: "invalid_scope" }),
      );
      const foreignEvidence = evidence();
      foreignEvidence.ref[field] = "other";
      expect(() => match([candidate({ evidence: [foreignEvidence] })])).toThrowError(
        expect.objectContaining({ code: "invalid_scope" }),
      );
      expect(() =>
        matchTeamsTodos({ scope: { ...scope, [field]: " " }, candidates: [], existing: [] }),
      ).toThrowError(expect.objectContaining({ code: "invalid_scope" }));
    },
  );

  it.each([
    { quote: " " },
    { sourceCreatedAt: "not-a-date" },
    { sourceCreatedAt: "2026-02-30T00:00:00Z" },
    { link: "https://evil.example/secret" },
    { link: "javascript:alert(1)" },
    { link: "https://user:secret@teams.microsoft.com/l/message/a/b" },
    { ref: { ...scope, kind: "root", messageId: "other" } },
    { ref: { ...scope, kind: "reply", messageId: "" } },
    { ref: { ...scope, kind: "unknown", messageId: "reply" } },
  ])("不正根拠は内容を公開せず統一エラーで拒否する", (invalid) => {
    const run = () =>
      match([candidate({ evidence: [{ ...evidence(), ...invalid } as TeamsEvidence] })]);
    expect(run).toThrowError(TeamsWorkError);
    expect(run).toThrowError(expect.objectContaining({ code: "invalid_evidence" }));
    try {
      run();
    } catch (error) {
      expect(String(error)).not.toMatch(/secret|evil|資料/);
    }
  });

  it("候補と既存双方の空の根拠を拒否する", () => {
    expect(() => match([candidate({ evidence: [] })])).toThrowError(
      expect.objectContaining({ code: "invalid_evidence" }),
    );
    expect(() => match([], [todo({ evidence: [] })])).toThrowError(
      expect.objectContaining({ code: "invalid_evidence" }),
    );
  });

  it("入力を変更せず、戻り値の差分変更も入力へ波及しない", () => {
    const input = { scope, candidates: [candidate({ dueText: "金曜" })], existing: [todo()] };
    const original = structuredClone(input);
    const result = matchTeamsTodos(input);
    result[0]?.todoIds.push("変更");
    if (result[0]?.changes.dueText) result[0].changes.dueText.to = "変更";
    expect(input).toEqual(original);
  });
});
