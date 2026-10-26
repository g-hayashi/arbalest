# Implementation Plan: 自然文で呼べる Arbalest

**Branch**: `002-natural-mention-flow` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

## Summary

空メンションを既定の一括処理とし、依頼文だけを構造化解釈する。worker は会話を一度分析し、概要返信、対象 ToDo の登録、必要な canvas 節の更新を同じ結果から行う。振り返りは JST の期間境界をコードで確定する。

## Technical Context

**Language/Version**: TypeScript strict、Node.js 22

**Primary Dependencies**: 既存の Slack Bolt/WebClient、zod、date-fns、`LlmProvider`

**Storage**: 既存の Firestore `targets`、`todos`、`canvases`。概要は `targets` の状態として保持する。

**Testing**: Vitest とフェイク Slack/LLM/Store。実 AI の品質は合成 eval を利用者が実行する。

**Target Platform**: 既存の Cloud Run ingress/worker

**Project Type**: Slack ボット

**Performance Goals**: ingress の ack は3秒以内。自然文の解釈と分析は worker で処理する。

**Constraints**: Slack 履歴は最大90日。投稿先と副作用はコードで決める。会話中の命令を実行しない。

**Scale/Scope**: 既存の1チャネル・1スレッド単位の呼び出し。常時監視は含めない。

## Constitution Check

| 原則 | 設計上の対応 | 判定 |
|---|---|---|
| I. 提供元に依存しない | 意図と概要の抽出も `LlmProvider` を使用 | PASS |
| II. AI は抽出、判定と表示はコード | AI は依頼意図と根拠付き概要の候補のみ抽出。実行可否と表示はコード | PASS |
| III. 根拠のない項目を出さない | 概要の根拠を既存メッセージと照合 | PASS |
| IV. TDD | 各ストーリーの赤→緑とフェイクを使う | PASS |
| V. 安全と最小権限 | 依頼文と会話を分離し、宛先は payload と検証済み参加者に限定 | PASS |

設計後も上記を満たす。追加の権限とデータ保存先は不要。

## Project Structure

```text
specs/002-natural-mention-flow/
  spec.md plan.md research.md data-model.md quickstart.md contracts/ tasks.md
src/commands/parse.ts             # 既存コマンドと空メンション
src/ingress/dispatch.ts            # 重い処理を worker に積む
src/jobs/types.ts                  # 依頼・期間の型
src/worker/jobs/                  # 自然文の解釈、一括処理、既存ジョブの共通部品
src/analysis/                     # 根拠付き概要の抽出・検証
src/slack/render.ts               # 結果と読み込み範囲の表示
tests/unit/ tests/integration/    # フェイクで契約と副作用を検証
eval/                             # 合成会話の概要評価
```

**Structure Decision**: 既存の ingress/worker と分析層を拡張する。新しいサービスは作らない。
