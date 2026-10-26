/**
 * 評価のケースの形式（contracts/eval.md#ケースの形式）。合成の会話だけを使う。
 * kind は summarize、findings、request。findings は期間の会話を expected.themes で採点する。
 * request は requestText と会話を分け、意図・期間・抑止・実際の副作用を採点する。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SlackMessage } from "../src/slack/conversation.js";

const Message = z.object({
  ts: z.string().regex(/^\d+\.\d+$/),
  user: z.string(),
  text: z.string(),
  /** スレッドの返信なら親の ts。 */
  threadTs: z.string().nullable().optional(),
  reactions: z.array(z.object({ name: z.string(), users: z.array(z.string()) })).optional(),
});

const Expected = z.object({
  /** 言い換えは合成ケースの許容表現と根拠を併用して採点する。 */
  overview: z
    .array(
      z.object({
        evidenceTs: z.array(z.string()).min(1),
        textIncludesAny: z.array(z.string().min(1)).min(1),
      }),
    )
    .optional(),
  request: z
    .object({
      kind: z.enum(["summary", "findings", "clarify"]),
      suppressTodo: z.boolean(),
      suppressCanvas: z.boolean(),
      period: z
        .object({ start: z.iso.datetime(), end: z.iso.datetime(), clamped: z.boolean() })
        .optional(),
    })
    .optional(),
  /** 許可する副作用。省略時は登録・canvas書き込みとも0件を期待する。 */
  effects: z
    .object({
      todoAssignees: z.array(z.string()),
      canvasWrites: z.boolean(),
    })
    .optional(),
  decided: z
    .array(
      z.object({
        topic: z.string().optional(),
        optionLabelIncludes: z.string(),
        evidenceTs: z.array(z.string()).min(1),
      }),
    )
    .optional(),
  open: z
    .array(z.object({ topic: z.string(), pending: z.array(z.string()).optional() }))
    .optional(),
  todos: z
    .array(
      z.object({
        textIncludes: z.string(),
        assignee: z.string().nullable().optional(),
        due: z.string().nullable().optional(),
        evidenceTs: z.array(z.string()).min(1),
      }),
    )
    .optional(),
  mustNotDecide: z.array(z.string()).optional(),
  /** findings のケースだけ。`evidenceTs` はそのテーマに含まれるべき根拠の ts。`theme` は参考（一致の判定には使わない）。 */
  themes: z
    .array(z.object({ theme: z.string().optional(), evidenceTs: z.array(z.string()).min(1) }))
    .optional(),
});

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["summarize", "findings", "request"]),
    requestText: z.string().optional(),
    tags: z.array(z.string()),
    /** ISO（オフセット付き）。ジョブの「今日」。 */
    now: z.string(),
    participants: z.array(z.object({ userId: z.string(), name: z.string() })),
    messages: z.array(Message),
    followUp: z.object({ messages: z.array(Message) }).optional(),
    expected: Expected,
  })
  .superRefine((c, ctx) => {
    if (c.kind === "request" && (c.requestText === undefined || c.expected.request === undefined))
      ctx.addIssue({
        code: "custom",
        message: "requestにはrequestTextとexpected.requestが必要です",
      });
    if (c.expected.request?.kind === "findings" && c.expected.request.period === undefined)
      ctx.addIssue({ code: "custom", message: "findingsの正解には確定したperiodが必要です" });
  });

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalMessage = z.infer<typeof Message>;

/** ケースのメッセージを、ジョブが扱う形にする。 */
export function toSlackMessage(m: EvalMessage): SlackMessage {
  return {
    ts: m.ts,
    threadTs: m.threadTs ?? null,
    userId: m.user,
    text: m.text,
    edited: false,
    reactions: (m.reactions ?? []).map((r) => ({ name: r.name, userIds: r.users })),
  };
}

/** ディレクトリの `*.json` を読む（ファイル名の昇順）。形式が不正ならファイル名を付けて失敗する。 */
export async function loadCases(dir: string): Promise<EvalCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const parsed = EvalCaseSchema.safeParse(
      JSON.parse(await readFile(path.join(dir, file), "utf8")),
    );
    if (!parsed.success) {
      throw new Error(`ケースの形式が不正です: ${file}\n${z.prettifyError(parsed.error)}`);
    }
    cases.push(parsed.data);
  }
  return cases;
}
