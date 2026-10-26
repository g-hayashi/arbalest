# Data Model: Teams の ToDo と共有記録

## D1 scope と永続根拠

`TeamsScope = { tenantId:string, teamId:string, channelId:string, rootMessageId:string }`。全値必須・空文字不可。tenantId/teamId と Aad ID の UUID は小文字へ正規化し、channelId/rootMessageId/messageId は不透明 ID として保持する。

`MessageRef = TeamsScope & { kind:"root"|"reply", messageId:string }`。root の messageId は rootMessageId と一致する。`TeamsConversation.sourceRefs: Map<string, MessageRef>` は分析用時刻→元メッセージの対応。既存 sourceIds/names/links/messages を残す。

`TeamsEvidence = { ref:MessageRef, quote:string, link:string, sourceCreatedAt:string }`。引用・リンク・作成日時を検証し、本文全体を台帳へ複製しない。sourceCreatedAt は元メッセージの実時刻であり分析用に衝突回避した値を永続キーにしない。

## D2 ToDo と anchor

`teams_todos/{todoId}`: todoId（生成した永続 ID）、targetId（既存 teamsTargetId と同じ scope ハッシュ）、scope、displayNo（1以上の安全な整数）、text（空でない）、evidence（1件以上）、assigneeAadId（UUID|null）、createdByAadId（UUID）、dueIso（妥当な日付または日時|null）、dueText（string|null）、status（open|done）、revision（1以上の整数）、createdAt、lastHumanUpdatedAt、expireAt、doneBy（UUID|null）、doneAt（ISO|null）。完了時だけ doneBy/doneAt を設定する。

`teams_todo_anchors/{anchorHash}`: scope、元メッセージと正規化引用の組、確認済み作業本文 hash、関連 todoId と照合履歴。1つの引用に複数作業があり得るため、引用だけで一意 ToDo としない。双方1件の完全一致だけ自動継承し、本文・根拠差は曖昧候補とする。

`teams_requests/{requestHash}`: scope を含む要求 ID の hash、入力 fingerprint、確定 todoId、expireAt。同じ要求の再実行を冪等にし、要求 ID を別候補へ使い回す操作を拒否する。期限は対応 ToDo に従い、再実行で延長しない。

照合結果は `existing`（状態継承）、`update_proposal`（担当者/期限の確認待ち）、`ambiguous`（既存関連付け/別件登録の選択待ち）、`new`。一時的な抽出 ID は永続 ID ではない。確認済み候補 snapshot は scope・根拠・担当者/期限・対象 revision・期限を持ち、カード token からサーバ側で引く。

## D3 管理対象スレッド

`teams_thread_settings/{targetId}`: scope、nextDisplayNo（初期1）、managerAadId（最初の管理操作の依頼者、後続操作で置換しない）、notificationsEnabled（管理対象の初期true）、disabled、認証済み serviceUrl/conversationId、createdAt、lastHumanUpdatedAt、expireAt。採番は transaction で増加させ、番号を再利用しない。設定保存だけを理由に別スレッドの通知を有効にしない。

## D4 共有記録

`teams_records/{targetId}`: scope、desiredRevision、snapshot、snapshotHash、Teams slot 列、SharePoint 状態、分析/台帳/Teams/SharePoint/返信の各進捗、expireAt。

- Teams slot: slot（安定した0以上の整数）、activityId（未確定時null）、bot 所有とscope、appliedRevision、state（pending|creating|applied|failed|delivery_unknown|deleted|retired）。縮小した余剰 slot は統合済み投稿へ更新する。
- SharePoint: 固定 siteId/listId、ArbalestKey、itemId/etag（未確定null）、appliedRevision/appliedHash、pendingRevision/pendingHash/pendingGeneratedFields、state（pending|applied|failed|conflict|too_large）。送信予定値は外部呼出し前に保存する。
- snapshot: revision ごとの表示確定値。ToDo 変更と新たな表示/同期予定の予約は同じ transaction。保存・再読込で UTF-8 JSON 256KiB以下。既存 `summary:N` 用 RequestProgress とは別契約。

## D5 副作用とリース

`teams_effects/{operationId}`: scope、targetId、kind（record|reminder|sharepoint|reply）、revision、固定 snapshot と slot、state（pending|running|applied|failed|delivery_unknown|cancelled）、attempts、leaseOwner、leaseUntil、fencingToken、expireAt。

日次 reminder operationId は JST日付・targetId・kind だけから決める。snapshot/hash/revision を ID に含めず、予約済み snapshot は同日の追加・変更で差し替えない。slot ごとに送信済み activityId と状態を保存する。完了・停止・期限切れは送信直前に除外する。

所有 token を比較してリース延長・保存する。失効した旧 worker は保存不可。送信前に最新 desiredRevision を確認し、古い表示を送らない。送信中の順序逆転は最新 revision の定期修復で直す。

## D6 操作参照

`teams_action_refs/{tokenHash}`: 暗号学的ランダム token のハッシュ、scope、元投稿 activityId、対象 todoId または候補 snapshot、許可操作（register|link|confirm_update|done|notifications_off|notifications_on）、expectedRevision、発行者/許可操作者の検査情報、createdAt、expireAt。

有効期限は発行7日と台帳保持期限の早い方。raw token を DB・ログへ保存しない。登録は認証された同 scope の参加者、既存 ToDo の関連付け/更新確認/完了は担当者または登録者、通知操作は managerAadId を許可する。カード data 自体に権限を委ねない。

## D7 SharePoint の列

一意・索引付き ArbalestKey（scope hash）、Title、ThreadUrl、Overview、Decisions、OpenIssues、Todos、Questions、Evidence、GeneratedAt、Revision、UserNotes。生成列はプレーンテキスト、各8,000文字以下。UserNotes は人だけが編集し POST/PATCH 生成値に含めない。生成列 snapshot/hash は同じ canonical な列順・値の表現で比較する。

実際の値が pending hash/revision と一致すれば応答紛失した自分の更新として applied、appliedHash と一致すれば未適用として再試行、それ以外は conflict。412 は再取得してこの判定を使い、UserNotes だけの変更を妨げない。初回作成は ArbalestKey 検索を先に行い、一意競合と応答紛失時も再検索する。

## D8 保持と状態遷移

登録・人による更新・完了から90日。自動分析/通知/表示/リース更新で延長しない。`now >= expireAt` で TTL 削除前でも拒否する。anchor・操作参照・副作用が親台帳の保持を越えて内容を保持しない。元メッセージ作成から90日超の根拠は自動新規登録しない。Teams 投稿と外部行の削除はサービスの保持方針と管理者が扱う。

- ToDo: 未登録→open→done。done→done は changed=false。再分析だけでは open/done の変更・削除をしない。
- 作成: pending→creating→applied。成否不明/creating の失効→delivery_unknown。自動新規投稿は停止。管理者による確認・再関連付けまたは明示再作成で回復。
- 更新: pending→running→applied。失敗は最新 snapshot で再試行、旧版は中止。外部生成列競合は conflict→管理者確認後の明示再同期。
- 無効化・アプリ削除: 新規登録/送信を止める。自動削除しない。401/403 は通知停止・要再接続、404 は対象無効化。

## Invariants and Validation

- **V1**: tenant/team/channel/root の scope をキー・索引・認可すべてで一致検査する。Slack の ToDo 検索・送信へ混入0件。
- **V2**: 採番・登録・anchor 確保・完了と同期予定・日次予約は transaction。外部 API は transaction 内で呼ばない。
- **V3**: 双方一意の根拠/引用/本文だけを継承。否定語・数字・日付を消さず、曖昧な候補を自動登録しない。
- **V4**: 担当者/登録者だけが完了・既存項目更新確認。同時完了の changed=true は1回。カード有効期限・元投稿・revision を受付/worker で再検査。
- **V5**: 自動処理で保持期限を延長しない。期限切れ操作・通知・古い根拠の自動再登録を拒否する。
- **V6**: 表示 snapshot と slot の上限・形・scope/revision を保存時と復旧時に検証する。リース失効後の保存不可。
- **V7**: 管理投稿 create の成功は空でない activityId が必須。結果不明は自動 create を禁止する。更新対象は保存済み bot 所有投稿だけ。
- **V8**: UserNotes を送らず、生成列の人の編集を上書きせず、超過を切捨てない。Selected と共有範囲未確認の外部送信を禁止する。
