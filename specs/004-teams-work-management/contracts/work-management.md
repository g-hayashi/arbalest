# Contract: Teams の ToDo と共有記録

本書の型・関数は新規実装の契約。既存機能として利用可能とは扱わない。型は `src/teams/types.ts` と `src/teams/store/types.ts` に置き、同名の分析型と混同しない。

## C1 永続根拠（W01、R1、D1）

```ts
type TeamsScope = { tenantId: string; teamId: string; channelId: string; rootMessageId: string };
type MessageRef = TeamsScope & { kind: "root" | "reply"; messageId: string };
// 既存の引数と戻り値の構成は維持し、戻り値に必須欄を追加する。
type TeamsConversation = {
  messages: SlackMessage[]; names: Map<string, string>;
  links: Map<string, string>; sourceIds: Map<string, string>;
  sourceRefs: Map<string, MessageRef>;
};
interface TeamsGraphReader {
  getThread(teamId: string, channelId: string, rootId: string): Promise<TeamsConversation>;
  getChannel(teamId: string, channelId: string, start: Date, end: Date): Promise<TeamsConversation>;
}
```

`createTeamsGraphReader(options)` の既存設定・TeamsApiError を維持する。messages に残した各分析時刻 ts に1つの messageRef、同じ ts の検証済みリンクがある。親/返信/別root/同時刻/同一生 ID を区別する。tenant/team UUID を小文字にし、不透明 ID を変更しない。空/不正な元 ID、root 関係不一致は既存の不完全履歴エラーとして失敗させ、部分結果を成功にしない。`sourceIds` は互換用で永続照合には使用しない。分析の `p1` 等は messages の元 userId（AAD）に戻して担当者を保存する。

## C2 同一性の純粋関数（W02、R2、D2/V3）

```ts
function matchTeamsTodos(input: {
  scope: TeamsScope; candidates: TeamsTodoCandidate[]; existing: TeamsTodo[];
}): TeamsTodoMatch[];
```

候補は本文・1件以上の検証済み TeamsEvidence・担当者 Aad|null・期限|null・certainty・needsReview・closed を持つ。戻り値は候補ごとの `existing|update_proposal|ambiguous|new` と対応 todoId 群、変更差分を持つ。入力を変更しない。完全一致が双方1件だけなら既存 ID を返す。担当者/期限差は update_proposal、同根拠に複数作業/本文・根拠変更は ambiguous。new は既存根拠と重ならない候補のみ。scope 不一致と不正根拠は `invalid_scope|invalid_evidence`。完了状態は既存優先、候補消失時も既存を削除しない。

## C3 専用ストア（W03、R3、D2〜D6/D8/V1〜V6）

```ts
interface TeamsWorkStore {
  getTodos(scope: TeamsScope): Promise<TeamsTodo[]>;
  getSettings(scope: TeamsScope): Promise<TeamsThreadSettings | null>;
  listSettings(): Promise<TeamsThreadSettings[]>;
  ensureSettings(input: TeamsSettingsInput): Promise<TeamsThreadSettings>;
  disableThread(input: { scope: TeamsScope; now: Date }): Promise<void>;
  register(input: TeamsRegisterInput): Promise<{ todo: TeamsTodo; changed: boolean }>;
  confirmUpdate(input: TeamsUpdateInput): Promise<{ todo: TeamsTodo; changed: boolean }>;
  markDone(input: TeamsDoneInput): Promise<{ todo: TeamsTodo; changed: boolean }>;
  setNotifications(input: TeamsNotificationInput): Promise<TeamsThreadSettings>;
  putActionRef(input: TeamsActionRefInput): Promise<void>;
  getActionRef(tokenHash: string): Promise<TeamsActionRef | null>;
  reserveEffect(input: TeamsEffectInput): Promise<{ effect: TeamsEffect; created: boolean }>;
  getEffect(operationId: string): Promise<TeamsEffect | null>;
  claimEffect(operationId: string, owner: string, now: Date): Promise<TeamsEffectLease | null>;
  extendEffectLease(input: TeamsLeaseInput): Promise<TeamsEffectLease>;
  saveEffect(input: TeamsEffectSaveInput): Promise<void>;
  getRecord(scope: TeamsScope): Promise<TeamsRecord | null>;
  listRecords(): Promise<TeamsRecord[]>;
  reserveRecord(input: TeamsRecordReserveInput): Promise<TeamsRecord>;
  saveRecord(input: TeamsRecordSaveInput): Promise<void>;
}
```

Input は必ず scope・認証済み actorAadId（人の操作）・now を持つ。register は検証済み候補、要求 ID、モード（new|link）、link 時の todoId/expectedRevision を持つ。更新/完了は todoId または同 scope の displayNo、expectedRevision を持つ。通知変更は enabled を持つ。変更時は表示と同期予定を同じ transaction で予約する。最初の管理操作時だけ manager を確定し、連番は同時登録でも重複させない。完了済みの正当な再操作は changed=false。権限のない再操作は完了済みでも拒否する。

台帳変更の `recordPolicy` は `always|existing_only|none`。未指定は W03 互換の `always`。W05 の記録抑止は `none` として record/effect を予約・更新せず、明示候補操作と完了は `existing_only` として既存記録だけを同じ transaction で更新する。記録の新規有効化は、条件付きまとめか明示 canvas の予約で行う。

EffectInput は operationId・scope・kind・revision・snapshot・expireAt。重複予約は保存済み値を返し上書きしない。保存/延長は lease owner と fencingToken・有効期限・最新 desiredRevision を比較する。RecordSaveInput は保存予定 snapshot/revision と lease 情報を持つ。台帳変更に伴う record/effect 予約は単独 saveRecord との別 transaction にしない。

エラーは C10。各 repo に時刻と ID 生成を注入する。`createMemoryTeamsWorkStore({now?,newId?})` と `createFirestoreTeamsWorkStore({firestore,collectionPrefix,now?,newId?})` を同じ契約テストで確認する。Firestore unit は代替 DB を注入し、実DBの接続・削除は行わない。既存 Slack Store の CollectionName/一覧へ Teams コレクションを追加しない。

W03 の具体型は `src/teams/store/types.ts`、両 backend で共有する transaction 処理は `common.ts`。`renderSnapshot` は純粋関数として注入し、未指定では台帳を含む空の表示 slot を予約する。表示と外部送信の接続は W05/W06/W09 で行う。`ensureSettings` は認証済みの接続先を既存 trusted service URL 検査と同 channel/root の会話 ID 検査で制限する。時刻は注入時計と入力時刻の遅い方を処理開始時に固定し、過去 payload による期限回避を防ぐ。`reserveRecord` は明示記録用、`saveRecord` は固定 snapshot を変更せず送信進捗だけを保存する。作成中 slot のリース失効は record/effect 双方で `delivery_unknown` にする。再作成・再関連付けは W06 の明示復旧で扱う。

## C4 カード/コマンド受付（W04、R4、D6/V4）

```ts
type TeamsActionPayload = {
  platform: "teams"; taskName: string; tokenHash: string;
  scope: TeamsScope; actorAadId: string; sourceActivityId: string; requestedAt: string;
};
function dispatchTeamsAction(activity: AuthenticatedTeamsActivity,
  deps: TeamsActionIngressDeps): Promise<TeamsActionResponse>;
function executeTeamsAction(payload: TeamsActionPayload,
  deps: TeamsActionWorkerDeps): Promise<{ changed: boolean }>;
```

Action.Execute の data は `{token:string}` だけ。汎用 SDK `card.action` で処理し、verb/data から操作対象/宛先/権限を決めない。SDK2.1.1 の handler/応答は合成 HTTP でテストする。受付の応答本体は `{statusCode:200,type:"application/vnd.microsoft.activity.message",value:string}`、受付/拒否/再取得を表す簡潔な文とする。SDK が未認証で拒否したリクエストは handler へ渡らない。カードにはメンションを要求しない。

tenant/team allowlist、実際の channel/root、aadObjectId、元カード ID、参照期限・revision を受付と worker で検査する。enqueue 成功時だけ受付済みとする。taskName は認証済みイベント ID と scope から固定し、別イベントの二重クリックは store の transaction でも抑止する。raw token・依頼本文・認証ヘッダーはログへ出さない。

古い revision は stale_revision と再一覧案内。完了済みへの正当な done は changed=false にできるが、古い担当者/期限への更新は適用しない。登録候補は根拠を再検査、link/confirm_update/done は既存担当者または登録者、通知変更は manager。拒否は invoke 内に返し、非公開返信が使えない経路では人物・内容をチャネルへ追加投稿しない。明示コマンドは簡潔な拒否返信を許す。

## C5 ToDo オーケストレーション（W05、R5、D2〜D4）

```ts
function manageTeamsTodos(input: {
  payload: TeamsJobPayload; intent: TeamsWorkIntent; conversation: TeamsConversation;
  analysis: TeamsAnalysisResult;
}, deps: TeamsTodoDeps): Promise<TeamsTodoOutcome>;
```

| 依頼 | 新規 ToDo | 管理投稿/外部記録 |
| --- | --- | --- |
| まとめて | C2 と自動登録条件を満たすもの | 検証済み topic/未完了ToDo/未解決の問いがあるとき自動記録 |
| 返信だけでまとめて | なし | 更新なし |
| todo | 候補と台帳を表示、明示登録のみ | 外部記録を新規作成しない |
| 候補の登録/関連付け/更新確認 | 操作範囲と権限に従う | 新規副作用を勝手に有効化しない |
| done T12/完了 | 新規なし、指定1件の状態変更 | 既存記録に台帳状態を反映 |
| canvas | 新規なし | 明示更新。調整事項条件は不要 |
| 通知停止/通知再開 | なし | スレッドの通知フラグだけ |
| findings 7 | なし | 振り返り返信だけ |

自動登録条件は evidence一致・担当者が取得参加者に存在・needsReview=false・certainty=explicit・closed=false。期限未定は可。明示登録は担当未定可、根拠不一致は不可。suppressTodo/suppressCanvas は独立に適用する。既存進捗の summary:N を管理進捗として誤読しない。TeamsTodoOutcome は候補/台帳/変更件数/副作用ごとの状態と拒否理由を持つ。

## C6 Teams 管理投稿（W06、R6/R10、D4/D5/V6/V7）

```ts
interface TeamsRecordWriter {
  create(scope: TeamsScope, reference: TeamsConversationReference,
    message: TeamsRecordMessage): Promise<{ activityId: string }>;
  update(scope: TeamsScope, reference: TeamsConversationReference,
    activityId: string, message: TeamsRecordMessage): Promise<void>;
}
function syncTeamsRecord(input: { scope: TeamsScope; revision: number },
  deps: TeamsRecordDeps): Promise<TeamsRecordOutcome>;
```

reference は SDK 認証時に保存した serviceUrl/conversationId のみ。message は固定 snapshot の slot・本文/カードとする。文字列slotは8,000文字以下、snapshot JSONは256KiB以下を保存時/読込時に検査する。カードは SDK の payload 制限も検査し、超過時に省略を完全な記録と表示しない。

create前に creating を永続化。空ID、作成後保存失敗、creating lease失効は delivery_unknown とし、自動 create を止める。管理者の再関連付けは同scope/bot所有のIDを検証する。明示再作成は重複の可能性を示して実行する。update は保存済み bot 所有 ID のみ。404による再作成は明示の一覧再取得/canvas時のみ。縮小slotは「この内容は統合済み」に更新する。

送信前のlease/revision検査、旧worker保存拒否、最新revision定期修復を行う。Teams更新とDBの原子性は保証しない。Teams成功/SharePoint失敗を独立保持し、結果返信に部分失敗を示す。

W06 の具体APIは `src/teams/records.ts`。`syncTeamsRecord` の `repair:true` は適用済みの最新revisionもupdateで再適用し、`explicitRefresh:true` は削除済みslotの再作成を明示的に許可する。結果不明slotはどちらでも自動再作成しない。`recoverTeamsRecord` はmanager・最新revision・保持期限・稼働lease不在を検査し、`recreate` は `acknowledgeDuplicate:true` を必須とする。`relink` は外部照会関数 `verifyActivity` が必須で、未注入なら拒否する。`createTeamsRecordVerifier` は固定scopeの [Graph返信GET](https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0) でid・replyToId・channelIdentityを照合し、[application identity](https://learn.microsoft.com/en-us/graph/api/resources/teamworkapplicationidentity?view=graph-rest-1.0) がbot/tenantBotかつ設定したapp IDの投稿だけを許可する。削除済み・ユーザー投稿・不明identityは拒否し、通常履歴から所有を推測しない。

`renderTeamsRecordSnapshot` をstoreへ注入すると、以前の検証済み分析表示・`content.names` を維持し、現在台帳の状態・根拠リンクを重ねる。起動factoryへの注入はW09。任意の `TeamsTodoDeps.writer` がある場合、明示 `todo` だけが候補/完了カード用の別 `reply` effectを予約する。通常返信IDをsummary進捗へ保存後、`flushTeamsTodoCards` がupdateでカードを付加する。raw tokenはカード送信時のみ発行し、snapshot/effectへ保存しない。サイズは固定長ダミーtokenで全体を先に検査し、超過時は参照発行・部分送信をしない。カード更新失敗時の再試行は保存済み候補・通常返信IDを使い、分析や通常返信を再実行しない。

## C7 リマインド（W07、R7、D3/D5/D8）

```ts
function selectTeamsReminderTodos(todos: TeamsTodo[], now: Date): TeamsTodo[];
function createTeamsRemindersJob(deps: TeamsReminderDeps):
  (payload: unknown, ctx: TeamsWorkJobContext) => Promise<void>;
```

月〜金09:00 JSTの起動は既存scheduler経路に接続し、対象選択は isBusinessDay/nextBusinessDay/jstDateIso を共有する。dueIso は JST日付で次営業日以下、期限超過を含む。期限なしは月曜だけ。open、有効、通知有効の項目のみ。元スレッド1日1組、表示名のみ、mentionなし。

operationId は `[jstDate,targetId,"reminder"]` だけから固定し、transactionでsnapshotを予約。送信前に完了/停止/期限切れ/allowlist/アプリ有効状態を確認して除外する。追加と内容変更は翌営業日に反映し、成功済みslotをスキップする。予約時点の内容をその日の再試行で別snapshotへ置換しない。

401/403は通知停止・要再接続、404は対象無効化、429はRetry-After、5xxは上限付き再試行。通知には受信理由/期限/根拠/完了方法/停止方法を含める。送信成功から記録前の障害による重複と、送信と同時完了による直前状態の配信は残る。DM/別チャネルへ迂回しない。

実装APIの依存は `TeamsReminderDeps = {store, writer:Pick<TeamsRecordWriter,"create">, now, canSend(scope):Promise<boolean>, owner?, maxAttempts?}`。`canSend` は feature/allowlist/アプリ有効状態を確認し、未確認時falseとする。ジョブは `(payload:unknown, ctx:TeamsWorkJobContext)=>Promise<void>`、ctxは任意の安全な `log` を受け取る。W09でcronのOIDC経路に接続する。

日次IDは `JSON.stringify([jstDateIso(now), teamsWorkTargetId(scope), "reminder"])`。各ToDoを安定slotとして保存し、本文/表示名は予約時の値を保持する。送信前に現在の状態/期限で対象外を除外し、完了内容の変更は行わない。通知はcreating停止を用いず、pendingから送信してactivityId/appliedを保存する。

401/403は `stopNotifications({scope,now})` で自動停止し、人操作時刻/保持期限を変更しない。管理者の `setNotifications` による再開は従来の人操作として扱う。429はeffectの `nextAttemptAt` にRetry-Afterを保存し、待機中の再呼び出しも残り時間を持つ `TeamsApiError(429,retryAfterMs)` をthrowする。W09では失敗HTTP応答とSchedulerの再試行を維持する。試行回数はclaim成立時だけ加算し、既定3回を超えた同日再送はしない。400等の非retryableは未送信slotをfailedにして自動再送を止める。他scopeは処理を継続し、一時失敗だけを最後にthrowする。

## C8 SharePoint（W08、R8/R9、D4/D7/V8）

```ts
interface TeamsSharePointClient {
  findByKey(siteId: string, listId: string, key: string): Promise<SharePointRow | null>;
  create(siteId: string, listId: string, fields: GeneratedFields): Promise<SharePointRow>;
  get(siteId: string, listId: string, itemId: string): Promise<SharePointRow>;
  patch(siteId: string, listId: string, itemId: string,
    etag: string, fields: GeneratedFields): Promise<SharePointRow>;
}
function syncTeamsSharePoint(input: { scope: TeamsScope; revision: number },
  deps: TeamsSharePointDeps): Promise<TeamsSharePointOutcome>;
function resyncTeamsSharePoint(input: {
  scope: TeamsScope; revision: number; actorAadId: string;
  acknowledgeGeneratedOverwrite: boolean;
}, deps: TeamsSharePointDeps): Promise<TeamsSharePointOutcome>;
```

GeneratedFields は D7 の列のうち UserNotes を除く許可列だけ。site/list はscope固定設定で解決し、利用者がURLを指定できない。ArbalestKeyはscopeハッシュで一意/索引あり。POSTの前と応答紛失/一意競合後に検索し再利用する。PATCHは取得etagをIf-Matchに入れる。

外部呼出し前に予定fields/hash/revisionを保存。再取得値が予定値と一致→applied、前回appliedHashと一致→未適用で再試行、両方と不一致→conflict。412も同じ照合を使い、UserNotesだけの編集なら再適用。生成列編集は自動上書きせず管理者確認後の明示再同期とする。8,000文字超過はtoo_largeで止め、既存行を変更しない。

旧revisionのpendingが残る場合は、その予定値を保持・保存したままGET/検索で照合する。実行結果を旧pendingのcanonical hashとrevisionで証明してappliedHash/appliedRevisionを保存してから、最新pendingを保存してPOST/PATCHへ進む。照合中の通信失敗やプロセス停止で旧pendingの証跡を失わない。GeneratedAtを含む同revisionのpendingFieldsは再試行で再生成しない。

明示再同期は認証済みactorAadIdがmanagerAadIdと一致し、現在revisionと生成列上書き同意を検査した場合だけ許可する。固定Listから取得した現在行を基準にIf-Match付きPATCHを行い、その後の412でも再照合して新たな人の編集を自動上書きしない。初回検索の既存行は予定値一致だけを自分の適用として扱い、根拠なしの上書きをしない。

`createTeamsSharePointClient({siteId,listId,token,fetch?})` は固定Graph URLだけを生成し、redirectを禁止する。検索のArbalestKeyは既存targetIdと同じ `teams_<64桁hex>`。PATCHはfieldValueSetを送信し、固定item GETでetagと実際の列を取得する。scope固定bindingと有効化ゲートは同期サービスが検査し、HTTP clientに任意URLや他Listを渡せない。

Selectedと専用List write、GET/検索/POST/PATCH/412/他List拒否、標準チャネルと同じ閲覧範囲の確認済み設定が有効化条件。ゲート未達はexternal_not_verified。実行ボットへ管理者の付与権限を渡さず、権限を自動拡大しない。無効化は既存行削除を意味しない。

## C9 起動・worker・設定（W09、R10、D4/D5）

設定は `TEAMS_TODO_ENABLED=false`、`TEAMS_REMINDERS_ENABLED=false`、`TEAMS_RECORD_MODE=off|message|sharepoint`（既定off）。SharePoint対応はtenant/team/channel→siteId/listIdを固定し、有効化検証済み状態を設定で持つ。既存 `src/config.ts` の discriminated union とvalidationに合わせて実装する。

Teams の新規worker経路は `/jobs/teams-action`、通知/修復は `/cron/teams-reminders`・`/cron/teams-repair` とする。既存同様、worker の認証は非公開 Cloud Run の IAM と Cloud Tasks/Scheduler の OIDC に委ねる。現在の `src/worker/server.ts` がアプリ内で JWT を検証しているとは扱わない。platform=teams を要求し、Slack workerでは登録しない。既存 `/jobs/teams-request` は維持する。feature無効時は003のまとめ/Findingsと通常返信の契約を維持し、ToDo/管理投稿/外部同期を実行しない。

修復はfailed/pendingの最新revisionを再適用し、delivery_unknownの自動新規投稿はしない。別副作用の成功を失敗で巻き戻さず、投入失敗は成功にしない。対象無効化時は登録/送信を停止する。記録のsnapshot上限と旧summary進捗の境界を検査する。

## C10 エラーと公開範囲

業務エラーは `TeamsWorkError` の `code` として統一する。外部例外本文、token、会話本文、URL全体をログへ展開しない。変更する場合は同じ値を参照する全テストを検索して追随する。

| code | 意味と扱い |
| --- | --- |
| invalid_scope / invalid_evidence | scope/根拠不正。変更せず拒否 |
| unauthorized / not_found | 無権限/対象なし。内容を追加公開しない |
| expired / stale_revision | 期限切れ/旧版。再一覧取得を案内 |
| ambiguous | 明示の関連付けか別件登録が必要 |
| disabled / external_not_verified | 無効/導入ゲート未達。送信しない |
| snapshot_too_large / too_large | 内部snapshot/外部列上限。切捨てず既存維持 |
| lease_lost / superseded | 旧worker/旧版。保存・新規送信を中止 |
| delivery_unknown | Teams新規投稿結果不明。管理者確認が必要 |
| conflict | 外部生成列の変更を検出。自動上書きしない |
| enqueue_failed | 受付成功と返さず再操作を案内 |

通信失敗は既存 TeamsApiError の status/retryable を維持し、401/403/404/429/5xxをC7の規則で分類する。上限到達はfailed/pendingを保存し最新revisionの修復対象にする。非公開invoke拒否と明示コマンドの簡潔な拒否を区別する。
