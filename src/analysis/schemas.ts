/**
 * 抽出のスキーマ（contracts/llm.md#抽出のスキーマ、`summarize_patch`）。
 * 初回も差分も同じスキーマを使う（初回は `previous_state` が空）。
 * 欄の順は「根拠 → 結論」。strict の JSON Schema にするため、任意の欄は nullable にする。
 * 参加者の enum は、呼び出しごとに参加者の表（p-id）から作る。
 */
import { z } from "zod";

export const SUMMARIZE_SCHEMA_NAME = "summarize_patch";

/** 参加者が 0 人のときの enum の代わりの値。空の enum は strict の JSON Schema にできないため。参加者の表には無いので、検証で必ず外れる。 */
export const NO_PARTICIPANT = "none";

const Evidence = z.array(z.string().regex(/^m\d+$/)).min(1);
const Certainty = z.enum(["explicit", "implied", "uncertain"]);

/** 参加者の ID（`p1` など）の enum。0 人でも壊れないようにする。 */
function participantEnum(participantIds: readonly string[]) {
  const ids = participantIds.length > 0 ? [...new Set(participantIds)] : [NO_PARTICIPANT];
  return z.enum(ids as [string, ...string[]]);
}

export function buildSummarizeSchema(participantIds: readonly string[]) {
  const P = participantEnum(participantIds);
  return z.object({
    overview: z
      .array(
        z.object({
          ref: z.string().nullable(),
          evidence: Evidence,
          quote: z.string(),
          text: z.string(),
        }),
      )
      .max(3),
    topics: z.array(
      z.object({
        /** 既存の k-id。新規なら null。 */
        ref: z.string().nullable(),
        evidence: Evidence,
        title: z.string(),
        required_participants: z.array(P),
        options: z.array(
          z.object({
            ref: z.string().nullable(),
            evidence: Evidence,
            label: z.string(),
            date_iso: z.string().nullable(),
          }),
        ),
      }),
    ),
    responses: z.array(
      z.object({
        evidence: Evidence,
        quote: z.string(),
        /** 既存の k-id、または新しい topic の `new:<topics の添字>`。 */
        topic_ref: z.string(),
        /** 既存の option の ID、または新しい option の `new:<その topic の options の添字>`。 */
        option_ref: z.string().nullable(),
        participant: P,
        answer: z.enum(["yes", "no", "maybe"]),
        certainty: Certainty,
      }),
    ),
    statements: z.array(
      z.object({
        evidence: Evidence,
        quote: z.string(),
        topic_ref: z.string(),
        option_ref: z.string().nullable(),
        text: z.string(),
        certainty: Certainty,
      }),
    ),
    todos: z.array(
      z.object({
        ref: z.string().nullable(),
        evidence: Evidence,
        quote: z.string(),
        text: z.string(),
        assignee: P.nullable(),
        due_iso: z.string().nullable(),
        due_text: z.string().nullable(),
        certainty: Certainty,
      }),
    ),
    questions: z.array(
      z.object({
        ref: z.string().nullable(),
        evidence: Evidence,
        quote: z.string(),
        text: z.string(),
      }),
    ),
    close: z.array(z.object({ ref: z.string(), evidence: Evidence, reason: z.string() })),
  });
}

export type SummarizeSchema = ReturnType<typeof buildSummarizeSchema>;
export type SummarizePatch = z.infer<SummarizeSchema>;

// ---- findings（US4、contracts/llm.md#findings のスキーマ） ----

export const FINDINGS_MAP_SCHEMA_NAME = "findings_map";
export const FINDINGS_REDUCE_SCHEMA_NAME = "findings_reduce";

/** 候補の種類: 分かったこと、課題、合意された方針。 */
export const FINDING_KINDS = ["finding", "issue", "agreement"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** map（`extract_chunk`）: 分割ごとの候補。欄の順は「根拠 → 結論」。参加者の enum は使わない。 */
export const FindingsMapSchema = z.object({
  candidates: z.array(
    z.object({
      evidence: Evidence,
      quote: z.string(),
      theme_hint: z.string(),
      statement: z.string(),
      kind: z.enum(FINDING_KINDS),
    }),
  ),
});
export type FindingsMapOutput = z.infer<typeof FindingsMapSchema>;

/** reduce（`synthesize`）: 入力は候補（`c<n>`）だけ。根拠は candidate_ids からコードが作る。 */
export const FindingsReduceSchema = z.object({
  themes: z.array(
    z.object({
      theme: z.string(),
      findings: z.array(
        z.object({
          statement: z.string(),
          candidate_ids: z.array(z.string().regex(/^c\d+$/)).min(1),
        }),
      ),
    }),
  ),
});
export type FindingsReduceOutput = z.infer<typeof FindingsReduceSchema>;
