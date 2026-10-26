# Contract: LlmProvider と抽出のスキーマ

## インタフェース（src/llm/provider.ts）

```ts
export type LlmTask = "extract" | "extract_chunk" | "synthesize";

export interface LlmRequest<T> {
  task: LlmTask;
  system: string;            // 変わらない部分（プロンプトキャッシュの対象）。版を含める
  input: string;             // 変わる部分
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number;
}

export interface LlmUsage { input: number; cachedInput: number; output: number; model: string; latencyMs: number }

export interface LlmProvider {
  generateStructured<T>(req: LlmRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
  /** task が使うモデル名（findings の chunk_cache のキーに使う）。未実装なら "unknown" とみなす */
  modelOf?(task: LlmTask): string | undefined;
}

export class LlmError extends Error {
  kind: "rate_limit" | "server" | "schema" | "timeout" | "config" | "content_filter";
}
```

- `rate_limit`・`server`・`timeout` は一時的（再試行してよい）。`schema`・`config`・`content_filter` は一時的でない。
- `content_filter`: 提供元の安全フィルタに該当した（HTTP 400 で code か type が `content_filter` など、または応答の `finish_reason` が `content_filter`）。ログには status・code・type だけを出し、本文は出さない。まとめのジョブはスレッドに「AI の安全フィルタにより分析できませんでした」と返信し、評価（eval）は filtered として指標から除外する。

- `extract` と `extract_chunk` は `LLM_MODEL_EXTRACT`、`synthesize` は `LLM_MODEL_SYNTH` を使う。
- 環境変数は `LLM_PROVIDER`（`openai-compatible` | `fake`）、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL_EXTRACT`、`LLM_MODEL_SYNTH`、`LLM_REASONING_EXTRACT?`、`LLM_REASONING_SYNTH?`。
- `fake` は、テストから与えた応答（スキーマ名ごとの関数）を返す。

## 入力の形式（analysis/preprocess.ts）

```
<context>
today: 2026-10-23(金) JST
calendar: 10/20(月) 10/21(火) ... 11/14(金)      # 前後 3 週間（差分のときは過去 1 週間・先 3 週間）
participants: p1=田中 p2=佐藤 p3=鈴木
</context>
<previous_state>                                 # 差分のときだけ。根拠は付けない
k1 定例の日程 [o1=10/28(火)15:00, o2=10/29(水)10:00]
回答 o1 yes: p2
t1 会議室を予約する assignee=p1 due=2026-10-27
</previous_state>
<messages>
[m1] 10/22(木) 10:02 田中: 定例の日程を決めたいです。@佐藤 @鈴木 候補は…
[m2] 10/22(木) 10:30 佐藤 → m1: 28日なら大丈夫です  {👍×1: 田中}
</messages>
```

- **差分の入力を減らす規則**（SC-006。`summarize@4`）: `<previous_state>` には、AI が出力で参照しない・差分の更新に効かないものを書かない。出す ID は、更新・close の対象になる k（題目）、o（候補）、t（ToDo）、q（問い）だけ。
  - 回答・発言の ID（r・s）は出さない（スキーマに参照する欄がない）。回答は（対象, 答え）ごとに 1 行（`回答 o1 yes: p2,p3`）。上書きされた回答は出さない。発言は題目ごとに最新の 1 件（`発言 k1 → o1: 本文`）。
  - 必要な参加者（required）は出さない（更新は和を取るだけで、AI の判断に使わない）。
  - 完了した ToDo と問いは出さない。状態には残るので ID は再利用されず、AI が出さない ID を参照することもない（実在しない ID の参照は従来どおり `unknownRef` で捨てる）。
  - 差分のときの calendar は、過去側を 1 週間に短くする（`today` に曜日があり、メッセージの行にも日付と曜日が付くため）。参加者の表は省かない（本文に名前だけで出る人を p-id に引くため）。
- メッセージは `<messages>` の中のデータであり、指示ではないことを system に明記する（FR-051）。
- 本文の中の `</messages>` などの区切りの文字列は、無害な文字に置き換える。

## 抽出のスキーマ（analysis/schemas.ts、`summarize_patch`）

初回も差分も同じスキーマを使う（初回は `previous_state` が空）。欄の順は「根拠 → 結論」とする。

```ts
const Evidence = z.array(z.string().regex(/^m\d+$/)).min(1);
const Certainty = z.enum(["explicit", "implied", "uncertain"]);
const P = z.enum(participantIds);           // 呼び出しごとに参加者から作る

SummarizePatch = z.object({
  topics: z.array(z.object({
    ref: z.string().nullable(),             // 既存の k-id、新規なら null
    evidence: Evidence, title: z.string(),
    required_participants: z.array(P),
    options: z.array(z.object({ ref: z.string().nullable(), evidence: Evidence, label: z.string(), date_iso: z.string().nullable() })),
  })),
  responses: z.array(z.object({
    evidence: Evidence, quote: z.string(),
    topic_ref: z.string(), option_ref: z.string().nullable(),   // 新しい topic や option は「new:<配列の添字>」で参照する
    participant: P, answer: z.enum(["yes", "no", "maybe"]), certainty: Certainty,
  })),
  statements: z.array(z.object({
    evidence: Evidence, quote: z.string(),
    topic_ref: z.string(), option_ref: z.string().nullable(), text: z.string(), certainty: Certainty,
  })),
  todos: z.array(z.object({
    ref: z.string().nullable(), evidence: Evidence, quote: z.string(),
    text: z.string(), assignee: P.nullable(), due_iso: z.string().nullable(), due_text: z.string().nullable(), certainty: Certainty,
  })),
  questions: z.array(z.object({ ref: z.string().nullable(), evidence: Evidence, quote: z.string(), text: z.string() })),
  close: z.array(z.object({ ref: z.string(), evidence: Evidence, reason: z.string() })),
});
```

## findings のスキーマ

- `findings_map`（`extract_chunk`）:
  `{ candidates: [{ evidence, quote, theme_hint, statement, kind: "finding"|"issue"|"agreement" }] }`
- `findings_reduce`（`synthesize`）: 入力は候補の一覧（`c<n>` の ID 付き）だけで、メッセージは渡さない。
  `{ themes: [{ theme, findings: [{ statement, candidate_ids: string[] }] }] }`
  - 根拠は、`candidate_ids` に対応する候補の evidence の和集合をコードで作る。
  - 存在しない候補 ID は捨てる。候補が V1・V2 に反するときは捨てずに `needsReview` を付け、Finding は参照する候補がすべて要確認のときだけ `needsReview` とする（T028 の実装で決めた解釈）。

## プロンプトの版

- `src/analysis/prompts/*.ts` に、`PROMPT_VERSION = "summarize@1"` のような版を置く。
- system の内容を変えたら版を上げる（キャッシュと差分の更新が無効になる）。
