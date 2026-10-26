# Research

## R1 — Graph による履歴

親は get chatMessage、返信は list replies。チャネル列挙は返信を含まないので各親の返信もページングする。
`ChannelMessage.Read.Group` application RSC は導入チーム限定。標準チャネル判定のチャネル情報GETには `ChannelSettings.Read.Group` も必要。両方をmanifestに宣言し、導入時の同意を得る。

- https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/channel-get?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent

## R2 — Teams SDK

公式 `@microsoft/teams.apps` の App が `/api/messages` を認証する。clientId/clientSecret/tenantId を明示し、匿名許可を使わない。
worker の返信は認証済みの serviceUrl と会話IDを使う。Graph の通常 application 権限による投稿は使わない。

- https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/essentials/app-basics
- https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/essentials/app-authentication/overview
- https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- https://github.com/microsoft/teams.ts

## R3 — 分析の互換性

共通 analyze/analyzeFindings は既存 SlackMessage 形状と秒.microsecond を使う。
Teams のIDは時刻と同一視しない。createdDateTimeから分析IDを作り、衝突時のsuffixをコードで付ける。
元ID・webUrl・表示名の対応を取得結果に保持し、根拠のリンクをコードで生成する。
TeamsのHTMLはHTMLパーサーで平文にし、リンクやメンションを文字として扱う。

## R4 — 初版の境界

標準チャネル、単一tenantと明示team allowlist。チャット・private/shared channelを対象にせず、ToDoは抽出結果の表示だけ。
Microsoft認証・ネットワークの動作を合成テストだけで実証したと主張しない。

## R5 — メッセージIDのスコープ

GraphのchatMessage.idはchat/channel/reply-to-message内で一意。他のスレッドの返信と同じIDを持つ場合がある。
チャネルの全量取得時の重複除去・親への対応にはrootとidの組を使う。

- https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0
