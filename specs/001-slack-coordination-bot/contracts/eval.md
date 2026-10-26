# Contract: 評価（npm run eval）

## ケースの形式（eval/cases/<id>.json）

合成の会話だけを使う。実在の人名や実際の会話は使わない。

```json
{
  "id": "schedule-basic-01",
  "kind": "summarize",
  "tags": ["日程調整", "リアクション合意"],
  "now": "2026-10-24T10:00:00+09:00",
  "participants": [{ "userId": "U1", "name": "田中" }, { "userId": "U2", "name": "佐藤" }],
  "messages": [
    { "ts": "1729731720.000100", "user": "U1", "text": "…", "reactions": [{ "name": "+1", "users": ["U2"] }] }
  ],
  "followUp": { "messages": [ ... ] },
  "expected": {
    "decided": [{ "topic": "定例の日程", "optionLabelIncludes": "10/28", "evidenceTs": ["…"] }],
    "open": [{ "topic": "会場", "pending": ["U3"] }],
    "todos": [{ "textIncludes": "会議室", "assignee": "U1", "due": "2026-10-27", "evidenceTs": ["…"] }],
    "mustNotDecide": ["会場"]
  }
}
```

- `followUp` がある場合は、初回の後に差分の更新を行い、その後の結果を `expected` と照合する（SC-006 の測定も兼ねる）。
- `kind: "findings"` のケースでは、`expected.themes`（テーマと、含まれるべき根拠の ts）を使う。

## 一致の判定

- 項目が一致するのは、根拠の ts が 1 つ以上重なり、かつ種類ごとの欄（`optionLabelIncludes`、`assignee`、`due`、`textIncludes`）が合う場合。
- 1 つの正解には、出力の 1 項目だけを対応させる。

## 指標（SC-002〜SC-006）

- 決定事項・ToDo の適合率と再現率
- 担当者の正解率、期限の正解率
- `mustNotDecide` の違反数（0 であること）
- 根拠の検証の合格率
- 1 ケースあたりの入力・キャッシュ・出力のトークン数。差分の更新の、初回に対する比
  - SC-006 の比は、`followUp` のメッセージ数が全体（初回 + followUp）の 2 割以下のケースだけで合算する。入力のトークンから、毎回同じ固定の部分（システムプロンプトと構造化出力のスキーマ。呼び出しの回数ぶん）を引いて測り、0.50 以下でなければ不合格にする（他の指標と同じく終了コード 1）。対象のケースが無ければ判定せず `-` と出す。固定を含む比は参考値として表に残す。
- 安全フィルタ（`LlmError` の `content_filter`）に止められたケースは `filtered` として記録し、すべての指標と SC-006 の比から除外する（`mustNotDecide` の違反にも数えない）。表に `filtered` と出す。
- 保存する結果には、ケースごとの出力（決定・未決定・ToDo）も入れる（原因の切り分け用）。

## 出力

- 標準出力に表を出す。
- `.tmp/eval/<日時>.json` に保存し、前回の結果があれば差を出す。
- 閾値（SC-002〜SC-006）を満たさなかったら、終了コード 1 で終わる。
- 引数: `--case <id>`、`--tag <tag>`、`--model-extract <name>`（設定の上書き）。
- 推定AI費用は `EVAL_PRICING` にJSONで渡す。同じ通貨で、抽出（`extract` / `extract_chunk`）と統合（`synthesize`）それぞれの100万トークンあたりの単価を設定する。モデル名や価格はコードに固定しない。
  - 形式: `{"currency":"USD","extract":{"input":2,"cachedInput":0.5,"output":4},"synthesize":{"input":10,"cachedInput":2,"output":20}}`。数値は形式の例で、実際の単価ではない。利用中のデプロイの契約単価を使い、`--model-extract` などでモデルを替えたら単価も更新する。
  - `input` はキャッシュされない入力の単価。費用は `(入力 - キャッシュ入力) × input + キャッシュ入力 × cachedInput + 出力 × output` を100万で割る。抽出と統合を別々に計算する。
  - ケースごとの初回・差分と評価全体の推定金額、設定単価、呼び出しごとの用途・モデル・トークン数を保存する。失敗した呼び出しの利用量は取得できないため、取得できた分だけの不完全な推定と明示する。AIのトークン料金だけを含む。
  - 未設定なら「未算出」と出す。不正なJSON・不足した単価・負の単価はAIを呼ぶ前に終了コード2にする。
