# AGENTS.md

Slack ボット Arbalest。スレッドやチャネルの会話から、決定事項・未決定事項・ToDo・Findings をまとめ、Slack のメッセージかチャネル canvas に書き出す。ToDo のリマインドも行う。

## 必ず読む資料

- `.specify/memory/constitution.md`（原則）
- `docs/ai-analysis-design.md`（AI での分析の方式）
- `specs/<feature>/` の spec.md / plan.md / tasks.md（担当の節だけ）。設計は research.md（R 番号）、data-model.md（D・V 規則）、contracts/

## コマンド

- npm は `npm_config_cache=$TMPDIR/npm-cache` を付ける（sandbox で ~/.npm に書けないため）。
- `npm ci` / `npm run lint`（Biome）/ `npm run format`（Biome、触ったファイルだけ: `npx biome format --write <files>`）
- `npm run typecheck` / `npm run build`（tsc）
- `npm test`（vitest。フェイクの Slack・LLM、メモリのストア）。1ファイルだけ: `npx vitest run <path>`
- `npm run test:firestore`（実際の Firestore のテスト専用 DB `arbalest-test` を使う。ADC が必要なので利用者が実行する。部下とメインは実行しない。`FIRESTORE_TEST_DATABASE` がなければ飛ばされる）
- `npm run eval`（実際の AI を呼ぶ。API キーが要るので利用者が実行する。部下とメインは実行しない。`eval/` のコードは `LLM_PROVIDER=fake` でテストする）

## 規約

- TypeScript（strict）。コメントと文書は日本語。
- AI の呼び出しは `LlmProvider` を経由する。モデル名やデプロイ名をコードに書かない。
- テストは Slack・AI・Firestore をフェイクかメモリの実装で置き換え、外部に接続しない（例外は `tests/firestore/` だけ。R9 の約束を守る）。
- ファイルの変更は Edit / Write ツール（Codex では apply_patch）で行う。sed や python で書き換えない。整形は自分が触ったファイルだけに掛ける。

## 触ってはいけないもの

- 実際の Slack のデータ、トークン、API キー。リポジトリ、ログ、テストデータ、評価データに書かない。評価データは合成した会話だけを使う。
- `.env*` ファイル（sandbox で読めない。値は Secret Manager にある）。
- インフラのリポジトリ（Terraform、このリポジトリの外。インフラの変更はメインに依頼する）。
- 本番の GCP プロジェクトへのデプロイや変更。

## 一時ファイル

`.tmp/`（コミットしない）。作業の状態と残りのタスクは `.tmp/handoff.md`。
