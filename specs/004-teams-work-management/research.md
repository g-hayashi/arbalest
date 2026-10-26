# Research: Teams の ToDo と共有記録

2026-10-26。[既存設計](../../docs/teams-work-management-design.md)の判断を正式化する。以下の外部資料は設計書にある根拠の引継ぎで、今回実環境の権限・通信成功を検証した記録ではない。

## R1 元メッセージの永続識別（W01）

**Decision**: `MessageRef` に tenant/team/channel/root/kind/id を保存し、`TeamsConversation.sourceRefs` に分析用時刻からの対応を追加する。UUID のみ小文字化し、不透明 ID を変換しない。
**Rationale**: `src/teams/graph.ts` は root/isReply/id で重複を除くが、公開する sourceIds は時刻→生 ID だけ。`job.ts` は `prior:null` で再分析し、時刻と抽出 ID は永続キーにならない。
**Alternatives**: 生 ID だけ・分析時刻・`t1`・参加者番号によるキーはいずれも衝突や再採番があるため不採用。既存 `sourceIds` は通常分析・Findings の互換性のため維持する。

## R2 ToDo 同一性（W02）

**Decision**: scope 付き根拠 anchor、引用、確認済み本文で双方一意な対応だけを継承する。否定語・数字・日付は保持する。曖昧な重なりは明示選択、担当者・期限差は確認候補とする。
**Rationale**: 再抽出の順序変更と意味の近さだけで完了を別作業へ継承しない。
**Alternatives**: `carryOverIds` の文面照合や AI の類似度だけによる統合は不採用。消えた候補の自動削除・完了も不採用。

## R3 専用台帳と保持（W03）

**Decision**: 専用 `TeamsWorkStore` をメモリ/Firestore で実装し、採番・anchor・完了・同期予定・日次予約を transaction にする。保持90日は人の変更だけで延長する。
**Rationale**: 既存 `src/store/types.ts` の TodoDoc は Slack 固有。`src/worker/jobs/reminders.ts` は Slack DM 送信を行い、Teams の混入を許せない。
**Alternatives**: Slack コレクションへ platform を追加する方式は既存検索・通知への漏れを招くため不採用。TTL 削除待ちでの認可も不採用。既存 FirestoreStore の接続/prefix/時刻注入は再利用できるが Slack Store の契約へ Teams ToDo を混入させない。

## R4 カード認証・操作（W04）

**Decision**: Action.Execute を採用し、操作 data は参照 token だけとする。SDK 認証済み activity、保存済み scope/card/revision、現在の操作者権限で受付と worker を検査する。
**Rationale**: 現在 `src/teams/runtime.ts` は message handler だけ。SDK 2.1.1 の `routes/invoke/card-action.d.ts` は `card.action.${string}` と invoke 応答本体を許す。`adaptive-card-action-response.d.ts` には `statusCode:200`、`type:application/vnd.microsoft.activity.message`、`value:string` がある。汎用 `card.action` handler と実際の HTTP 応答は W04 の合成テストで固定する。
**Alternatives**: data に ToDo/宛先/操作者を信用して入れる方式、メンション必須化、人物・内容を公開する拒否投稿は不採用。
**Source**: [Teams カード操作](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-actions)、上記ローカル SDK 型。

## R5 依頼の副作用（W05）

**Decision**: 002 の抑止と条件付き自動記録を継承し、Teams 専用で登録・候補・完了を追加する。明示 todo は外部新規記録を作らず、canvas は ToDo を新規登録しない。findings は返信だけ。
**Rationale**: 利用者が指定した副作用の範囲を維持し、再分析から確定台帳を独立させる。
**Alternatives**: すべての分析で自動登録・外部作成を行う方式は不採用。

## R6 Teams 管理投稿（W06）

**Decision**: 通常 TeamsReply と別に activity ID 必須の writer を追加し、create/update を分ける。slot 作成前に creating を保存し、結果不明は delivery_unknown で止める。
**Rationale**: 現在の TeamsReply は `Promise<string|void>` であり、job は ID 欠損を sent と扱う。これは通常返信との互換性のため残し、管理投稿の更新には流用しない。
**Alternatives**: 作成結果不明の自動再投稿は不採用。管理者の再関連付けまたは明示再作成を用意し、既存 ID の更新再試行と分ける。
**Source**: [Teams のメッセージ更新](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability)。

## R7 営業日通知（W07）

**Decision**: 元スレッド09:00 JST、月〜金、次営業日まで、期限なしは月曜だけ。`src/util/time.ts` の `isBusinessDay(date)` / `nextBusinessDay(date)` / `jstDateIso(date)` を再利用する。
**Rationale**: nextBusinessDay は当日より後の最初の営業日0時を返す。期限は JST 日付で次営業日以下と比較し、その日の全体を含める。Slack の送信/宛先規則は流用しない。
**Alternatives**: DM、個人 mention、祝日カレンダーは初版対象外。snapshot ハッシュを日次 operationId に含める方式は同日追加通知を生むため不採用。
**Source**: [能動メッセージ](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)。

## R8 SharePoint 同期（W08）

**Decision**: 管理者作成済み専用 List、scope 由来の一意/索引付き ArbalestKey、生成列限定 PATCH、If-Match、送信予定/適用済み hash と revision で復旧する。UserNotes は送らない。
**Rationale**: POST/PATCH の応答紛失を人の編集と区別し、412 のメモだけの変更なら再適用できる。生成列8,000文字超過は too_large で止める。
**Alternatives**: 任意 URL、サイト探索、List/タブ自動作成、全列置換、自動切捨て、別文書出力は不採用。
**Source**: [List 作成](https://learn.microsoft.com/en-us/graph/api/listitem-create?view=graph-rest-1.0)、[List 更新](https://learn.microsoft.com/en-us/graph/api/listitem-update?view=graph-rest-1.0)。

## R9 外部権限と導入ゲート（W08/W10）

**Decision**: `Lists.SelectedOperations.Selected` と専用 List の write を第一候補とし、利用者の GET/検索/POST/PATCH/412 と他 List 拒否確認まで無効にする。閲覧範囲は標準チャネルと一致させる。
**Rationale**: Selected 概要と個別 API の `Sites.ReadWrite.All` 権限表に記載差がある。これは実環境の有効化条件として残し、機能削除や全サイト権限への自動拡大で処理しない。
**Alternatives**: 同意だけで利用可能とみなす方式、管理者の付与権限を実行ボットへ渡す方式は不採用。
**Source**: [Selected 権限](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)。003 T014 を先に利用者が確認する。

## R10 副作用の復旧と起動（W09）

**Decision**: Teams 専用進捗・固定 snapshot・lease/fencing・desiredRevision を用い、Teams/SharePoint/返信を別々に再試行する。Teams モードだけで管理ジョブ・通知・修復を登録する。
**Rationale**: 既存 `summary:N` 進捗へ無条件で管理操作を追加しない。256KiB 上限を保存/再読込とも検査し、古い worker の保存を拒否する。Teams への遅延更新は定期修復で最新化する。
**Alternatives**: 外部 API を transaction 内で呼ぶ方式、再試行ごとの LLM 再実行、外部送信の厳密な一度だけ保証は不採用。新フラグは既定無効、SharePoint は導入ゲート付き。
