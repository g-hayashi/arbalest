---
description: "Tasks for 001-slack-coordination-bot"
---

# Tasks: Slack 調整まとめボット Arbalest（MVP）

**Input**: `specs/001-slack-coordination-bot/`（plan.md、spec.md、research.md、data-model.md、contracts/）

**Tests**: 憲章 IV（TDD）により必須。各タスクは「テストを書く → 赤を確かめる → 実装」を1体で行う（テストと実装の対）。

**参照の書き方**: R = research.md の節、D・V = data-model.md の判定規則と検証規則、`contracts/x.md#節` = 契約の節。

**実行者**: 印のないタスクは部下（implementer）。〔難所〕は implementer-hard。〔利用者〕は ADC や API キー、Slack の実データが要るため、利用者が `!` で実行する。〔メイン〕はメインが行う。

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 プロジェクトの雛形を作る。`package.json`（ESM、`engines.node >=22`、scripts: `lint`=`biome check .`、`format`、`typecheck`=`tsc --noEmit`、`build`=`tsc -p tsconfig.build.json`、`test`=`vitest run`、`test:firestore`=`vitest run -c vitest.firestore.config.ts`、`eval`=`tsx eval/run.ts`、`start`=`node dist/main.js`）。依存は plan.md の Primary Dependencies（`@slack/bolt`、`@slack/web-api`、`openai`、`zod`、`@google-cloud/firestore`、`@google-cloud/tasks`、`gpt-tokenizer`、`date-fns`、`date-fns-tz`）と、開発用の `typescript`、`@biomejs/biome`、`vitest`、`tsx`、`@types/node`。ほかに `tsconfig.json`（strict、`noUncheckedIndexedAccess`）、`tsconfig.build.json`、`biome.json`、`vitest.config.ts`（`tests/firestore` を除外）、`vitest.firestore.config.ts`（`tests/firestore` だけ）。`npm run lint && npm run typecheck && npm test` が空のテストで通ることを確かめる（R1）
- [X] T002 [P] `Dockerfile`（multi-stage、`node:22-slim`、本番の依存だけ、非 root、`CMD ["node","dist/main.js"]`）と `.dockerignore` を作る（R1、plan.md の Target Platform）

---

## Phase 2: Foundational（全ストーリーの前提）

- [X] T003 [P] 設定: `src/config.ts` を作る。zod で環境変数を検証し、`APP_ROLE`（`ingress` | `worker`）ごとの必須項目を分ける。対象は `GCP_PROJECT`、`TASKS_QUEUE`、`TASKS_LOCATION`、`TASKS_INVOKER_SA`、`WORKER_URL`（ingress のみ必須）、`SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`、`LLM_PROVIDER`（`openai-compatible` | `fake`）、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL_EXTRACT`、`LLM_MODEL_SYNTH`、`LLM_REASONING_EXTRACT?`、`LLM_REASONING_SYNTH?`、`FIRESTORE_DATABASE?`（既定 `(default)`）。テストは `tests/unit/config.test.ts`（contracts/llm.md#インタフェース、plan.md#インフラの変更）
- [X] T004 [P] 日時: `src/util/time.ts` を作る。JST の変換、営業日（月〜金、祝日なし）、`nextBusinessDay`、「今日から前後3週間の日付と曜日の表」の文字列、`10/23(金) 14:03` の形式、`ts`（Slack の文字列）と Date の相互変換。テストは `tests/unit/time.test.ts`（R6）
- [X] T005 [P] AI: `src/llm/provider.ts`（`LlmTask`、`LlmRequest`、`LlmUsage`、`LlmProvider`、`LlmError` の kind は `"rate_limit" | "server" | "schema" | "timeout" | "config"`）、`src/llm/openaiCompatible.ts`、`src/llm/fake.ts`（スキーマ名ごとの応答関数を受け取る）、`src/llm/index.ts`（`LLM_PROVIDER` で選ぶ）を作る。
  - 用途とモデルの対応: `extract` と `extract_chunk` は `LLM_MODEL_EXTRACT`、`synthesize` は `LLM_MODEL_SYNTH`。
  - 呼び出し: `zodResponseFormat` を使い、reasoning は設定があるときだけ送る。
  - スキーマの検証に失敗したら、エラーを添えて1回だけ再要求する。
  - usage は `cached_tokens` を含めて対応させ、構造化ログに出す（FR-053）。
  
  テストは `tests/unit/llm.test.ts`。openai のクライアントを差し替え、外部に接続しない（R4、contracts/llm.md#インタフェース）
- [X] T006 ストア（インタフェースとメモリの実装）: `src/store/types.ts` と、`src/store/memory/*.ts`（targets、todos、canvases、chunkCache、locks、events）を作る。
  - 項目は data-model.md#コレクション のとおりにする。`expireAt` は targets と todos が「最後の更新から 90 日」、processed_events が 7 日、job_locks がリースの期限（15 分）。
  - `events.markProcessed(taskName)` は、既にあれば false を返す。
  - `locks.acquire(targetId, ttl)` と `locks.release`。
  - `todos.findDueForReminder(today)` の条件は contracts/http-and-tasks.md#リマインドの対象 のとおり。
  
  テストは `tests/unit/store-memory.test.ts`（R3、R13）
- [X] T007 ストア（Firestore の実装）: `src/store/firestore/*.ts` を T006 のインタフェースに合わせて作る。コンストラクタで `{ databaseId, collectionPrefix }` を受け取る。
  - 重複の除去は `create()`、ロックはトランザクション、TTL の欄は `expireAt`（Timestamp）。
  
  テストは `tests/firestore/*.test.ts`。T006 と同じ振る舞いのテストを共有する（`tests/shared/storeContract.ts` を両方から呼ぶ）。
  - R9 の約束: `FIRESTORE_TEST_DATABASE` がなければ飛ばす。接続先が `(default)` なら始めずに失敗させる。接頭辞は `t<日時>_<乱数>_`。`afterAll` で `recursiveDelete` する。
  - 部下は書くだけで、実行は T032〔利用者〕で行う（Phase 2 の checkpoint でも1回実行してもらう）。
- [X] T008 [P] Slack の取得: `src/slack/conversation.ts`（`conversations.replies` / `conversations.history`、cursor でのページング、返信のある親の展開、ボットと subtype join / leave / channel_* の除外、編集後の本文）、`src/slack/users.ts`（`users.info` を 1 時間メモリにキャッシュ）、`src/slack/permalink.ts`（`auth.test` の url をキャッシュし、`/archives/<ch>/p<ts>` に返信なら `?thread_ts=&cid=` を付ける）を作る。テストは `tests/unit/slack-conversation.test.ts`、`tests/unit/permalink.test.ts`。WebClient はフェイクにする（R7、R11）
- [X] T009 [P] Cloud Tasks: `src/tasks/enqueue.ts` を作る。`createTask` で、`url = WORKER_URL + path`、`oidcToken` は `TASKS_INVOKER_SA` で audience は `WORKER_URL`、`dispatchDeadline` は 900 秒、タスク名は `evt-<event_id>`（block_actions は `act-<action_ts>-<user>`）。`ALREADY_EXISTS` は成功として扱う。テストは `tests/unit/enqueue.test.ts`（R3、R10）
- [X] T010 [P] コマンド: `src/commands/parse.ts` を作る（contracts/commands-and-output.md#文法 の表のとおり。全角を半角に。findings の既定は 30、上限は 90 で、上限を超えたら `clamped: true`）。テストは `tests/unit/parse.test.ts`
- [X] T011 ingress: `src/ingress/app.ts`（Bolt の `ExpressReceiver`、`processBeforeResponse: true`、`/healthz`）と `src/ingress/dispatch.ts` を作る。イベントを `JobPayload` に変える処理は contracts/http-and-tasks.md#ingress の表のとおり。
  - 受付の印として 👀 を付ける。解析できないときは使い方を返信する。
  - `reaction_added` は `white_check_mark` だけを `/jobs/todo-done` に積む。
  - `block_actions` の `todo_done` を `/jobs/todo-done` に積む。
  - タスクを積み終えてから ack する（R2）。
  
  テストは `tests/unit/dispatch.test.ts`。あわせて `tests/integration/ingress.test.ts` で、署名の正しいリクエストは受け付けられ、署名の不正なものは 401 になることを確かめる（FR-006）
- [X] T012 worker の土台: `src/worker/server.ts` と `src/main.ts` を作る。
  - ルートは contracts/http-and-tasks.md#worker の表のとおり。ジョブの本体は登録制にする（各 US で追加）。
  - 共通の処理: `events.markProcessed` で重複を除き、`locks.acquire(targetId)` が取れなければ「処理中です」と返信して 200 を返す。
  - Slack の `not_in_channel` / `channel_not_found` は、「チャネルに `/invite @arbalest` してください」と呼んだ人に返信して（チャネルに投稿できなければ `chat.postEphemeral` か DM）200 を返す（FR-005、spec の Edge Cases）。
  - 一時的な失敗は 5xx を返す。最後の再試行（`X-CloudTasks-TaskRetryCount` が上限）なら、失敗を返信して 200 を返す（FR-054）。
  - `main.ts` は `APP_ROLE` で ingress と worker を切り替える。
  
  テストは `tests/integration/worker.test.ts`。フェイクのジョブとメモリのストアを使う（R3）
- [X] T013 [P] 前処理: `src/analysis/preprocess.ts` を作る。
  - 1 行の形式: `[m12] 10/23(金) 14:03 田中 → m10: 本文 {👍×3: 佐藤,鈴木,高橋}`
  - `<@U>`、`<url|label>`、`<#C>` を読める形に変える。
  - 参加者の表（`p1=田中`）と、短い ID とユーザー ID の対応。
  - `m-id` と ts の対応。
  - `<context>` `<previous_state>` `<messages>` の区切り。本文の中の区切りの文字列は無害な文字に置き換える（FR-051）。
  
  テストは `tests/unit/preprocess.test.ts`。合成の会話を `tests/fixtures/` に置く（R5、contracts/llm.md#入力の形式）
- [X] T014 [P] トークンと分割: `src/analysis/tokens.ts`（`gpt-tokenizer` の o200k）と `src/analysis/chunk.ts`（スレッドを切らず、上限のトークン数で分ける。1 つのスレッドが上限を超える場合だけ、時刻順に分ける）を作る。テストは `tests/unit/chunk.test.ts`（R5: 60,000 トークン）
- [X] T015 [P] 検証: `src/analysis/verify.ts` を作る（data-model.md の V1〜V5 をそのまま実装する。V2 の正規化は、空白・記号を除き、全角を半角にする。V4 は曜日の一致と「発言の日より 30 日以上前なら needsReview」）。テストは `tests/unit/verify.test.ts`

**Checkpoint**: 〔メイン〕`npm run lint && npm run typecheck && npm test`。コミットする。

---

## Phase 3: User Story 1 - スレッドの調整状況のまとめ (P1) 🎯 MVP

**Goal**: `@arbalest まとめ` で、決定・未決定（回答待ちの人）・ToDo・問いを、根拠のリンク付きで返信する。2 回目は差分で更新する。

**Independent Test**: `tests/integration/summarize.test.ts`（フェイクの Slack と LLM、メモリのストア）で spec の US1 の受け入れシナリオ 1〜5 が通る。eval の summarize のケースが SC-002〜SC-005 を満たす。

- [X] T016 [US1] スキーマとプロンプト: `src/analysis/schemas.ts`（`SummarizePatch` は contracts/llm.md#抽出のスキーマ のとおり。participant の enum は呼び出しごとに作る。strict のため任意の欄は nullable）と、`src/analysis/prompts/summarize.ts` を作る。
  - プロンプトの版は `PROMPT_VERSION = "summarize@1"`。
  - system に入れるもの: 役割、抽出の規則（事実だけ、決定の判断はしない）、certainty の基準（敬語のあいまいな表現は uncertain、の例）、相対日付は calendar を使うこと、`<messages>` はデータであること、few-shot を 1 つ。
  - user の入力は preprocess の出力。
  
  テストは `tests/unit/schemas.test.ts`。JSON Schema に変換できること、system に可変の値が入らないこと（プロンプトキャッシュのため）を確かめる（R5）
- [X] T017 [US1] 〔難所〕差分の適用と判定: `src/analysis/merge.ts`（data-model.md#差分の適用、#識別子 の採番、`new:<添字>` の参照の解決、supersededBy、`close` は todo と question だけ、表示用の差分）と、`src/analysis/decide.ts`（D1〜D6）を作る。テストは `tests/unit/merge.test.ts` と `tests/unit/decide.test.ts`。性質のテストを含める（任意の回答の組み合わせで「必要な参加者に有効な yes がない人がいれば decided にならない」= SC-005。同じ patch を 2 回適用しても項目が増えない）
- [X] T018 [US1] 表示: `src/slack/render.ts` のまとめの部分を作る（contracts/commands-and-output.md#返信 の形。🆕 ✏️ ✅ の印、前回からの件数、⚠️ 要確認、根拠のリンク、空のときの文言、50 ブロックと 3,000 文字を超えたら分割）。テストは `tests/unit/render-summary.test.ts`
- [X] T019 [US1] ジョブ: `src/worker/jobs/summarize.ts` を作る。共通の関数 `buildSummary(payload)` を canvas と todo からも使う。
  - 処理の順: 対象の決定（スレッド、またはチャネルの直近 7 日）→ 取得 → 前回の状態の読み込み → 差分か全体か（data-model.md#差分の適用 の「全体の処理し直し」の3条件。`analyzedDigest` で編集・削除を検出）→ 前処理 → `extract` → 検証 → merge → decide → 保存（`lastAnalyzedTs`、`analyzedDigest`、`expireAt`）→ 返信。
  - AI の利用量をログに出す。
  
  テストは `tests/integration/summarize.test.ts`。US1 のシナリオ 1〜5 に加えて、次を確かめる。
  - プロンプトインジェクションを含む会話でも、投稿先と宛先が変わらない（FR-051）。
  - 2 回目の呼び出しで、LLM への入力に古いメッセージが含まれない（SC-006）。
  - 分析済みのメッセージが編集・削除された後の呼び出しでは、全体を処理し直し、最新の内容になる（spec の Edge Cases）。
  
  （R5、R11、contracts/http-and-tasks.md#worker）
- [X] T020 [US1] 評価: `eval/run.ts`、`eval/match.ts`（contracts/eval.md#一致の判定）、`eval/cases/` に summarize のケースを 12 件以上作る（合成のみ。日程の基本、リアクションでの合意、あいまいな合意、途中の変更、相対日付、担当者なし、雑談のみ、長いスレッド、インジェクション、followUp 付きを 3 件以上）。指標と閾値は contracts/eval.md#指標 のとおりで、下回ったら終了コード 1。テストは `tests/unit/eval-match.test.ts`。`LLM_PROVIDER=fake` で runner を通す

**Checkpoint**: 〔メイン〕全体の検証とコミット。〔利用者〕`npm run eval` を実行し、結果を共有する。閾値を下回る場合は、プロンプトを直して `PROMPT_VERSION` を上げる（部下に依頼する）。

---

## Phase 4: User Story 2 - ToDo の登録とリマインド (P2)

**Goal**: `@arbalest todo` で ToDo を登録し、平日の朝と期限の前日にリマインドを送る。ボタンか ✅ で完了にする。

**Independent Test**: `tests/integration/todos.test.ts` と `tests/integration/reminders.test.ts`（時刻を固定）で、US2 のシナリオ 1〜5 と SC-007 が通る。

- [X] T021 [US2] 登録と完了: `src/worker/jobs/todos.ts` を作る。
  - `/jobs/todo`: `buildSummary` の後、todo の項目を `todos/{targetId}_{itemId}` に登録する。既にあれば、未完了のものだけ更新する。担当者がいなければ null とし、`createdBy` は呼んだ人にする。一覧を返信し、各項目に `action_id = "todo_done"` で `value = todoId` のボタンを付け、`listMessageTs` を保存する。
  - `/jobs/todo-done`: 操作できるのは担当者か登録した人だけ。✅ の場合は `listMessageTs` か `sourceTs` から ToDo を特定する。`open → done` にして、一覧のメッセージを更新する（`chat.update`）。
  - 一覧の表示は `src/slack/render.ts` に追加する。
  
  テストは `tests/integration/todos.test.ts`（US2 のシナリオ 1、3、5。二重に登録しないこと。権限のない人の ✅ は無視すること）（data-model.md#todos）
- [X] T022 [US2] リマインド: `src/worker/jobs/reminders.ts`（`/cron/reminders`）を作る。
  - 対象と宛先、1 人に 1 通、期限切れの表示、`lastRemindedOn` での二重送信の防止は、contracts/http-and-tasks.md#リマインドの対象 のとおり。
  - DM は `chat.postMessage(channel = userId)`。
  - 表示は `src/slack/render.ts` に追加する。
  
  テストは `tests/integration/reminders.test.ts`。時刻を固定し、月・木・金・土の朝、期限なし、完了済み、同じ日の再実行を確かめる（US2 のシナリオ 2、4、SC-007）。あわせて、`todos.findDueForReminder` に必要な Firestore の複合インデックス（`status` と `dueIso`）を報告する（部下はインフラのリポジトリを触らない。〔メイン〕が `firestore.tf` に追加し、〔利用者〕が apply する）
- [X] T023 [US2] 退出・削除された担当者: `src/worker/jobs/reminders.ts` と `src/slack/users.ts` で、`users.info` の `deleted` が true の担当者は、宛先を `createdBy` に替え、本文に「担当者が不在です」と添える。テストは `tests/integration/reminders.test.ts` に追加する（spec の Edge Cases）

**Checkpoint**: 〔メイン〕全体の検証とコミット。

---

## Phase 5: User Story 3 - チャネル canvas への書き出し (P3)

**Goal**: `@arbalest canvas` で、チャネル canvas のスレッドごとの節を作り、更新する。

**Independent Test**: `tests/integration/canvas.test.ts` で US3 のシナリオ 1〜3 と SC-008 が通る。

- [X] T024 [US3] 〔利用者〕〔メイン〕R8 の検証: 〔メイン〕が `scripts/spike-canvas.ts` を書き、〔利用者〕がテスト用のチャネルで実行する。確かめることは次の3つ。
  1. 無償プランで、ボットのトークンを使って `conversations.canvases.create` と `canvases.edit` が動くか。
  2. 見出しの `section_id` に `replace` すると、本文まで置き換わるか。
  3. 節の外に人が書いた内容が残るか。
  
  結果は research.md の R8 に追記する。動かない場合は、US3 の方式を見直してから T025 に進む。
- [X] T025 [US3] canvas: `src/slack/canvas.ts` を作る。
  - 作成と ID の保存（`canvases/{channelId}`）。
  - 節の検索（`canvases.sections.lookup`、`contains_text: "〔arb:<threadTs>〕"`）。
  - 置き換えと追加の方式は T024 の結果に従う。
  - canvas の markdown の生成は `src/slack/render.ts` に追加する（contracts/commands-and-output.md#canvas の節）。
  
  テストは `tests/unit/canvas.test.ts`（WebClient はフェイク）
- [X] T026 [US3] ジョブ: `src/worker/jobs/canvas.ts`（`buildSummary` → 書き出し → canvas へのリンクを返信。チャネルで直接呼ばれたら案内を返す）を作り、targets に `canvasSectionMarker` を保存する。テストは `tests/integration/canvas.test.ts`（US3 のシナリオ 1〜3、再実行で節が増えないこと）

**Checkpoint**: 〔メイン〕全体の検証とコミット。

---

## Phase 6: User Story 4 - 期間の Findings (P4)

**Goal**: `@arbalest findings 30日` で、期間の会話からテーマごとの Findings を根拠付きで返信する。

**Independent Test**: `tests/integration/findings.test.ts` で US4 のシナリオ 1〜4 と FR-042（キャッシュの再利用）が通る。

- [X] T027 [US4] スキーマとプロンプト: `src/analysis/schemas.ts` に `findings_map` と `findings_reduce`（contracts/llm.md#findings のスキーマ）を追加し、`src/analysis/prompts/findingsMap.ts` と `findingsReduce.ts`（版は `findings_map@1`、`findings_reduce@1`）を作る。テストは `tests/unit/schemas.test.ts` に追加する
- [X] T028 [US4] ジョブ: `src/worker/jobs/findings.ts` を作る。
  - 処理の順: すぐに「処理中」と返信 → 期間（上限 90 日。超えたら注記）の履歴とスレッドを取得 → 前処理 → chunk → chunk ごとに `chunk_cache` を確かめ、なければ `extract_chunk` を呼んで保存 → 候補に `c<n>` を振る → `synthesize` → 根拠は candidate の evidence の和集合（コードで作る）→ V1・V2 → 表示（`src/slack/render.ts` に追加）。
  - キャッシュのキーは data-model.md#chunk_cache のとおり。
  
  テストは `tests/integration/findings.test.ts`（US4 のシナリオ 1〜4、2 回目の実行で `extract_chunk` が呼ばれないこと）
- [X] T029 [US4] 評価: `eval/cases/` に findings のケースを 3 件以上追加し、`eval/run.ts` と `eval/match.ts` を `kind: "findings"` に対応させる（contracts/eval.md）。テストは `tests/unit/eval-match.test.ts` に追加する

**Checkpoint**: 〔メイン〕全体の検証とコミット。

---

## Phase 7: Polish と最終の検証

- [X] T030 [P] `README.md` を作る（概要、ローカルでの開発コマンド、build・push・deploy の手順はインフラのリポジトリの手順を参照、環境変数の一覧）
- [X] T031 〔メイン〕全体の検証: `npm run lint && npm run typecheck && npm test && npm run build`
- [X] T032 〔利用者〕`FIRESTORE_TEST_DATABASE=arbalest-test GCP_PROJECT=<project> npm run test:firestore`
- [X] T033 〔利用者〕`npm run eval`（全ケース）。結果をメインに共有する（値はリポジトリに書かない）
- [X] T034 〔利用者〕〔メイン〕デプロイ: イメージを build して push し、ingress と worker に deploy する。Slack App の URL の検証を通し、secret を本物の値にする
- [ ] T035 〔利用者〕〔メイン〕quickstart.md の「本番での確認」の表を、テスト用のチャネルで順に確かめる。15 分以上呼ばれていない状態（コールドスタート）でメンションし、受付から ack までの時間を Cloud Logging で確かめる。3 秒を超えたら、ingress の min instances を 1 にする（Terraform、SC-001、R2）

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1 → US2 → US3 → US4 → Phase 7。
- US2・US3 は US1 の `buildSummary`（T019）に依存する。US4 は Phase 2 だけに依存するので、US1 の後ならいつでも進められる。
- Phase 2 の中: T006 → T007。T011 は T009 と T010 の後。T012 は T006 の後。ほかは独立。
- US3 の T025 は T024（R8 の検証）の結果を待つ。

## Parallel Opportunities

[P] は「並列にしてもよい」の印。クレジットを抑えるため、実行は 1 体ずつ順に行う。

- Phase 2: T003、T004、T005、T008、T009、T010、T013、T014、T015 は互いに独立。
- US1 の後では、US4（T027〜T029）と US2・US3 は独立。

## 部下へのまとめ方（1 体に渡す単位）

| 回 | タスク | 担当 |
|---|---|---|
| 1 | T001、T002 | implementer |
| 2 | T003、T004、T010 | implementer |
| 3 | T005 | implementer |
| 4 | T006、T007 | implementer |
| 5 | T008、T009、T011、T012 | implementer |
| 6 | T013、T014、T015 | implementer |
| 7 | T016、T018 | implementer |
| 8 | T017 | implementer-hard |
| 9 | T019、T020 | implementer |
| 10 | T021、T022、T023 | implementer |
| 11 | T025、T026（T024 の後） | implementer |
| 12 | T027、T028、T029 | implementer |
| 13 | T030 | implementer |

## Implementation Strategy

- **MVP = Phase 1、Phase 2、US1**。US1 の checkpoint でデプロイし（T034 を先に行ってよい）、実際のスレッドで確かめる。eval でプロンプトを詰めてから US2 以降に進む。
- 区切りごと（Phase 2、各 US）にコミットし、`/usage` の値を引き継ぎメモ（`.tmp/handoff.md`）に控える。

## Phase 8: Convergence

- [X] T036 `src/worker/server.ts` の失敗の扱いを分ける。一時的でない失敗（LlmError の schema・config、実装のバグ）は 200 と失敗の返信にし、一時的な失敗だけ 5xx で再試行させる。テストは `tests/integration/` に足す。対象は contracts/http-and-tasks.md#応答コード (partial)
- [X] T037 `src/slack/render.ts`: 根拠が 0 件の項目（V1 で ⚠️ だけ付けて残ったもの）の表示を決め（「根拠なし」と出すなど）、`tests/unit/render-summary.test.ts` にテストを足す。対象は SC-004 (partial)
- [X] T038 `src/slack/render.ts`: 分割の room を「（続き）」付きの見出しの最大長で計算する。どの見出しでも 1 section が 3,000 文字を超えないことをテストで確かめる。対象は contracts/commands-and-output.md#返信 (partial)
- [X] T039 research.md R3 に「再試行（RetryCount≥1）では重複除去を飛ばす」ことと、その理由を追記する。対象は plan の R3 (contradicts)
- [X] T040 実装済みの追加分を設計資料に反映する: `JobPayload.clamped` は contracts/http-and-tasks.md、`f_<ch>` のロックは data-model.md#識別子、`TASKS_MAX_RETRY_COUNT` は T003 の config、fast-check と light-my-request は plan の依存の一覧へ。対象は plan と contracts (unrequested)
- [X] T041 `analyzedDigest` のハッシュにリアクション（絵文字の名前と押した人を並べ替えたもの）を含め、後から付いたリアクションで全体を処理し直すようにする。テストは `tests/integration/summarize.test.ts` に足す（分析済みのメッセージにリアクションが付いた後の呼び出しで、合意が決定になる）。対象は data-model.md の analyzedDigest と #差分の適用、US1 のリアクションでの合意 (partial)

## Phase 9: Convergence

- [X] T042 `src/analysis/findings.ts` の分割とキャッシュの再利用を修正し、既定の 60,000 トークン未満の入力に新しいメッセージが追加された場合や期間が重なる場合も、すでに分析した部分の結果を再利用する。`tests/integration/findings.test.ts` に既定の分割上限での追加・重複期間のテストを足す（FR-042、R5、data-model.md#chunk_cache、HIGH、partial）。
- [X] T043 `eval/report.ts` と評価の設定に入力・キャッシュ入力・出力の単価を設定する仕組みと、1 回あたりの費用の計算・金額表示を追加する。`tests/unit/eval-run.test.ts` に単価設定と金額表示のテストを足す（FR-052、R12、MEDIUM、partial）。
- [X] T044 `src/slack/users.ts` と `src/worker/jobs/` のユーザー情報の取得を修正し、同じ worker の別ジョブ間でも `users.info` の結果を 1 時間メモリにキャッシュする。`tests/unit/slack-conversation.test.ts` と必要なジョブの結合テストで、ジョブをまたぐ再利用と期限切れ後の再取得を確かめる（T008、R11、LOW、partial）。
