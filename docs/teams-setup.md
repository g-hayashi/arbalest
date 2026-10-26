# Teams 版の導入・検証

Teams 版は Slack と同じ分析・根拠検証・決定判定・Findings・LLM 接続・ストア実装を使う。
同じコンテナイメージを、`CHAT_PLATFORM=teams` の ingress と worker として起動する。
Slack の稼働サービスは既定の `CHAT_PLATFORM=slack` のまま維持する。
Teams の標準チャネル専用。個人/グループチャット、private/shared channel は対象外。

## できること

| Teams の操作 | 動作 |
| --- | --- |
| スレッドで `@Arbalest` / `まとめ` / `summary` / `要約` | 親と返信から概要・決定・未決定・ToDo・問いを根拠リンク付きで返信 |
| 新規投稿で `@Arbalest` | その投稿のスレッドを対象にする。Slack 版の直近7日表示とは異なる |
| `@Arbalest この会話を整理して` | 既存の自然文意図抽出を使って要約 |
| `@Arbalest findings 7` | チャネル全体の直近7日（返信を含む）の Findings |
| `@Arbalest 先週の動きを振り返って` | JST の前週月曜0時から今週月曜0時未満の Findings |

期間省略は直近30日、上限90日。期間前の親についた期間内返信も取得する。
管理機能の既定は無効。以下のフラグを有効にすると、ToDo の登録・候補カード・`done T12`・元スレッドへの期限通知・更新可能な管理投稿を使える。`canvas` は元スレッドの管理投稿を明示更新し、タブを作成しない。SharePoint は専用 List への任意同期で、導入ゲートの実確認が必要。
リアクションからの合意判定は初版では行わない。発言本文を根拠にする。

## 1. Microsoft 側の登録（利用者・管理者）

1. Microsoft Entra に単一テナントのアプリを登録する。Application (client) ID と Directory (tenant) ID を控える。
2. アプリのクライアントシークレットを作成し、Secret Manager に保管する。リポジトリ、`.env`、ターミナルの履歴やログへ値を書かない。
3. アプリの Application ID URI を `api://<Application ID>` に設定する。Graph のトークンは client credentials で `https://graph.microsoft.com/.default` を使う。
4. Azure Bot を作成し、同じ Application ID、Single Tenant、tenant ID と資格情報を設定する。チャネルに Microsoft Teams を追加する。
5. Messaging endpoint を **テスト用 ingress の `https://<host>/api/messages`** に設定する。ingress は公開 HTTPS、worker は非公開で Cloud Tasks の OIDC/IAM 保護を維持する。
6. Teams アプリのカスタムアップロードと RSC の同意が組織で許可されていることを確認する。

このコードは商用クラウドとクライアントシークレット構成を対象とする。匿名モードを有効にする設定は用意していない。
SDK は JWT の署名・受信対象などを検証する。さらにアプリのコードで tenant、許可 team、チャネルとスレッドの整合性、自分宛てメンション、返信先ホストを検証する。

## 2. Teams アプリのパッケージ

`teams/manifest.template.json` はアプリ ID と公開URLが未設定のテンプレート。
以下は公開の識別子・URLだけを指定する。シークレットを渡さない。

```sh
npm_config_cache=$TMPDIR/npm-cache npm run teams:package -- \
  --app-id '<Application ID>' \
  --website-url 'https://<公開サポートページ>' \
  --privacy-url 'https://<公開プライバシーページ>' \
  --terms-url 'https://<公開利用条件ページ>' \
  --output .tmp/teams-app.zip
```

ZIP 直下に `manifest.json`、白色・透明背景32×32の `outline.png`、192×192の `color.png` を生成する。
公開URLには利用者がアクセスできる実際のHTTPSページを使う。
パッケージ更新時は `teams/manifest.template.json` の `version` を上げる。
Teams Developer Portal の検証を通した後、**テスト用チームだけ**にアップロードする。

宣言する application RSC は次の2つ。

| 権限 | 用途 |
| --- | --- |
| `ChannelMessage.Read.Group` | 導入チーム内のチャネル投稿・返信の取得 |
| `ChannelSettings.Read.Group` | チャネル情報を取得し、標準チャネルであることを確認 |

チームへの導入時に権限へ同意する。RSC はチーム単位であり、チャネル単位ではない。
アプリコードの team allowlist も別途必要。tenant 全体を読む `ChannelMessage.Read.All` 等は要求しない。
通常の返信は SDK の Bot Connector を使用する。移行用 Graph 投稿権限は使わない。

## 3. 実行設定

既存の `GCP_PROJECT`、`TASKS_QUEUE`、`TASKS_LOCATION`、`TASKS_INVOKER_SA`、`FIRESTORE_DATABASE`、LLM 設定を共用する。
同じイメージから **Teams 用に別の ingress/worker の組**を構成する。Teams ingress の `WORKER_URL` は Teams worker を指す。
Slack worker と同じURLへ Teams のタスクを送らない。

| 設定 | 内容 |
| --- | --- |
| `CHAT_PLATFORM` | `teams`。省略時は従来どおり `slack` |
| `APP_ROLE` | ingress / worker |
| `TEAMS_APP_ID` | Application (client) ID、UUID |
| `TEAMS_APP_SECRET` | Secret Manager から渡すクライアントシークレット |
| `TEAMS_TENANT_ID` | 許可する単一tenantのUUID |
| `TEAMS_ALLOWED_TEAM_IDS` | 許可teamの **Microsoft 365 group ID（UUID）** をカンマ区切り。空は拒否 |
| `WORKER_URL` | Teams ingress に必須。Teams worker のHTTPS URL |
| `TASKS_MAX_RETRY_COUNT` | キューの max_attempts - 1。既定4 |
| `TEAMS_TODO_ENABLED` | `true` / `false`。既定 `false`。登録・完了・候補カード・通知設定の操作 |
| `TEAMS_REMINDERS_ENABLED` | `true` / `false`。既定 `false`。通知には ToDo フラグも必要 |
| `TEAMS_RECORD_MODE` | `off`（既定）/ `message` / `sharepoint`。message は管理投稿、sharepoint は管理投稿と専用 List を独立同期 |
| `TEAMS_SHAREPOINT_BINDINGS` | 固定 tenant/team/channel→site/list と確認済みゲートの JSON 配列。既定 `[]`。不正JSON・別tenant/team・同一scopeの重複は起動時に拒否し、値をログへ出さない |

`channelData.team.id` の `19:...` は Graph の team ID ではない。
受信では `channelData.team.aadGroupId` を使い、allowlist と照合する。
Teams 版には `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` は不要。
全フラグoffでは `/jobs/teams-request` の003互換動作だけを登録する。管理機能有効時は `/cron/teams-reminders`・`/cron/teams-repair`、ToDo有効時だけ `/jobs/teams-action` も登録する。Slack ジョブは登録しない。cron本文は `{"platform":"teams"}` のみ。別platform・任意宛先を含む本文は拒否する。
Teams 対象の保存キーは tenant/team/channel/root を含むSHA256の `teams_...` とし、Slack の対象と分離する。

ingress/worker のフラグと固定設定を一致させる。ToDoだけ有効なら管理記録を予約・送信せず、記録だけ有効ならToDoを自動登録せず完了操作も受け付けない。記録/ToDo/通知を全offにすると、既存投稿や行を削除せず003の通常返信へ戻る。

### Scheduler と認証（設定例のみ）

worker の認証は **非公開 Cloud Run の IAM** と Tasks/Scheduler の OIDC に委ねる。アプリの worker HTTP listener 自体は JWT を検証しない。worker を公開するとこの保護を失う。ingress の SDK JWT 検証とは別の境界である。

運用者がテスト環境で Scheduler の呼出元SAに対象workerの `roles/run.invoker` を設定し、次の形式で作成する。`--oidc-token-audience` はパスを含まないworker URL、`--uri` はジョブのパスを含むURLにする。この作業ではインフラ変更・Scheduler作成を実行していない。

```sh
gcloud scheduler jobs create http teams-reminders-test \
  --location='<Scheduler location>' --schedule='0 9 * * 1-5' --time-zone='Asia/Tokyo' \
  --uri='https://<非公開Teams worker>/cron/teams-reminders' --http-method=POST \
  --headers='Content-Type=application/json' --message-body='{"platform":"teams"}' \
  --oidc-service-account-email='<invoker SA>' --oidc-token-audience='https://<非公開Teams worker>'
```

修復は同じ設定で `/cron/teams-repair`、例 `*/5 * * * *` を使う。cronはtaskNameによる重複除去をせず、日次effectと管理記録のrevisionで再試行を制御する。429は保存済みRetry-Afterまで待ち、一時障害はHTTP失敗を維持する。全scopeを処理してから一時失敗を返す。

### SharePoint の固定設定

専用Listを管理者が用意し、生成列 `ArbalestKey`、`Title`、`ThreadUrl`、`Overview`、`Decisions`、`OpenIssues`、`Todos`、`Questions`、`Evidence`、`GeneratedAt`、`Revision` はすべて文字列型にする。長文列はプレーンテキスト（各8,000文字以下）、`ArbalestKey` は一意制約と索引を必須にする。人のメモは `UserNotes` に置き、生成のPOST/PATCHでは送らない。

`TEAMS_SHAREPOINT_BINDINGS` の要素形式（識別子はテスト環境の固定値に置換）:

```json
[{
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "teamId": "33333333-3333-4333-8333-333333333333",
  "channelId": "19:test@thread.tacv2", "siteId": "<固定site ID>", "listId": "<固定List ID>",
  "verified": { "selected": false, "listWrite": false, "get": false, "search": false,
    "post": false, "patch": false, "precondition": false, "otherListDenied": false, "sameAudience": false }
}]
```

Selected権限と専用List write、GET/検索/POST/PATCH/412、他List拒否、標準チャネルと同じ閲覧範囲を運用者が実環境で確認した項目だけtrueにする。9項目すべてtrueのbindingだけ送信できる。実確認前は `TEAMS_RECORD_MODE=off` または `message` を維持する。コードは権限を追加・拡大しない。List/タブの自動作成や利用者指定URLへの同期は行わない。

このリポジトリから本番 GCP / Azure への作成・変更・デプロイは行っていない。
インフラ構成は既存の ingress/worker/Cloud Tasks の IAM と Secret Manager の原則をテスト環境にも適用する。

## 4. 検証

ローカルの `npm test` はフェイク Graph・LLM・メモリストアを使う。
SDK のJWTなし/不正JWT拒否と、認証後処理からキュー投入、worker の返信経路を検証する。
MSAL override の client-credentials API は通信をフェイクにして互換性を検証する。
これだけで実 Microsoft の署名・同意・認証情報の動作確認が済んだとは扱わない。

利用者による実環境の検証手順は [003 quickstart](../specs/003-teams-backend/quickstart.md) と [004 quickstart](../specs/004-teams-work-management/quickstart.md) を参照。
実AI、Firestore統合テスト、実Teamsデータを使う確認は利用者が実行する。出力をリポジトリへ保存しない。

## 制限・障害時の扱い

- 取得は既定で最大1,000 HTTP要求（チャネル情報を含む）、10,000取得メッセージ。上限/循環/不正なnextLinkを検出したら分析を中止し、不完全な結果を表示しない。
- チャネルの期間取得は古い親への新しい返信を落とさないため、親と返信を全走査してから期間で絞る。大規模チャネルでは期間を短くしても取得上限に達する場合がある。
- Graph の 429/5xx/通信障害は Cloud Tasks で再試行。401/403 は同意・導入・tenant/team ID・シークレットを確認する。404 は投稿の削除と対象を確認する。
- private/shared channel、設定外tenant/team、メンションなしの投稿では処理しない。チャネル種別の検証失敗は取得不能として通知する。
- 返信は最大8,000 UTF-16単位に分割。異常に長い1項目は本文を省略し、根拠リンクを残す。
- SDKとGraphの例外には本文やトークンが含まれ得るため、外部のエラー詳細はログへ展開しない。観測は固定の障害種別・件数・利用量で行う。
- SDK 2.1.1 の MSAL 依存には監査で既知の脆弱性が検出されたため、スコープを限定してMSAL 7.1以降へoverrideした。SDK更新時はoverrideの必要性と互換性を再確認する。
- タスク重複・成功済み返信は除外する。ただし送信成功直後、進捗保存前にプロセスが停止すると返信が重複する窓がある。外部APIとDBを跨ぐ厳密な一度だけの送信は保証しない。
- 対象分析のTTLは既存の90日、処理進捗は7日。Teamsの元投稿本文・依頼本文は永続化せず、構造化分析結果・参加者・根拠IDを保存する。再試行用の整形済み返信snapshot（最大256KiB）も処理進捗に保存し、履歴やAIの変動による分割返信の混在を防ぐ。

停止する場合は、テスト用Teamsアプリをチームから削除し、Teams ingress の外部受付を停止する。
Slack のサービスや設定を切り替える必要はない。Teamsの処理中タスクは再試行が止まるまで残るため、該当テストキューも運用側で停止する。

## 5. 停止と復旧

通常の停止はingress/workerのフラグを無効化し、通知/修復Schedulerも停止する。再開は導入ゲートを再確認して元のフラグへ戻す。通知だけなら管理者が元スレッドで `@Arbalest 通知停止` / `通知再開`、またはtodo一覧のボタンを使う。401/403による自動通知停止は保持期限を延長しない。

SDK認証済みのアプリ削除イベントは同tenant/teamの保存済みscopeをdisabledにする。再導入で自動解除しない。削除済みscopeの再有効化入口は未提供であり、フラグ再開とは区別する。元スレッド404も停止対象。管理投稿だけの404はdeletedとして保持し、明示 `todo` / `canvas` でのみ再作成する。SharePointの404はSP同期失敗として保持し、Teams台帳・通知設定を停止しない。

通常返信、台帳、Teams管理投稿、SharePointは別々の副作用。記録失敗で成功した台帳を巻き戻さず、返信に `Teams=... / SharePoint=...` を表示する。再試行と修復cronは固定snapshotを使い、LLMや完了済み通常返信を繰り返さない。保存/再読込は256KiB以下、管理投稿slotは8,000文字以下。上限超過を自動で切り捨てない。

結果不明（`delivery_unknown`）は自動新規投稿しない。保存済み管理者（最初のsettingsを作成した人）が、**対象の元スレッドでボットをメンションして**次の順に操作する。別scope・無権限・旧revisionは拒否する。revisionとslotは状態表示の値を使い、slotは0始まり。

1. `@Arbalest record status` で現在のrevision、slot状態、既知activityIdを確認する。
2. Teams上で既存投稿を確認できた場合は `@Arbalest record relink 3 0 1700000000123`。Graphで同scope・同bot所有を確認したIDだけ関連付けて更新する。URLは受け付けない。
3. 存在を確定できず、重複の可能性を承認して作り直す場合は `@Arbalest record recreate 3 0 acknowledge-duplicate`。同意文字列を省いた操作は拒否する。
4. SharePointの生成列競合は人が変更内容を確認し、上書き承認後だけ `@Arbalest record resync 3 acknowledge-generated-overwrite`。固定Listの現在行とIf-Matchで照合し、UserNotesは維持する。
5. 再度 `record status` で状態を確認する。競合・結果不明をcronが自動上書きしたとは扱わない。

これらは管理用の明示コマンドであり、自然文解釈や追加のGraph権限は使用しない。管理者コマンドへの応答は元スレッド内に表示される。

## 公式資料

- [チャネル投稿一覧とRSC](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)
- [チャネル返信一覧](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0)
- [チャネル情報取得の権限](https://learn.microsoft.com/en-us/graph/api/channel-get?view=graph-rest-1.0)
- [RSC の単位と同意](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams SDK 認証設定](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/essentials/app-authentication/overview)
- [能動返信とserviceURL](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [メッセージの制約](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability)
- [manifest 1.20 schema](https://developer.microsoft.com/en-us/json-schemas/teams/v1.20/MicrosoftTeams.schema.json)
