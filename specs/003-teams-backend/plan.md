# Implementation Plan: Teams 共通バックエンド

## Technical Context

TypeScript / Node >=22.12、Microsoft Teams SDK、Graph v1.0、既存 Cloud Tasks / worker / Firestore / LlmProvider。
Slack のジョブを Teams に偽装せず、分析の純粋関数を共有する。設定 `CHAT_PLATFORM=slack|teams` は既定 slack。
ingress/worker は同じイメージを利用し、Teams 構成は Slack の秘密を必要としない。

## Constitution Check

LLM の提供元非依存、構造化抽出、根拠検証、TDD、認証、非同期処理を維持。
Teams への拡張として受信認証は Microsoft SDK に任せる。基盤・本番は変更しない。

## Structure

- `src/teams/types.ts`: ジョブ・Graph メッセージ・会話参照。
- `src/teams/graph.ts`: Graph HTTP、ページング、本文正規化、元メッセージIDと分析時刻IDの対応。
- `src/teams/ingress.ts`: SDK 認証、メンション検査、許可組織/チーム、タスク投入。
- `src/teams/render.ts`: Teams 向けテキスト・根拠リンク・分割。
- `src/teams/job.ts`: 共通分析・Findings、名前空間保存、返信。
- `src/teams/runtime.ts`: SDK、Graph、worker と起動の接続。
- `src/config.ts` / `src/main.ts`: platform による構成の選択。

## Delivery

標準チャネルまとめと Findings を初版として完結させる。ToDo 管理と SharePoint/タブの外部記録は別機能とする。
依存SDKのMSALに既知の脆弱性があるため修正版へ scoped override し、使用する client-credentials API の互換性をテストする。
