# Tasks: Teams の ToDo と共有記録

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[contracts/work-management.md](contracts/work-management.md)。設計元は [既存設計 §9](../../docs/teams-work-management-design.md)。
**Rules**: 順番に実行し並列起動しない。各 W のテストと実装を同じ担当へ渡す。実装済みならテストで確認し、失敗時だけ修正する。新規実装はテスト→赤の出力確認→実装→対象テスト成功。共通型・エラー変更時は担当外も含め全参照テストを検索して追随する。部下はコミット・完了チェックを行わない。全体検証はメインが最後に1回行う。

## Phase 1: 正式化

- [X] T001 `specs/004-teams-work-management/spec.md`、`plan.md`、`research.md`、`data-model.md`、`contracts/work-management.md`、`quickstart.md`、`tasks.md`、`checklists/requirements.md` と `.specify/feature.json` に既存設計を正式化し、仕様品質を照合する（既存設計 §1〜9）。

## Phase 2: 共通基盤（W01〜W03、全ストーリーの前提）

- [X] T002 `tests/unit/teams-graph.test.ts` に W01 の赤を書く。同じ生 ID/同時刻/別 root/親と返信を区別し、UUID小文字化・不透明ID維持・根拠とリンクの対応を確認する（R1、D1、V1、C1）。
- [X] T003 `src/teams/types.ts`、`src/teams/graph.ts` に W01 の必須 `sourceRefs: Map<string, MessageRef>` を追加し、`sourceIds` を維持する。共有型を参照する `tests/unit/teams-graph.test.ts`、`tests/integration/teams-job.test.ts`、`tests/integration/teams-runtime.test.ts` 等を検索し追随する（T002、R1、D1、C1）。
- [X] T004 `tests/unit/teams-todo-identity.test.ts` に W02 の赤を書く。順序変更・双方1件一致・複数作業・本文/根拠変化・担当者/期限差・完了再抽出・候補消失を確認する（R2、D2、V3、C2）。
- [X] T005 `src/teams/todo-identity.ts` に W02 の照合を実装する。「否定語・数字・日付を消さず」「双方1件の完全一致だけ自動継承」を守り、曖昧/更新候補を隔離する（T004、R2、D2、V3、C2）。
- [X] T006 `tests/shared/teamsStoreContract.ts`、`tests/unit/teams-store-memory.test.ts`、`tests/unit/teams-store-firestore.test.ts` に W03 の赤を書く。原子的採番/anchor/登録/完了/同期予定、二重完了、日次予約、lease失効、保持境界、Slack検索/通知への混入0件を確認する。Firestoreは注入した代替DBだけを使用する（R3/R10、D2〜D6/D8、V1〜V6、C3/C10）。
- [X] T007 `src/teams/store/types.ts`、`src/teams/store/memory.ts`、`src/teams/store/firestore.ts` に W03 の専用repoを実装する。「status（open|done）」「revision（1以上の整数）」「登録・人による更新・完了から90日」「snapshot JSONは256KiB以下」を検査し、台帳変更と同期予定を同じtransactionにする。既存 `src/store/firestore/index.ts` の接続/prefix設計を参考にし、Slack Storeに混入させない（T006、R3/R10、D2〜D6/D8、V1〜V6、C3）。

## Phase 3: US1 ToDo 登録と完了（P1、W04/W05）

独立検証: 記録/通知無効で登録→再分析→更新確認→完了を実行し、同一性・認可・抑止を確認する。

- [X] T008 [US1] `tests/unit/teams-actions.test.ts`、`tests/integration/teams-runtime.test.ts` に W04 の赤を書く。SDK合成HTTP、別tenant/転送/改変/期限切れ/無権限/旧revision/投入失敗を拒否し、メンションなしの正当操作と二重完了1回、非公開拒否の契約を確認する（R4、D6、V4、C4/C10）。
- [X] T009 [US1] `src/teams/actions.ts`、`src/teams/runtime.ts` に W04 の token参照・カード受付・worker再検査を実装する。「有効期限は発行7日と台帳保持期限の早い方」、dataはtokenだけ、担当者/登録者だけの完了、managerだけの通知操作とする。SDK応答形式は導入済み型とT008で固定する（T008、R4、D6、V4、C4）。
- [X] T010 [US1] `tests/integration/teams-todos.test.ts`、`tests/integration/teams-job.test.ts` に W05 の赤を書く。自動登録全条件、担当未定の明示登録、候補の関連付け/別件登録/更新確認、done番号のscope、返信だけ/各抑止、条件付き記録、canvas/todo/findingsの境界、再分析重複防止を確認する（R2/R5、D1〜D4、V1〜V5、C2/C5）。
- [X] T011 [US1] `src/teams/todos.ts`、`src/teams/job.ts`、`src/teams/render.ts` に W05 を接続する。参加者番号から元AADへ戻し、明示候補の根拠を再検査する。「needsReview=false」「certainty=explicit」「closed=false」と取得参加者に存在する担当者を自動登録条件とし、既存台帳状態を優先する（T010、R5、D1〜D4、C5）。

## Phase 4: US2 Teams 内記録（P2、W06）

独立検証: 外部記録/通知なしで作成→更新→分割/縮小→完了反映→部分失敗復旧を確認する。

- [X] T012 [US2] `tests/unit/teams-records.test.ts`、`tests/integration/teams-runtime.test.ts` に W06 の赤を書く。必須activityId、bot所有/scope、creating保存、作成結果不明の停止と再関連付け/明示再作成、削除済み投稿の明示再取得、slot縮小、旧revision/失効lease、表示だけ再試行を確認する（R6/R10、D4/D5、V6/V7、C6）。
- [X] T013 [US2] `src/teams/records.ts`、`src/teams/runtime.ts` に W06 のcreate/update分離writerと最新revision修復を実装する。「文字列slotは8,000文字以下」「snapshot JSONは256KiB以下」、作成ID欠損を成功にせずdelivery_unknownを自動再作成しない。既存TeamsReplyの通常返信互換性を維持する（T012、R6/R10、D4/D5、V6/V7、C6）。

## Phase 5: US3 元スレッド通知（P2、W07）

独立検証: 時刻を固定し、金曜/月曜/期限未定/通知停止/完了競合/同日再試行/分割再開を確認する。

- [X] T014 [US3] `tests/integration/teams-reminders.test.ts` に W07 の赤を書く。次営業日の全日と期限超過、月曜だけ期限未定、同日予約の固定snapshot、追加分翌営業日、送信直前除外、slot再開、401/403/404/429/5xx、DM迂回なしを確認する（R7、D3/D5/D8、V1/V2/V5/V6、C7）。
- [X] T015 [US3] `src/teams/reminders.ts` に W07 を実装し、`src/util/time.ts` の isBusinessDay/nextBusinessDay/jstDateIso を共有する。「月〜金09:00 JST」「元スレッド1日1組」、managerによる停止/再開、mentionなし、固定日次operationIdと送信前検査を適用する（T014、R7、D3/D5/D8、C7）。

## Phase 6: US4 任意の外部記録（P3、W08）

独立検証: 固定Listの代替実装で一意性・応答紛失・412・人のメモ/生成列競合・上限を確認する。実有効化はW10まで保留。

- [X] T016 [US4] `tests/unit/teams-sharepoint.test.ts` に W08 の赤を書く。Selectedゲート、固定scope/List、POST/PATCH応答紛失、一意競合後再検索、If-Match/412、予定値と適用済みhashの復旧、人のメモ保持、生成列競合、8,000文字境界を確認する（R8/R9、D4/D7、V8、C8）。
- [X] T017 [US4] `src/teams/sharepoint.ts` に W08 の専用List同期を実装する。「生成列はプレーンテキスト、各8,000文字以下」「UserNotes は人だけが編集し POST/PATCH 生成値に含めない」、送信予定snapshot/hash/revisionを外部呼出し前に保存し、競合/超過/未検証時は停止する（T016、R8/R9、D4/D7、V8、C8）。

## Phase 7: 接続と全体検証（W09/W10）

- [X] T018 `tests/integration/teams-runtime.test.ts`、`tests/integration/teams-worker-routing.test.ts`、`tests/unit/config.test.ts`、`tests/unit/teams-main.test.ts` に W09 の赤を書く。既定無効と003互換、別worker混入拒否、OIDC、cron通知/修復、部分失敗、保存/読込snapshot上限、機能無効/アプリ削除、旧summary進捗境界を確認する（R10、D4/D5/D8、V1/V5/V6、C9/C10）。
- [X] T019 `src/config.ts`、`src/main.ts`、`src/teams/runtime.ts`、`src/worker/server.ts` に W09 の設定/worker/通知/定期修復を接続し、`docs/teams-setup.md` と `specs/004-teams-work-management/quickstart.md` に導入・停止・復旧を反映する。フラグ既定無効、外部記録は導入ゲート後だけ有効化し、本番/インフラを変更しない（T018、R10、D4/D5/D8、C9）。
- [X] T020 メイン: `package.json` の lint/typecheck/全フェイクテスト/build と `git diff --check` を最後に1回行い、結果とfeature/完了ID/次ID/未確認/ブランチ/取得可能な使用量とコミットを 引き継ぎメモ（`.tmp/`、コミットしない）へ記録する。`.gitignore` の既存変更を保全する（全US、quickstart.md）。
- [ ] T021 利用者: W10として003の `specs/003-teams-backend/tasks.md` T014を先に確認し、`specs/004-teams-work-management/quickstart.md` と `docs/teams-setup.md` に従いテスト環境でカード/能動返信/desktop・web・mobile/Selected GET・検索・POST・PATCH・412/他List拒否/共有範囲を確認する。実接続結果なしに外部同期を有効化しない。実資格情報・実データの確認は部下とメインが代行しない（R9、C4/C7/C8）。

## Dependencies & Execution Order

`T001 → (T002,T003=W01) → (T004,T005=W02) → (T006,T007=W03) → (T008,T009=W04) → (T010,T011=W05) → (T012,T013=W06) → (T014,T015=W07) → (T016,T017=W08) → (T018,T019=W09) → T020 → T021(W10)`。

共通基盤6件、US1は4件、US2/US3/US4は各2件、正式化1件、横断/最終/利用者4件、計21件。並列機会は採用せず、全USで前のペア終了後に次のペアを開始する。US2〜4は基盤/US1へ依存するが、各独立検証は他の副作用を無効化して行える。

## Implementation Strategy

US1までを最小の登録/完了機能とし、US2→US3でTeams内記録と通知を追加する。W08を保留してもW01〜W07/W09で内部機能を提供できる。外部権限確認を内部実装の前提にしない。チェックとコミットはメインが行い、フェーズ/US区切りでタスクIDを含める。区切りで利用者に `/status` の使用量確認を案内し、取得できた値だけ記録する。
