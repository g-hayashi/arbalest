# Data Model: Slack 調整まとめボット Arbalest（MVP）

保存先は Firestore。時刻は UTC の ISO 文字列で保存し、日付（期限）は `YYYY-MM-DD`（JST）で保存する。
`expireAt` は TTL の対象（R13）。

## 識別子

- **targetId**:
  - スレッドは `t_<channelId>_<threadTs>`（`.` は `-` に置き換える）。
  - チャネルの直近は `c_<channelId>`。
  - findings は保存しない（`chunk_cache` だけを使う）。同時実行を抑えるロックにだけ `f_<channelId>` を使う（`job_locks/{f_<channelId>}`。`src/jobs/targetId.ts` の `findingsLockId`）。
- **itemId**: 対象の中で一意で、呼び出しをまたいで変わらない。接頭辞と連番で表す: `k`（topic）、`o`（option）、`r`（response）、`s`（decision statement）、`t`（todo）、`q`（open question）。例: `k1`、`t3`。採番はコード（`merge.ts`）が行い、AI には新しい項目の ID を作らせない。
- **evidence**: Slack のメッセージの `ts` の配列。AI への入力ではその回の `m<n>` を使い、コードが `ts` に戻す。

## コレクション

### `targets/{targetId}`（調整のまとめ）

| 欄 | 型 | 説明 |
|---|---|---|
| kind | `"thread" \| "channel"` | |
| channelId, threadTs | string, string \| null | |
| lastAnalyzedTs | string | 最後に分析したメッセージの ts |
| analyzedDigest | `Record<ts, string>` | 分析済みのメッセージの ts と、本文（編集後）とリアクション（絵文字の名前と押した人を並べ替えたもの）の sha1 の先頭 12 文字。次回の取得結果と比べ、編集・削除・リアクションの変化があれば全体を処理し直す（後から付いたリアクションでの合意を拾うため） |
| promptVersion | string | 版が変わったら全体を処理し直す（R5） |
| participants | `{ id: "p1", userId, name }[]` | 参加者の表（短い ID と Slack のユーザーの対応） |
| state | `AnalysisState`（下記） | 抽出した事実 |
| nextSeq | `Record<prefix, number>` | 項目 ID の採番 |
| canvasSectionMarker | string \| null | `arb:<threadTs>`（US3 で設定） |
| updatedAt, expireAt | timestamp | expireAt = updatedAt + 90 日 |

`AnalysisState`:

```
topics:     { id, title, evidence[], requiredParticipants: p-id[], options: Option[], status?: computed }
Option:     { id, label, dateIso | null, evidence[] }
responses:  { id, topicId, optionId | null, participant: p-id, answer: "yes"|"no"|"maybe", certainty, evidence[], quote, supersededBy | null }
statements: { id, topicId, optionId | null, text, certainty, evidence[], quote }   // 確定・取り消しの発言
todos:      { id, text, assignee: p-id | null, dueIso | null, dueText | null, certainty, evidence[], quote, closed: boolean }
questions:  { id, text, evidence[], quote, closed: boolean }
共通:       needsReview: boolean, reviewReasons: string[]
```

### `todos/{targetId}_{itemId}`（登録された ToDo、US2）

| 欄 | 型 | 説明 |
|---|---|---|
| targetId, itemId | string | targets の todo と対応 |
| channelId, threadTs | string | |
| text, dueIso, dueText | | 登録した時点の値。再度 `todo` を呼んだら、未完了のものだけ更新する |
| assigneeUserId | string \| null | null は「未定」。リマインドは createdBy に送る |
| createdBy | string | `todo` を呼んだ人 |
| status | `"open" \| "done"` | |
| listMessageTs | string | ボットが返信した一覧の ts（✅ の対象） |
| sourceTs | string[] | 根拠のメッセージ（✅ の対象） |
| lastRemindedOn | string \| null | `YYYY-MM-DD`。同じ日に二重に送らない |
| doneBy, doneAt | string \| null | |
| expireAt | timestamp | 完了から 90 日、未完了なら最後の更新から 90 日 |

状態の遷移: `open → done`（ボタン、または担当者か登録者の ✅）。`done → open` は MVP ではしない。

### `canvases/{channelId}`

`canvasId`、`createdAt`。

### `chunk_cache/{sha256}`

map のキーは `channelId + 期間の区切り + 本文のハッシュ + promptVersion + model` のハッシュ。値は findings の map の結果（Finding の候補の配列）。別のキーに、直前の分割範囲とメッセージ・スレッドのハッシュの索引を保存する。同じスレッドの本文・リアクションが変わらなければ、期間や分割位置が変わっても候補を再利用する。索引が 256 KiB を超える場合は索引を空にして、通常の chunk 単位のキャッシュへ戻す。`expireAt` は 90 日。

### `processed_events/{taskName}`、`job_locks/{targetId}`

R3 のとおり。`expireAt` を持つ。

## 判定規則（decide.ts）

topic ごとに、状態を `decided` か `open` に決める。

- **D1 必要な参加者**: topic の `requiredParticipants`（提案の中でメンションされた人）を使う。空なら、スレッドで発言した人全員（ボットを除く）とする。
- **D2 明示的な確定**: `statements` のうち、`certainty = "explicit"` で `optionId` を持つ最新のものがあれば、その option で `decided` とする。ただし、その後に取り消しや変更の発言（`optionId` が別の値か null）があれば、最新の発言に従う。
- **D3 全員の合意**: D2 がない場合、必要な参加者全員の最新の回答（`supersededBy` が null のもの）が、同じ option に `yes` かつ `certainty != "uncertain"` なら `decided` とする。
- **D4 あいまいな回答**: `certainty = "uncertain"` の `yes` は「回答が残っている」として扱う（決定にしない、SC-005）。
- **D5 回答が残っている人**: `open` の topic について、必要な参加者のうち有効な回答がない人を `pendingParticipants` とする。
- **D6 要確認の伝播**: `decided` の根拠になった項目が `needsReview` なら、topic も `needsReview` とする。

## 検証規則（verify.ts）

- **V1**: `evidence` の m-id がすべて入力に存在する。存在しない ID は捨て、1 つも残らなければ `needsReview` とする。
- **V2**: `quote` を正規化（空白・記号・全角半角の違いを除く）したものが、根拠のどれかのメッセージに含まれる。含まれなければ `needsReview` とする。
- **V3**: `assignee` と `participant` が参加者の表にある（スキーマの enum で保証されるが、念のため確かめる）。
- **V4**: `dueIso` と `dateIso` が日付として正しく、元の表現に曜日があれば一致する。発言の日より 30 日以上前なら `needsReview` とする。
- **V5**: 差分の `close` と `upsert` で参照する既存の ID が実在する。なければその操作を捨てて記録する。

## 差分の適用（merge.ts）

- AI の出力のうち、新しい項目は `ref: null` で返り、コードが採番する。既存の項目の更新は `ref: "<itemId>"` で返る。
- 同じ参加者の、同じ topic への新しい回答は、古い回答の `supersededBy` を設定する。
- `close` は todo と question だけに使う（決定は D 規則で決まるため）。
- 差分の更新で AI に渡す前回の状態（`<previous_state>`）は、適用に使う状態の全体ではなく縮めた表示（contracts/llm.md の「差分の入力を減らす規則」）。merge は常に保存した状態の全体に適用するので、表示から省いた項目（完了した ToDo・問い、古い発言、上書きされた回答）は失われない。AI が参照できる ID は k・o・t・q のうち、完了していないものだけ。
- 表示用の差分（追加、変更、完了）は、適用の前後の比較から作る。
- **全体の処理し直し**: 次のどれかなら、前回の状態を捨てて全体を処理する（項目の ID は、本文と根拠が一致するものを引き継ぐ）。
  - `promptVersion` が違う。
  - 状態が 6,000 トークンを超える。
  - `analyzedDigest` と今回の取得結果を比べて、編集かリアクションの変化（ハッシュの不一致）か削除（ts が消えた）がある。

## 判定の補足（T017 の実装で決めた解釈。安全側）

- 取り消し・別の option への変更の発言があった後は、その発言より後の回答だけを D3 の合意に数える。
- `optionId` が null の yes（「どれでも」）は合意に数えない。maybe の人は回答待ち（D5）に入れる。
- 必要な参加者が 0 人なら決定しない。参加者の表にない人の回答と、根拠のない close は捨てる。
- 必要な参加者は、更新で減らさず和を取る。
- 全体の処理し直しでの ID の引き継ぎは、本文が同じで根拠が完全に一致するものを先に、次に根拠が重なるものを対応させる。消えた項目の ID は使い回さない。
