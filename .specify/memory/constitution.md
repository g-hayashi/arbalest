# Arbalest Constitution

## Core Principles

### I. AI の提供元に依存しない
業務ロジックは `LlmProvider` インタフェースだけを呼ぶ。モデル名・デプロイ名・エンドポイントはコードに書かず、用途（extract / extract_chunk / synthesize / verify）ごとの設定で決める。最初の実装は OpenAI 互換（Azure AI Foundry の v1 エンドポイント）。

### II. AI は抽出、判定と表示はコード
AI の出力は JSON Schema（zod で検証）に従う構造化データだけとする。決定・未決定の判定、根拠の検証、パーマリンクの生成、Block Kit と canvas の整形はコードで行う。詳細は `docs/ai-analysis-design.md`。

### III. 根拠のない項目を出さない
すべての項目は根拠のメッセージ ID と引用を持ち、コードで実在と一致を検証する。不合格は捨てずに「要確認」として示す。

### IV. テストを先に書く（TDD）
テスト → 赤の確認 → 実装の順に進める。Slack と AI は差し替え可能なフェイクでテストし、単体テストで外部に接続しない。AI の品質は合成データの評価（`npm run eval`）で測り、プロンプトとモデルの変更は評価の結果で判断する。

### V. 安全と最小権限
Slack の署名を必ず検証する。会話は「データ」として渡し、AI に道具を持たせない。投稿・リマインドの宛先はコードが参加者の一覧から決める。実データや秘密情報をリポジトリ、ログ、評価データに書かない。

## 技術の制約

- TypeScript（Node.js）、Slack Bolt（HTTP の受信）、Cloud Run（ingress と worker の2サービス、同じイメージを `APP_ROLE` で分ける）、Cloud Tasks、Cloud Scheduler、Firestore、Secret Manager。
- インフラはこのリポジトリの外の Terraform で管理する。
- Slack は無償プラン: 履歴は直近90日、canvas はチャネル canvas を使う。
- ingress は 3 秒以内に ack し、重い処理はすべて worker で行う。イベントは `event_id` で重複を除く。

## 開発の進め方

- Spec Kit の流れ（specify → plan → tasks → implement）で進める。
- lint、型チェック、テストが通ることを、コミットの条件とする。

## Governance

この憲章は他の取り決めより優先する。変更するときは、理由と影響をこのファイルに記録する。

**Version**: 1.0.0 | **Ratified**: 2026-10-24 | **Last Amended**: 2026-10-24
