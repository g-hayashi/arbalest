# Research: Slack 調整まとめボット Arbalest（MVP）

各項目は Decision / Rationale / Alternatives。実装の前に確かめる点は「要検証」と書き、tasks の最初の検証タスクで確かめる。

## R1. 言語・ランタイム・ツール

- **Decision**: TypeScript strict、Node.js 22 LTS（`node:22-slim` のコンテナ）、npm、ESM。lint と整形は Biome、テストは vitest、ビルドは `tsc`。
- **Rationale**: Bolt と Google Cloud の SDK が公式に対応。Biome は lint と整形を 1 つで済ませられ、設定が少ない。
- **Alternatives**: ESLint + Prettier（設定が多い）、pnpm（利用者の指示が `npm run eval`）。

## R2. Slack の受信（ingress）

- **Decision**: Bolt の `ExpressReceiver`（HTTP）、`processBeforeResponse: true`。ハンドラの中でタスクを積んでから `ack()` する。対象は `app_mention`、`reaction_added`（✅ = `white_check_mark`）、`block_actions`（完了のボタン）。署名の検証は Bolt に任せる（`SLACK_SIGNING_SECRET`）。
- **Rationale**: Cloud Run のリクエスト課金では、応答の後の CPU が絞られる。応答の前にタスクを積み終える（数百 ms）ことで、処理が途中で止まらない。
- **Alternatives**: 応答の後に処理を続ける（CPU が絞られて失敗しうる）、Socket Mode（常時接続が Cloud Run に合わない）。
- **コールドスタート**: min instances 0 のまま始める。3 秒を超えた場合は Slack が再送し、R3 の重複除去で吸収する。問題になれば ingress の min instances を 1 にする（Terraform の変更）。

## R3. 重複と同時実行

- **Decision**:
  - Slack の再送: Cloud Tasks のタスク名を `evt-<event_id>` にする。同じ名前は `ALREADY_EXISTS` になり、成功として扱う。
  - worker の冪等性: `processed_events/{taskName}` を `create()` で作る（あれば処理しない）。`expireAt` は 7 日後。
  - 同じ対象の同時処理: `job_locks/{targetId}` をトランザクションでリースとして取る（有効期限 15 分）。取れなければ「処理中です」と返信する。
  - 再試行（`X-CloudTasks-TaskRetryCount` ≥ 1）では重複の除去を飛ばす。最初の試行（RetryCount = 0）だけが `markProcessed` を呼ぶ。実装は `src/worker/server.ts` の冒頭のコメントと `runJob` の `retryCount === 0` の判定。
- **Rationale**: Slack は 3 秒以内に ack がないと最大 3 回再送する。Cloud Tasks も少なくとも 1 回の配信なので、worker の側でも重複を除く必要がある。
- **再試行で重複除去を飛ばす理由**: `processed_events` は最初の試行で作られるので、失敗して 5xx を返したジョブを Cloud Tasks が再送しても、除去を掛けると必ず「重複」と判定されて 200 を返し、再試行が空振りしてジョブが完了しない。最初の試行が成功した後の重複配信は RetryCount が 0 なので、これまでどおり除かれる。再試行の多重実行は `job_locks` が防ぐ。
- **Alternatives**: Firestore だけで重複を除く（ingress が Firestore を読む分、ack が遅くなる）。

## R4. AI の呼び出し（LlmProvider）

- **Decision**: `openai` パッケージの Chat Completions を `baseURL = LLM_BASE_URL`（Azure は `https://<resource>.openai.azure.com/openai/v1/`）で使う。`response_format` は `zodResponseFormat`（strict の JSON Schema）。用途ごとの設定は `LLM_MODEL_EXTRACT`、`LLM_MODEL_SYNTH`（`extract_chunk` は EXTRACT、`synthesize` は SYNTH を使う）。推論の強さは `LLM_REASONING_EXTRACT` / `LLM_REASONING_SYNTH`（任意。未設定なら送らない）。
- **Rationale**: Chat Completions と JSON Schema は、OpenAI 互換の提供元のあいだで最も広く使える。Responses API は提供元によって対応にばらつきがある。
- **再試行**: 429 と 5xx は SDK の再試行（最大 3 回）。スキーマの検証に失敗したら、エラーを添えて 1 回だけ再要求する。
- **strict の制約**: すべての欄を必須にし、任意の欄は `nullable` で表す。
- **記録**: 毎回 `usage`（`prompt_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens`）を、構造化ログで出す（FR-053）。
- **Alternatives**: Vercel AI SDK や LiteLLM（依存が増える。必要になれば `LlmProvider` の実装として足せる）。

## R5. 抽出の方式

- **Decision**: `docs/ai-analysis-design.md` に従う。要点は次のとおり。
  - 1 行形式（`[m12] 10/23(金) 14:03 田中 → m10: 本文 {👍×3: 佐藤,鈴木,高橋}`）。
  - 参加者の表（`p1=田中` のような短い ID。担当者と回答者は enum でこの ID に限る）。
  - 今日の日付と、前後 3 週間の日付・曜日の表。
  - 事実を細かく抽出する（topic、option、response、decision_statement、todo、open_question）。決定はコード（data-model の D 規則）で判定する。
  - 根拠を先に書かせるため、スキーマの欄の順を `evidence`、`quote`、結論の順にする。
  - プロンプトは、変わらない部分（規則、例）を system に置き、変わる部分を user の末尾に置く（プロンプトキャッシュ）。
- **差分の更新**: 2 回目以降は、前回の状態（項目 ID と要旨。根拠は付けない）と新しいメッセージだけを渡す。AI は差分（`upsert`、`close`）を返す。プロンプトの版が変わったとき、状態が 6,000 トークンを超えたとき、分析済みのメッセージが編集・削除されたとき、リアクションが変わったとき（`analyzedDigest` で検出、data-model.md）は、全体を処理し直す。
- **分割**: 入力が 60,000 トークンを超えたら、スレッドを切らずに分割する（findings は常に分割の経路）。

## R6. 日付・時刻

- **Decision**: 内部は UTC の ISO 文字列、表示と判定は `Asia/Tokyo`（`date-fns-tz`）。営業日は月〜金で、祝日は考慮しない。
- 相対日付は AI に ISO の日付と元の表現の両方を出させ、日付の表と曜日の一致をコードで確かめる（V4）。

## R7. パーマリンク

- **Decision**: `auth.test` で得たワークスペースの URL を起動時にキャッシュする。リンクは `https://<domain>.slack.com/archives/<channel>/p<ts の数字>` で組み立てる。スレッドの返信なら `?thread_ts=<thread_ts>&cid=<channel>` を付ける。
- **Rationale**: `chat.getPermalink` を項目ごとに呼ぶと、API の制限に当たる。
- **Alternatives**: `chat.getPermalink`（正確だが呼び出しが多い。組み立てが失敗する特殊な場合だけの予備にする）。

## R8. チャネル canvas と節の置き換え（T024 で検証済み）

- **検証の結果**（2026-10-25、無償プラン、ボットのトークン。`scripts/spike-canvas.ts`、`scripts/spike-canvas2.ts`）:
  1. `conversations.canvases.create` と `canvases.edit` は動く。チャネル canvas が既にあると create は `free_team_canvas_tab_already_exists` になる。既存の ID は `conversations.info` の `channel.properties.tabs[]`（`type: "canvas"`）の `data.file_id` で取れる。
  2. canvas の「節」（section_id）はブロック 1 つ。見出しの section_id に `replace` しても見出しのブロックだけが置き換わり、下の本文は残る。
  3. 節の外に人が書いた内容は残る。
  4. 行末の空白 2 つか `\` の改行でつないだ段落は 1 ブロックになる。箇条書きとチェックリストは項目ごとに別のブロック。引用は 1 ブロックだが行がつながる。`<br>` は文字のまま出る。チェックリストは普通の箇条書きで表示される。
  5. `contains_text` は本文のブロックの文字列も引ける。
  6. `canvases.edit` の `changes` は 1 回に 1 件まで。`delete`（section_id 指定）は 1 件ずつなら動く。
- **Decision**:
  - canvas の ID: `canvases/{channelId}` に保存したものを使う。なければ `conversations.info` の tabs から探し、それもなければ `conversations.canvases.create` で作る。create が `free_team_canvas_tab_already_exists` なら tabs から探し直す（同時に作ろうとした場合）。見つけた ID は保存する。
  - 節は「目印付きの h2」と「本文の 1 ブロック」の 2 ブロック（contracts/commands-and-output.md の canvas の節）。目印 `〔arb:<threadTs>〕` は両方に入れる。
  - 更新の手順: (a) `sections.lookup`（`contains_text: 目印`）で今のブロックの ID を全部取る。(b) 見出しの ID（`section_types: ["any_header"]` と目印で引く）を、新しい見出し＋本文の markdown で `replace` する。(c) (a) の ID のうち見出し以外を 1 件ずつ `delete` する。(a) で何も見つからなければ `insert_at_end` で足す。見出しが見つからず本文だけが残っていれば、本文を消してから `insert_at_end` する。
  - 人が節の本文を編集しても、次の更新で置き換わる（節の中はボットのもの）。
- **Alternatives**: canvas 全体を書き直す（人が書いた内容が消えるため不可、FR-031）。各行に目印を付ける（見た目が崩れるため不採用。本文を 1 ブロックにできたので不要）。

## R9. Firestore とテスト

- **Decision**: リポジトリごとにインタフェースを作り、Firestore の実装とメモリの実装を置く。
  - 単体テストとジョブの結合テストは、メモリの実装を使う。
  - Firestore の実装は、実際のプロジェクトの**テスト専用データベース `arbalest-test`**（Terraform で作成済み、本番の `(default)` とは別）で確かめる（`npm run test:firestore`）。
- **安全のための約束**:
  - 接続先のデータベース ID が `(default)` なら、テストを始めずに失敗させる。
  - 実行ごとにコレクションの接頭辞（`t<日時>_<乱数>_`）を付け、終了時に `recursiveDelete` で自分のデータを消す。
  - 接頭辞はリポジトリのコンストラクタで渡す（本番は空）。
- **認証と実行者**: ADC（`gcloud auth application-default login`）を使う。sandbox から ADC は読めないため、`npm run test:firestore` は利用者が `!` で実行する。メインと部下は実行しない。環境変数 `FIRESTORE_TEST_DATABASE` がなければ、テストを飛ばす（`describe.skipIf`）。
- **費用**: 読み書きは数百件程度で、ほぼ0円。
- **Alternatives**:
  - Firestore エミュレータ: Java が必要で、利用者の方針で入れない。
  - Docker のエミュレータ: Docker のデーモンが起動していない。
  - 本番の `(default)` に接頭辞を付けて使う: 誤って本番のデータを消す危険がある。

## R10. Cloud Tasks

- **Decision**: `@google-cloud/tasks` の `createTask` を使う。設定は次のとおり。
  - `httpRequest.url = WORKER_URL + path`
  - `oidcToken.serviceAccountEmail = TASKS_INVOKER_SA`、`audience = WORKER_URL`
  - `dispatchDeadline = 900s`
  - タスク名は R3 のとおり。
  
  worker 側では、IAM（Cloud Run の認証）を通ったリクエストだけが届くので、アプリ側でのトークンの検証はしない。
- **リマインド**: Cloud Scheduler が `/cron/reminders` を呼ぶ。worker が対象の ToDo を集めて、担当者ごとに DM を送る。

## R11. 会話の取得

- **Decision**:
  - スレッドは `conversations.replies`、チャネルは `conversations.history`（`oldest` で期間を指定）で取る。返信のあるメッセージは `conversations.replies` で展開する。
  - ページングは `cursor`。429 は WebClient の自動の再試行に任せる。
  - 表示名は `users.info` をメモリにキャッシュする（1 時間）。
  - ボット自身と、subtype が join / leave / channel_* のメッセージは除く。
- **Rationale**: 自社のワークスペース専用のアプリ（Marketplace に出さない）なので、2025 年の API の厳しい制限は受けない。
- **無償プラン**: 90 日より古い履歴は取れない。findings の期間は 90 日を上限とする。

## R12. 評価

- **Decision**:
  - `eval/cases/*.json`（合成の会話と正解）を `eval/run.ts` で処理する。ジョブと同じパイプライン（前処理 → AI → 検証 → 判定）を通し、Slack への出力だけを省く。
  - 一致の判定は、根拠のメッセージ ID の重なり（1 つ以上）と、種類ごとの欄（担当者、期限、選ばれた候補）で行う。AI に採点させないので、結果が安定し、費用もかからない。
  - 結果は `.tmp/eval/<日時>.json` に保存し、前回と比べた表を出す。
- **実行**: 実際の AI を呼ぶため、`LLM_*` を環境変数で渡してローカルで実行する。CI では実行しない。

## R13. 保存期間

- `targets`、`todos`、`chunk_cache` には `expireAt`（最後の更新から 90 日）を付け、TTL で削除する。Terraform に TTL の設定を追加する。
- `processed_events` は 7 日、`job_locks` はリースの期限で削除する。
