# Tasks: Teams 共通バックエンド

## Phase 1: Design

- [X] T001 `spec.md`、`plan.md`、`research.md`、`data-model.md`、`contracts/teams.md` に初版の範囲と公式根拠を記録する。

## Phase 2: US1 — 安全な履歴取得

- [X] T002 [US1] `tests/unit/teams-graph.test.ts` にページング、HTML、削除/ボット、ID衝突、URL検査、上限/エラーの赤テストを書く（R1/R3、D2、V1/V2、C2）。
- [X] T003 [US1] `src/teams/types.ts`、`src/teams/graph.ts` に正規化とGraph取得を実装する（T002、R1/R3、D2、C2）。
- [X] T004 [US1] `tests/unit/teams-ingress.test.ts` に認証後のtenant/team/mention/宛先検証、固定taskNameと投入失敗の赤を書く（R2/R4、D1、V1、C1）。
- [X] T005 [US1] `src/teams/ingress.ts` に検証とenqueueを実装する（T004、C1）。
- [X] T006 [US1] `tests/integration/teams-job.test.ts`、`tests/unit/teams-render.test.ts` に共通分析・名前空間保存・根拠返信・失敗の赤を書く（R3、D3、V2、C3）。
- [X] T007 [US1] `src/teams/job.ts`、`src/teams/render.ts` を実装する（T006、C3）。

## Phase 3: US2 — Findings

- [X] T008 [US2] `tests/integration/teams-job.test.ts` に期間前の親への返信と期間外除外、自然文・clarifyの赤を書く（R1/R3、C2/C3）。
- [X] T009 [US2] `src/teams/job.ts` に共有意図解釈・Findingsを接続する（T008）。

## Phase 4: Runtime and delivery

- [X] T010 `tests/unit/config.test.ts`、`tests/integration/teams-runtime.test.ts`、`tests/unit/teams-main.test.ts` にTeams起動設定、SDK未認証拒否、受信→キュー→worker→Teams返信の赤と起動経路の検証を書く（R2、V1、C1/C3/C4）。
- [X] T011 `src/config.ts`、`src/main.ts`、`src/teams/runtime.ts`、必要なら `src/worker/server.ts` のTeams起動と通知を接続する（T010、C4）。
- [X] T012 `docs/teams-setup.md`、`teams/manifest.template.json`、`scripts/package-teams.ts`、`tests/unit/teams-package.test.ts`、`specs/003-teams-backend/quickstart.md` に登録・RSC・ZIP生成・テスト・制約・回復・切り戻しを記録し検証する。
- [X] T013 lint、typecheck、全フェイクテスト、build、依存監査と差分確認を行う。
- [ ] T014 利用者: 実Teamsアプリ登録・同意・テスト用環境でまとめ/Findings/権限拒否を検証する（実資格情報が必要。本番変更は禁止）。

## Reliability review

- [X] T015 `tests/integration/teams-job.test.ts`、`tests/shared/storeContract.ts` に部分返信後の履歴/LLM変動でも同じ返信を再開する赤を書く。`src/teams/job.ts`、`src/store/types.ts` の既存進捗に任意の返信snapshotを追加し、投稿前保存・256KiB上限・既送信slotのスキップを実装する（D4、C3）。
- [X] T016 `tests/unit/teams-graph.test.ts`、`src/teams/graph.ts`、`tests/unit/teams-ingress.test.ts`、`src/teams/ingress.ts` で別スレッドの返信ID重複を根拠混同・タスク重複除外なく扱う。重複除去と内部対応はroot/親か返信か/idの組とする（R5、D2、V2）。
- [X] T017 `tests/integration/teams-runtime.test.ts`、`src/teams/runtime.ts` で不正JSONの固定応答と、SDKの環境変数による匿名認証への切り替わり防止を検証・修正する（V1、C1）。
- [X] T018 `tests/unit/teams-graph.test.ts`、`src/teams/graph.ts` で公式応答のシステム種別と、実チャネルIDのエンコード表記が異なるnextLinkを扱う（R1、R5、V1）。
