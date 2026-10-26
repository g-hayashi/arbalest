# Teams Contracts

## C1 — ingress

POST /api/messages。Microsoft SDKでJWTを検証。messageかつmsteams/channel/許可tenant/team/自分へのmentionを確認する。
キュー投入成功後に2xx。投入失敗は再試行可能な5xx。イベントIDを名前空間化して重複タスク名を固定する。
GET /healthz は秘密を返さない。

## C2 — Graph

GraphReader は getThread(teamId, channelId, rootId) と getChannel(teamId, channelId, start, end) を持つ。
GET /v1.0/teams/{team}/channels/{channel}/messages[/{root}[/replies]]。
最大ページ数/メッセージ数を明示。429・5xx・timeoutは再試行可能。401/403/404は利用者向け固定メッセージ。
例外にトークン・本文・レスポンスbodyは含めない。

## C3 — worker

POST /jobs/teams-request。既存Cloud Run workerのIAM保護下で実行。
サービスURL・tenant/team allowlistを再検証し、名前空間化したtargetロックとevent重複除去を適用。
失敗・busy通知もTeamsへ送る。Slack通知経路を使わない。
空/summaryは共通analyze、自然文はinterpretRequest、Findingsは共通analyzeFindings。
返信はボットAPIで元スレッドへ送る。根拠リンク、取得件数/範囲、未対応の管理操作を明記。

## C4 — config

CHAT_PLATFORM既定slack。teamsではTEAMS_APP_ID/TEAMS_APP_SECRET/TEAMS_TENANT_ID/TEAMS_ALLOWED_TEAM_IDS必須。
既存GCP/Tasks/LLM設定を共用。TeamsではSLACK_BOT_TOKEN/SLACK_SIGNING_SECRET不要。匿名モードなし。
