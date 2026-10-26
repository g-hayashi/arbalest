# Tasks: 自然文で呼べる Arbalest

**Input**: `specs/002-natural-mention-flow/` の spec.md、plan.md、research.md、data-model.md、contracts/、quickstart.md

**Tests**: 憲章 IV に従い、各組をテスト追加 → 赤の確認 → 実装 → 担当テストの順で進める。Slack・LLM・Store はフェイクとし、実 AI の評価と本番の手動確認は最後に利用者が行う。

**Format**: `- [ ] Tnnn [USn] 説明（対象ファイル、参照節）`。完了チェックとコミットはメインが行う。部下は1体ずつ、同じ組のテストと実装をまとめて担当する。

## Phase 1: Setup

既存の TypeScript、Vitest、Slack/LLM/Store のフェイクを再利用する。追加依存、サービス、権限、インフラ設定の作業はない（plan.md Technical Context）。

## Phase 2: Foundational

**Goal**: 空メンションと自然文の依頼を worker に渡し、US2 より前に意図・抑止・期間を確定できるようにする。

- [X] T001 `tests/unit/parse.test.ts`、`tests/unit/dispatch.test.ts`、`tests/integration/ingress.test.ts` に、空メンション・自然文を worker に積むこと、ingress が LLM を呼ばないこと、旧コマンドと 👀 の互換、会話本文を依頼として扱わないことの失敗テストを追加する。`まとめ`・`summary`・`要約` は既存 summarize パスから一括処理へ進む契約として確認する（FR-001/010/011、R1、D1、contracts/mention-and-result.md の入力）。
- [X] T002 `src/commands/parse.ts`、`src/jobs/types.ts`、`src/ingress/dispatch.ts` に依頼用の種別・payload・パスを追加し、空メンションと自然文を worker に渡す。旧コマンドのパスを維持し、`まとめ`・`summary`・`要約` の summarize payload も一括処理対象とする。依頼本文は Cloud Tasks の一時的なジョブ本文だけに含め、Firestore やログへ保存しない。共有型を参照するテストを検索して更新する（T001、FR-001/010/011、R1、D1、contracts/mention-and-result.md の入力）。
- [X] T003 `tests/unit/request-intent.test.ts`、`tests/unit/time.test.ts` に、依頼文だけの意図抽出、summary/findings/clarify、抑止、自然文の言い換え、曖昧な意図・不正期間の失敗テストを追加する。JST の月曜始まりの前週/今週、月初〜現在、直近N日/このN週間、省略30日、最大90日の境界を固定時刻で確かめる（FR-006/009/011、R1/R4、D1、contracts/mention-and-result.md）。
- [X] T004 `src/commands/intent.ts`、`src/analysis/prompts/requestIntent.ts`、`src/util/time.ts` に `LlmProvider` を使う構造化意図抽出とコードでの期間検証・JST 境界計算を実装する。summary/findings/clarify、抑止指定、実際の開始/終了、90日の制限を返す。会話本文を分類入力へ含めず、曖昧または不正な依頼は確認対象とする（T003、FR-006/009/011、R1/R4、D1、contracts/mention-and-result.md）。

**Checkpoint**: ingress の依頼受付、旧コマンド、worker 用の意図・抑止・期間の単体テストが通る。

## Phase 3: US1 — メンションだけで会話を把握する (P1)

**Goal**: 空メンションから根拠付き概要と読み込み範囲を返す。

**Independent Test**: 調整あり・雑談のみ・取得0件・チャネル直下の4種類で、ヘルプではなく対象範囲が分かる結果を返信する。

- [X] T005 [US1] `tests/unit/schemas.test.ts`、`tests/unit/merge.test.ts`、`tests/unit/verify.test.ts`、`tests/integration/summarize.test.ts` に概要の抽出・差分更新・根拠検証・保存の失敗テストを追加する。制約は「最大3項目」「根拠の実在と引用の一致を検証する」「検証できないものは要確認」「対象が0件なら概要も0件」とする。旧状態に概要がない場合、編集・削除・プロンプト版変更時も確認する（FR-002/003、R3、D2）。
- [X] T006 [US1] `src/analysis/schemas.ts`、`src/analysis/prompts/summarize.ts`、`src/analysis/merge.ts`、`src/analysis/verify.ts`、`src/analysis/pipeline.ts`、`src/store/types.ts`、`src/store/memory/targets.ts`、`src/store/firestore/targets.ts` を拡張し、T005 の制約を満たす根拠付き概要を既存の分析1回で抽出・検証・保存する。概要のない保存済み状態は互換を保って読み、プロンプト版を更新する。型と契約を参照する担当外テストも検索して更新する（T005、FR-002/003/007、R3、D2、plan.md Storage）。
- [X] T007 [US1] `tests/unit/render-summary.test.ts`、`tests/integration/summarize.test.ts`、`tests/integration/request.test.ts`、`tests/integration/worker.test.ts` に、概要・調整事項なし・取得0件・件数・最初/最後の投稿時刻・スレッド/直近7日の対象表示・安全フィルタの失敗テストを追加する。空メンションと `まとめ` は共通経路を通り、自然文の抑止指定を引き継ぎ、曖昧な依頼は分析や副作用を行わず確認を返信する（FR-001/002/003/006、R1/R3、V3、US1/AC1〜3）。
- [X] T008 [US1] `src/worker/jobs/request.ts`、`src/worker/jobs/summarize.ts`、`src/slack/render.ts`、`src/main.ts` を更新し、空メンションと旧 summarize パスの `summarizeJob` を同じ一括処理の入口へ接続する。T004 の意図・抑止結果を引き継ぎ、共通分析1回から概要と対象範囲を先に返信する。曖昧な依頼は確認を返し、「件数0なら時刻は表示せず『投稿0件』」とする（T007、FR-001/002/003/006/007/010、R1/R3、D1、V3、contracts/mention-and-result.md の結果）。

**Checkpoint**: US1 を単独で検証できる。MVP はここまで。

## Phase 4: US2 — 必要な記録を一度の呼び出しで更新する (P1)

**Goal**: スレッドの一括処理で対象 ToDo と canvas を更新し、実行結果を返信する。

**Independent Test**: 空メンション1回で返信・対象 ToDo・canvas 節が揃い、担当不明・要確認・抑止・チャネル直下では副作用を実行しない。

- [X] T009 [US2] `tests/integration/request.test.ts`、`tests/integration/summarize.test.ts`、`tests/integration/todos.test.ts`、`tests/integration/canvas.test.ts` に、空メンションと旧 summarize パスの両方で自動 ToDo 登録・canvas 更新へ進む失敗テストを追加する。ToDo は「closed=false」「担当者のユーザー ID が参加者に存在」「needsReview=false」「根拠が1件以上で検証済み」「利用者による抑止がない」「スレッド内」をすべて満たす場合だけ登録する。T004 で解釈した抑止、既存管理節が空になった場合、チャネル直下・担当不明・要確認も確認する（FR-004〜007/010/011、R2、V1/V2、US2/AC1〜3）。
- [X] T010 [US2] `src/worker/jobs/request.ts`、`src/worker/jobs/summarize.ts`、`src/worker/jobs/todos.ts`、`src/worker/jobs/canvas.ts`、`src/slack/render.ts` の共通部品を切り出し、T008 の一括処理から同じ分析結果で ToDo 登録と canvas 更新を行う。V1/V2、完了状態・stable ID・canvas marker を維持し、T004 の抑止とチャネル直下の返信のみを適用する。空メンションと `summarizeJob` の両方で登録件数・要確認・canvas の結果を返信する（T009、FR-004〜007/010/011、R2、D3、V1/V2、contracts/mention-and-result.md）。
- [X] T011 [US2] `tests/integration/request.test.ts`、`tests/unit/store-memory.test.ts`、`tests/shared/storeContract.ts` に、ToDo 登録後・canvas 更新後・最終返信後の失敗、同じ taskName の再試行、別メンションからの再実行を故障注入する失敗テストを追加する。`processed_events/{taskName}` の段階状態・返信 ts・7日 TTL、ToDo と canvas 節の重複なし、返信 ts 保存前の既存投稿確認、別 taskName との状態分離を検証する（FR-008、SC-004、R5、D3、US2/AC4）。
- [X] T012 [US2] `src/worker/jobs/request.ts`、`src/worker/server.ts`、`src/store/types.ts`、`src/store/memory/events.ts`、`src/store/firestore/events.ts` を拡張し、既存 `processed_events/{taskName}` に `targetId`、完了した段階、返信 ts、`updatedAt` を既存7日 TTL とともに保存・復元する。再試行時は段階と実体を照合し、ToDo と canvas 節を重複させず、投稿済み返信を更新する。返信 ts 保存前の失敗では元スレッドを確認して重複を抑える。別 taskName は状態を共有せず、共有契約を参照するテストも更新する（T011、FR-008、R5、D3）。

**Checkpoint**: US1 と US2 を一度の呼び出しで確認できる。

## Phase 5: US3 — 自然文で振り返る (P2)

**Goal**: 自然文の依頼意図と JST の期間を確定し、期待する範囲の Findings を返す。

**Independent Test**: `先週`、`今週`、`今月`、`直近14日`、`この2週間`、期間省略、90日超過、曖昧な依頼を固定時刻で検証する。

- [X] T013 [US3] `tests/unit/slack-conversation.test.ts`、`tests/unit/render-findings.test.ts`、`tests/integration/findings.test.ts`、`tests/integration/request.test.ts` に、T004 の findings 意図と期間から既存 Findings 処理へ接続する失敗テストを追加する。開始/終了の境界、範囲外の返信除外、実際の対象期間、90日制限の表示、旧 findings コマンドとの互換を確認する（FR-009/010、R4、D1、V3、US3/AC1〜4）。
- [X] T014 [US3] `src/worker/jobs/request.ts`、`src/slack/conversation.ts`、`src/worker/jobs/findings.ts`、`src/jobs/types.ts`、`src/slack/render.ts` を拡張し、T004 の findings 意図と確定した開始/終了から対象範囲だけを取得・分析して表示する。古い日数指定の payload も受け、旧コマンドの結果とキャッシュを維持する。意図抽出・期間計算は重ねて実装せず、共有型・取得契約を参照するテストを検索して更新する（T013、FR-009/010、R1/R4、D1、V3）。

**Checkpoint**: US1〜US3 の自然文フローと旧コマンドの回帰テストが通る。

## Phase 6: Polish と最終検証

- [X] T015 `tests/unit/eval-run.test.ts`、`tests/unit/eval-match.test.ts` に、概要の根拠検証・期待要点の再現率と依頼意図・期間の合成評価の失敗テストを追加する。根拠の実在・引用一致率100%、期待要点の再現率80%以上、意図と期間は20件中19件以上、会話本文中の命令による誤実行0件の閾値を下回ると不合格になることを検証する（FR-003/009/011、SC-006/007、R6、憲章 IV）。
- [X] T016 `eval/cases.ts`、`eval/run.ts`、`eval/match.ts`、`eval/report.ts`、`eval/cases/` に T015 の合成ケース・指標・閾値判定を実装する。意図と期間の20件のケースと、雑談、調整なし、要確認、抑止、依頼文と会話中の命令の区別、概要の期待要点を含める。実データやケース固有語をプロンプトへ入れない（T015、FR-003/009/011、SC-002/003/005/006/007、R1/R3/R4/R6、憲章 IV/V）。
- [X] T017 `src/ingress/dispatch.ts` の案内と `README.md`、`specs/002-natural-mention-flow/contracts/mention-and-result.md`、`specs/002-natural-mention-flow/quickstart.md` を実装済みの空メンション・自然文・抑止・実行結果・旧コマンドの使い方に合わせる（FR-010、R1〜R5）。
- [X] T018 〔メイン〕変更ファイルの Biome と `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` を最後に1回実行し、結果と残る不備を `.tmp/handoff.md` に記録する。既存の未変更スキル文書の lint 不備は勝手に整形しない（plan.md Testing、憲章 IV、AGENTS.md）。
- [X] T019 〔利用者〕`npm run eval` を1回実行し、T016 の合成ケースが SC-006/007 の閾値と既存指標を満たすことを確認する。結果をメインへ共有し、実データや機密の値をリポジトリへ書かない（SC-002/003/005/006/007、R1/R3/R4/R6、憲章 IV/V）。
  - 結果（2026-10-26）: 2回目の評価（summarize@6）で todoPrecision 0.78 のほかは全指標合格。利用者の判断で「予定を確認します」を ToDo の正解に加え（再計算で 0.89）、願望を外す自己確認を summarize@7 に追加。summarize@7 の実AI再評価は利用者の判断で省略して完了とした。
- [X] T020 〔利用者〕〔メイン〕`specs/002-natural-mention-flow/quickstart.md` の6手順をテスト用チャネルで最後に1回確認し、空メンション、自動処理、抑止、チャネル直下、期間表示、再実行時の重複なしを確かめる。本番デプロイは利用者が行う（SC-001〜005、R2/R5、AGENTS.md）。
  - 結果（2026-10-26）: 6手順の基本の流れ、先週・直近14日の期間、再実行での重複なしを確認。確認中に見つけた空メンションによる概要の上書きを修正し（0cdb895）、利用者の要望でリンクのプレビュー抑止・再実行の簡素な返信（951d3b0）、canvas の URL ボタン化（f3c54fe）を追加して、デプロイ後に確認した。canvas の完了表示、旧コマンド（まとめ・todo・canvas・findings N日）、見るだけ、曖昧な依頼、省略時30日・90日制限は、利用者の判断で実機確認を見送った（フェイクテストで確認済み）。

## Dependencies & Execution Order

- Phase 1 → Foundational（T001/T002 → T003/T004）→ US1（T005/T006 → T007/T008）→ US2（T009/T010 → T011/T012）→ US3（T013/T014）→ Phase 6。
- 各スラッシュの組は同じ担当者がテストと実装をまとめて行う。実装済みなら担当テストで確かめ、失敗した場合だけ修正する。
- US2 は Foundational の意図・抑止解釈と US1 の共通分析を使う。US3 は Foundational の期間計算と US1 の依頼ジョブを使い、US2 の副作用条件を維持する。
- 機械的には T005 の分析テストと T007 の表示テストは別ファイルで作成できるが、実装は依存があるため順に行う。意図・抑止・期間の解釈は T003/T004 に統合し、US2/US3 で重複実装しない。並列のサブエージェントは起動しない。

## Implementation Strategy

1. US1 を MVP として完成し、コマンドなしの概要返信を確かめる。
2. 同じ分析結果から US2 の副作用を追加し、抑止と故障注入を先に検証する。
3. US3 で確定済みの意図・期間を Findings へ接続し、合成評価を整える。
4. 最後に T018〜T020 を順に行う。ストーリーの区切りでメインがコミットし、利用者へ `/status` の使用量確認を促す。

## Phase 7: Convergence

- [X] T021 [US3] HIGH / F1: `tests/unit/slack-conversation.test.ts` と `tests/integration/findings.test.ts` に、期間開始前の親に期間内の返信がある場合も Findings の対象へ含め、親と範囲外の返信は分析から除外する回帰テストを追加し、赤を確認する。その後 `src/slack/conversation.ts` の親スレッドの探索・返信取得を修正し、開始以上・終了未満の境界とページングを維持して担当テストを通す（FR-009、T013/T014、research.md R4、data-model.md D1/V3、contracts/mention-and-result.md の期間取得契約; partial）。
- [X] T022 [US1] HIGH / F2: `tests/integration/summarize.test.ts` と `tests/unit/merge.test.ts` に、チャネルの直近7日窓が移動した再実行で窓外の根拠しかない旧概要が `needsReview: false` のまま保存・表示されないこと、現在の対象が0件なら概要も0件になることの回帰テストを追加し、赤を確認する。その後 `src/analysis/pipeline.ts` と `src/analysis/merge.ts` の差分処理・概要の引き継ぎを修正し、現在の取得範囲に基づく概要と根拠検証、最大3項目の制約を維持して担当テストを通す（FR-002/003、US1/AC3、research.md R3、data-model.md D2/V3、contracts/mention-and-result.md の summary の結果契約; partial）。
