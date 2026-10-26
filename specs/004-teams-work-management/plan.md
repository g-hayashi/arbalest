# Implementation Plan: Teams の ToDo と共有記録

**Feature**: `004-teams-work-management` | **Branch**: `main` | **Date**: 2026-10-26
**Spec**: [spec.md](spec.md) | **Input**: [既存設計](../../docs/teams-work-management-design.md)

## Summary

003 の認証・履歴取得・共通分析を再利用し、Teams 専用の永続 ToDo 台帳、元スレッドの管理投稿、営業日通知、任意の SharePoint List 同期を追加する。実装順序は既存設計 §9 の W01〜W09。正式化は T001、実接続 W10 は利用者タスクとする。

## Technical Context

**Language/Version**: TypeScript strict、Node.js >=22.12、ES modules。
**Primary Dependencies**: 既存 Microsoft Teams SDK（導入済み 2.1.1）、Graph v1.0、Firestore、Cloud Tasks、zod、date-fns-tz、LlmProvider。新しい外部タスク製品は導入しない。
**Storage**: `teams_*` 専用コレクションと同一契約のメモリ実装。Slack `todos` に保存しない。
**Testing**: Vitest、既存フェイク・合成 HTTP、メモリと Firestore 代替の共通契約。実 Firestore と実 AI は利用者のみ。
**Target Platform / Project Type**: 既存の ingress/worker サービス。`CHAT_PLATFORM=teams`、`APP_ROLE` の分離を維持。
**Performance Goals**: ingress は3秒以内に軽い検証と投入を完了し、重い処理を worker へ渡す。invoke は SDK の契約で速やかに応答する。
**Constraints**: snapshot は UTF-8 JSON で256KiB以下、Teams の各テキスト slot は既存 `TEAMS_MESSAGE_LIMIT` 以下、SharePoint の各生成列8,000文字以下、保持90日、カード最大7日。
**Scale/Scope**: allowlist の標準チャネル、targetId ごとに直列化。個人/グループ/private/shared は対象外。新機能の既定は無効。

## Constitution Check

| 原則 | 事前・設計後の判定 |
| --- | --- |
| I 提供元非依存 | 合格。既存 LlmProvider と用途設定を維持しモデル名を追加しない |
| II 抽出とコードの判定 | 合格。既存分析を使い、照合・権限・副作用・表示はコード |
| III 根拠検証 | 合格。MessageRef と検証済み引用を保存し、不一致は要確認、登録不可 |
| IV TDD | 合格。W ごとのテスト→赤→実装。代替実装で外部接続なし |
| V 安全・最小権限 | 合格。SDK 認証、allowlist、カード scope/権限再検査、Selected の有効化ゲート |
| 既存の技術制約 | 合格。非同期実行と重複除去を維持。Teams 認証は003同様 Microsoft SDK。Slack 署名検証に変更なし |

憲章違反なし。インフラ変更、本番変更、実データの保存・記録は含めない。

## Project Structure

### Documentation

`specs/004-teams-work-management/`: spec.md、plan.md、research.md（R1〜R10）、data-model.md（D1〜D8/V1〜V8）、contracts/work-management.md（C1〜C10）、quickstart.md、tasks.md、checklists/requirements.md。

### Source Code

- `src/teams/types.ts` / `graph.ts`: 永続根拠と取得 ID の対応（W01）。
- `src/teams/todo-identity.ts`: 保守的な同一性照合（W02）。
- `src/teams/store/types.ts` / `memory.ts` / `firestore.ts`: Teams 専用台帳・操作参照・副作用予約（W03）。既存 `src/store/firestore/index.ts` の接続と prefix 設計を参考にする。
- `src/teams/actions.ts` / `runtime.ts`: カードの検証・受付・worker 再検査（W04）。
- `src/teams/todos.ts` / `job.ts` / `render.ts`: 登録・一覧・候補・抑止・完了の接続（W05）。
- `src/teams/records.ts` / `runtime.ts`: ID 必須の writer、固定 snapshot、slot 更新と復旧（W06）。
- `src/teams/reminders.ts` / `src/util/time.ts`: 営業日通知。既存純粋関数を共有（W07）。
- `src/teams/sharepoint.ts`: 固定 List 対応、Selected、etag・hash による同期（W08）。
- `src/config.ts` / `src/main.ts` / `src/teams/runtime.ts` / `src/worker/server.ts`: 起動と worker/cron・修復の接続（W09）。
- `tests/unit/teams-*.test.ts`、`tests/shared/teamsStoreContract.ts`、`tests/unit/teams-store-memory.test.ts`、`tests/unit/teams-store-firestore.test.ts`、`tests/integration/teams-*.test.ts`: W 対応のテスト。Firestore 版 unit は注入した代替 DB のみを使う。

**Structure Decision**: Slack Store/TodoDoc を流用せず専用 repo を組み、分析・時刻の純粋関数だけ共有する。既存 TeamsReply は通常返信の互換性を維持し、管理投稿には別の TeamsRecordWriter を追加する。

## Delivery and Validation

W01〜W07/W09 で Teams 内の MVP を提供できる。W08 は任意の外部同期で、W10 の権限・閲覧範囲確認まで有効化しない。W08 の有効化ゲートが未達でも内部記録を削除しない。

各ペア担当は対象のテストのみ実行し、既存実装があればテストで確かめて失敗時だけ修正する。共有型・エラー変更時は全参照テストを検索して追随する。最後にメインが lint/typecheck/全フェイクテスト/build を1回実行する。実接続・実 AI・実 Firestore は実行しない。

## Complexity Tracking

追加の憲章例外なし。通信の応答紛失と競合を扱う必要があるため、台帳・表示・外部同期・結果返信を独立した進捗とする。Teams の送信と Firestore は原子的でなく、厳密な一度だけの配信と外部投稿の即時順序保証はしない。
