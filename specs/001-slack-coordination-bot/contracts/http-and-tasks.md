# Contract: HTTP エンドポイントとタスク

## ingress（公開、`APP_ROLE=ingress`）

| メソッドとパス | 呼び出し元 | 動作 |
|---|---|---|
| `POST /slack/events` | Slack（Events API、Interactivity） | 署名を検証し、`url_verification` に答える。イベントをタスクに変えて積み、ack する |
| `GET /healthz` | 確認用 | `200 ok` |

対象のイベントとタスクの対応:

| Slack | 条件 | タスクの path | 返信 |
|---|---|---|---|
| `app_mention` | コマンドを解析できた | `/jobs/<command>` | 受付の印として 👀 のリアクション |
| `app_mention` | 解析できない | タスクを積まない | 使い方をスレッドに返信する（ingress が直接送る。軽い処理） |
| `reaction_added` | `white_check_mark`（ingress は Firestore を読まずにすべて積む。worker が一覧か根拠のメッセージに当たらないものを無視する） | `/jobs/todo-done` | なし |
| `block_actions` | `action_id = "todo_done"` | `/jobs/todo-done` | なし |

タスク名: `evt-<event_id>`。block_actions は `act-<action_ts>-<user>`。

## worker（非公開、`APP_ROLE=worker`、IAM 必須）

| パス | 本文 | 動作 |
|---|---|---|
| `POST /jobs/summarize` | `JobPayload` | US1。`output: "reply"` |
| `POST /jobs/canvas` | `JobPayload` | US1 のまとめを作り、US3 の canvas に書き出す |
| `POST /jobs/todo` | `JobPayload` | US2。まとめを作り、ToDo を登録して一覧を返信 |
| `POST /jobs/findings` | `JobPayload & { days: number }` | US4 |
| `POST /jobs/todo-done` | `{ todoId?, messageTs?, channelId, userId }` | 完了にして、一覧を更新する |
| `POST /cron/reminders` | なし | 対象の ToDo を担当者ごとに DM でまとめて送る |
| `GET /healthz` | | |

```ts
type JobPayload = {
  taskName: string;          // 重複の除去（processed_events）
  command: "summarize" | "canvas" | "todo" | "findings";
  teamId: string;
  channelId: string;
  threadTs: string | null;   // null ならチャネルの直近（まとめ: 7 日）
  mentionTs: string;         // 返信の先（threadTs ?? mentionTs）
  userId: string;            // 呼んだ人
  days?: number;             // findings のみ。1〜90
  clamped?: boolean;         // findings のみ。90 日を超える指定を丸めたとき true（worker が返信にその旨を添える）
  requestedAt: string;       // ISO
};
```

応答コード:

- `2xx`: 完了、または重複のため処理しなかった。
- `5xx`: Cloud Tasks に再試行させたい一時的な失敗（AI の 429 や 5xx、Slack の 429）。`LlmError` の `timeout`・`rate_limit`・`server` と、種類の分からない失敗（ストア、Slack など）が当たる。
- 一時的でない失敗は、再試行しても同じ結果になるので、1 回目でも `200` にして、失敗したことを利用者に返信する。`LlmError` の `schema`・`config`・`content_filter`（安全フィルタは専用の文言）と、実装のバグ（`TypeError`・`ReferenceError`・`RangeError`・`SyntaxError`）が当たる。
- 最後の再試行（`X-CloudTasks-TaskRetryCount` が最大）で失敗したら、失敗したことを利用者に返信して `200` を返す（FR-054）。

## リマインドの対象（`/cron/reminders`、JST の平日 9:00）

- `status = open` で、`dueIso ≤ 次の営業日` の ToDo（期限切れ、今日、次の営業日。金曜には月曜の分も含む）。
- 期限のない ToDo は、月曜だけ対象にする。
- `lastRemindedOn = 今日` のものは除く（二重に送らない）。
- 宛先は `assigneeUserId ?? createdBy`。1 人に 1 通の DM にまとめ、各 ToDo に完了のボタンと、元のスレッドへのリンクを付ける。
