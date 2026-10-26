# Quickstart: Teams の ToDo と共有記録

状態: ローカル実装・フェイク接続テストあり。実Teams/Entra/SharePoint/IAM/Firestore/AIの導入確認は未完了。基準は [spec.md](spec.md)、詳細は [契約 C1〜C10](contracts/work-management.md) と [導入・停止・復旧手順](../../docs/teams-setup.md)。

## フェイクでの確認

Node >=22.12 と既存依存を使う。必要なら `npm_config_cache=$TMPDIR/npm-cache npm ci`。各担当は tasks.md のペアに示したファイルだけ `npm_config_cache=$TMPDIR/npm-cache npx vitest run <path>` で実行し、赤→実装→成功を記録する。

1. US1: 合成会話から登録→再分析→更新確認→完了。同じ番号/状態を維持し、別scope/無権限/旧カード/根拠不一致を拒否する。
2. US2: 自動記録条件と各抑止、明示canvas、分割/縮小、ID欠損/作成結果不明、表示だけの再試行を確認する。
3. US3: 金曜/月曜09:00 JST、期限未定、日次予約、停止/完了競合、分割再開を固定時刻で確認する。
4. US4: 専用ListフェイクでPOST/PATCH応答紛失、一意競合、412、UserNotes保持、生成列競合、8,000文字境界を確認する。
5. メインのみ最終に `npm_config_cache=$TMPDIR/npm-cache npm run lint`、`npm_config_cache=$TMPDIR/npm-cache npm run typecheck`、`npm_config_cache=$TMPDIR/npm-cache npm test`、`npm_config_cache=$TMPDIR/npm-cache npm run build` と差分確認を1回行う。

既定は `TEAMS_TODO_ENABLED=false`、`TEAMS_REMINDERS_ENABLED=false`、`TEAMS_RECORD_MODE=off`。全offは003互換、ToDoだけ有効なら管理投稿予約/送信なし、記録だけ有効なら自動登録/完了操作なし。`message` は管理投稿、`sharepoint` は管理投稿と専用Listを独立同期する。ingress/worker設定を一致させる。

TasksとSchedulerは非公開workerのCloud Run IAM + OIDCで保護する。workerアプリ内JWT検証はない。`/cron/teams-reminders`（月〜金09:00 JST）、`/cron/teams-repair`（例5分毎）の本文は `{"platform":"teams"}`。OIDC audienceはパスなしworker URL。設定例は導入手順を参照。Slack workerへは登録しない。

通常返信と台帳の成功を記録失敗で巻き戻さない。返信の副作用別状態と `@Arbalest record status` を照合する。旧summary進捗の通常返信IDを管理投稿IDに流用しない。結果不明は自動createせず、削除済み管理slotは明示todo/canvasだけで再取得する。

## 利用者の導入確認（W10）

003 T014 を先に確認する。本番以外のテスト環境で、管理者がアプリ導入・会話参照・専用List/列/一意キー・固定対応を用意する。資格情報や実会話をリポジトリ/ログへ記録しない。

- desktop/web/mobileでカード登録/完了/拒否/古いカード再取得、管理投稿更新、能動通知停止/再開を確認する。
- Selectedと専用List writeだけでGET/検索/POST/PATCH/412が成功し、他Listへのアクセスが拒否されることを確認する。チャネルとListの閲覧範囲を照合する。
- 実接続確認前は外部同期を無効のままとする。機能フラグは C9。切戻しはフラグ無効化で送信/新規登録を止める。既存投稿/行は自動削除されない。
- delivery_unknownは管理者確認後の再関連付けか明示再作成、conflictは生成列の確認後の明示再同期。誤共有は同期停止後に管理者が共有範囲と既存行を処理する。
- 元スレッドで保存済み管理者が `record status` → 現revision/slot確認 → `record relink <revision> <slot> <activityId>`、または重複承認付き `record recreate <revision> <slot> acknowledge-duplicate` → 再度状態確認。生成列上書きは `record resync <revision> acknowledge-generated-overwrite`。各コマンドには `@Arbalest` を付ける。任意URLは受け付けない。
- 生成列はすべて文字列・各8,000文字以下、ArbalestKeyは一意/索引必須、UserNotesは生成対象外。固定bindingのSelected/listWrite/get/search/post/patch/precondition/otherListDenied/sameAudienceを実確認後にすべてtrueにする。
- アプリ削除イベントは認証後に同tenant/teamをdisabledにする。再導入で自動解除せず、削除済みscopeの再有効化入口は未提供。フラグの一時停止/再開と区別する。

実資格情報を使う `npm run test:firestore` と `npm run eval` は利用者のみ。部下・メインは実行しない。実接続結果と合成テストの成功を区別する。
