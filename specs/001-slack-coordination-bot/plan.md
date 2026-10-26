# Implementation Plan: Slack 調整まとめボット Arbalest（MVP）

**Branch**: `main`（機能ディレクトリ `001-slack-coordination-bot`） | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-slack-coordination-bot/spec.md`

## Summary

Slack のメンションを受けて、スレッド・チャネルの会話から決定事項・未決定事項・ToDo・Findings を抽出し、スレッドへの返信かチャネル canvas に書き出す。ToDo は平日の朝と期限の前日にリマインドする。
受付（ingress）は署名を検証して 3 秒以内に ack し、Cloud Tasks に積む。重い処理（Slack の取得 → 前処理 → AI の抽出 → 検証 → 判定 → 保存 → 表示）は worker が行う。
AI は `LlmProvider`（OpenAI 互換、Azure AI Foundry）を経由し、抽出だけを担う。判定・検証・表示はコード（`docs/ai-analysis-design.md`）。

## Technical Context

**Language/Version**: TypeScript 5.x（strict）、Node.js 22 LTS（コンテナ）。ローカルの Node 26 でも動くようにする（R1）

**Primary Dependencies**: `@slack/bolt`（HTTP 受信、ExpressReceiver）、`@slack/web-api`、`openai`（OpenAI 互換クライアント）、`zod`、`@google-cloud/firestore`、`@google-cloud/tasks`、`gpt-tokenizer`、`date-fns` + `date-fns-tz`（R1〜R6）。開発用: `vitest`、`fast-check`（プロパティテスト）、`light-my-request`（HTTP ハンドラーのテスト。ポートを開かない）

**Storage**: Firestore（Native、`(default)`、asia-northeast1）。コレクションは data-model.md

**Testing**: vitest。Slack と LLM はフェイク、リポジトリ層は Firestore のテスト専用 DB `arbalest-test`（R9、利用者が実行）。AI の品質は `npm run eval`（合成データ、実際の AI を呼ぶ）

**Target Platform**: Cloud Run（linux/amd64）。ingress と worker の 2 サービス、同一イメージを `APP_ROLE` で分ける

**Project Type**: web-service（Slack ボット、HTTP のみ。画面なし）

**Performance Goals**: ack 3 秒以内（SC-001）。200 件のスレッドのまとめ 60 秒以内。findings 90 日は 15 分以内（worker の timeout）

**Constraints**: Slack 無償プラン（履歴 90 日、チャネル canvas のみ）。組織ポリシー（asia-northeast1、SA キー禁止、allUsers 不可）。AI の同時呼び出しはキューで 3 まで

**Scale/Scope**: 1 ワークスペース、数十人、数十チャネル。メンションは 1 日数十回程度

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 計画での対応 | 判定 |
|---|---|---|
| I. 提供元に依存しない | `LlmProvider` インタフェース、用途（`extract` / `extract_chunk` / `synthesize`）ごとのモデルを環境変数で設定。環境変数名も `LLM_*` に変更（R4、contracts/llm.md） | PASS |
| II. AI は抽出、判定と表示はコード | AI の出力は zod スキーマの JSON。決定の判定（`decide.ts`）、検証（`verify.ts`）、Block Kit / canvas の生成はコード（R5、data-model.md の判定規則） | PASS |
| III. 根拠のない項目を出さない | 全項目に `evidence` と `quote`。検証に落ちたら `needsReview`（data-model.md の V 規則） | PASS |
| IV. TDD | ユーザーストーリーごとにテストとの対。評価は `npm run eval`（contracts/eval.md） | PASS |
| V. 安全と最小権限 | Bolt の署名検証、AI に道具なし、宛先は参加者の enum、worker は IAM 必須、評価は合成データのみ | PASS |

Phase 1 後の再確認: 違反なし（Complexity Tracking は空）。

## Project Structure

### Documentation (this feature)

```text
specs/001-slack-coordination-bot/
├── plan.md
├── research.md          # R1〜R12
├── data-model.md        # コレクション、状態遷移、判定規則（D1〜D6）、検証規則（V1〜V5）
├── quickstart.md
├── contracts/
│   ├── http-and-tasks.md        # エンドポイント、タスクの payload
│   ├── commands-and-output.md   # メンションの文法、返信と canvas の形式
│   ├── llm.md                   # LlmProvider、抽出のスキーマ、プロンプトの構成
│   └── eval.md                  # 評価ケースの形式と指標
└── tasks.md             # /speckit-tasks で作る
```

### Source Code (repository root)

```text
src/
├── main.ts                  # APP_ROLE で ingress / worker を起動
├── config.ts                # 環境変数の読み込みと検証（zod）
├── ingress/
│   ├── app.ts               # Bolt（ExpressReceiver）: app_mention, reaction_added, block_actions
│   └── dispatch.ts          # イベント → タスクの payload（コマンドの解析を含む）
├── worker/
│   ├── server.ts            # /jobs/*, /cron/reminders, /healthz
│   └── jobs/
│       ├── summarize.ts     # US1（canvas は US3 で出力先を追加）
│       ├── todos.ts         # US2 登録、完了の操作
│       ├── reminders.ts     # US2 リマインド
│       ├── canvas.ts        # US3
│       └── findings.ts      # US4
├── commands/parse.ts        # 「まとめ」「todo」「canvas」「findings 30日」
├── slack/
│   ├── conversation.ts      # 取得（replies / history、ページング、スレッドの展開）
│   ├── users.ts             # 表示名のキャッシュ
│   ├── permalink.ts         # パーマリンクの生成（R7）
│   ├── render.ts            # Block Kit の生成
│   └── canvas.ts            # チャネル canvas の作成と節の置き換え（R8）
├── analysis/
│   ├── preprocess.ts        # 1 行形式、記法の変換、参加者の表、日付の表
│   ├── tokens.ts            # トークン数の計算と分割の判断
│   ├── chunk.ts             # スレッドを切らない分割
│   ├── schemas.ts           # zod: 抽出・差分・findings のスキーマ
│   ├── prompts/             # summarize.ts, findingsMap.ts, findingsReduce.ts（PROMPT_VERSION 付き）
│   ├── verify.ts            # V1〜V5
│   ├── decide.ts            # D1〜D6
│   └── merge.ts             # 差分の適用、項目 ID の採番
├── llm/
│   ├── provider.ts          # LlmProvider、LlmTask
│   ├── openaiCompatible.ts
│   ├── fake.ts              # テスト用（決まった応答を返す）
│   └── index.ts             # LLM_PROVIDER で実装を選ぶ
├── store/
│   ├── types.ts             # リポジトリのインタフェース
│   ├── memory/*.ts          # メモリの実装（テスト用）
│   └── firestore/*.ts       # Firestore の実装（targets, todos, canvases, chunkCache, locks, events）
├── tasks/enqueue.ts         # Cloud Tasks（OIDC、タスク名で重複を除く）
└── util/time.ts             # JST、営業日、相対日付の表

tests/
├── unit/                    # preprocess, decide, verify, merge, parse, render, time, chunk
├── integration/             # フェイクの Slack と LLM、メモリのストアでジョブを通す
├── firestore/               # store の Firestore 実装（arbalest-test、npm run test:firestore）
└── fixtures/                # 合成の会話（テスト用）

eval/
├── cases/*.json             # 合成の会話と正解（contracts/eval.md）
└── run.ts                   # npm run eval

Dockerfile
```

**Structure Decision**: 単一の Node プロジェクト。ingress と worker は同じコードベースで、`APP_ROLE` によって起動するサーバーだけが変わる。

### インフラの変更（インフラのリポジトリ、メインが行う）

- 環境変数を提供元に依存しない名前に変える: `AZURE_OPENAI_ENDPOINT` → `LLM_BASE_URL`、`AZURE_OPENAI_DEPLOYMENT` → `LLM_MODEL_EXTRACT` と `LLM_MODEL_SYNTH`、secret の参照名 `AZURE_OPENAI_API_KEY` → `LLM_API_KEY`（secret 本体の名前 `azure-openai-api-key` は変えない）。`LLM_PROVIDER=openai-compatible` を追加。
- worker に `TASKS_MAX_RETRY_COUNT`（任意。キューの max_attempts - 1 に合わせる。未設定なら 4）を渡す。`X-CloudTasks-TaskRetryCount` がこの値以上なら最後の試行とみなし、失敗を返信して 200 で終える（`src/main.ts`、`src/worker/server.ts`）。
- Firestore の TTL を追加: `targets`、`todos`、`chunk_cache` の `expireAt`。
- ingress に `SLACK_TEAM_DOMAIN` は不要（`auth.test` で取得してキャッシュ、R7）。

## Complexity Tracking

なし。
