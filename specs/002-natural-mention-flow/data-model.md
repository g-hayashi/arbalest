# Data Model: 自然文で呼べる Arbalest

## D1. 依頼

`requesterUserId`、`channelId`、`threadTs`、`mentionTs`、`requestedAt`、`intent`（summary/findings/clarify）、`suppressTodo`、`suppressCanvas`、`period`。依頼本文は worker への一時的なジョブ本文にだけ含め、Firestore やログには保存しない。期間は JST の暦境界から UTC 時刻に変換して扱う。空メンションと `まとめ` も同じ一括処理へ進む。

## D2. 根拠付き概要

最大3項目。各項目は短い文、根拠の投稿 ID と短い引用、`needsReview`。根拠の実在と引用の一致を検証する。検証できないものは要確認とする。対象が0件なら概要も0件。

## D3. 実行結果

ToDo の `registered` / `skipped` / `failed`、canvas の `created` / `updated` / `skipped` / `failed`。既存の `targetId`、`todoId`、`canvasSectionMarker` を再利用する。同一依頼の再試行状態は既存 `processed_events/{taskName}` に `targetId`、完了した段階、投稿済み返信の `ts`、`updatedAt` を保存し、既存の7日 TTL に従う。ToDo と canvas の実体は各既存コレクションに保存する。再試行時は最初に段階と実体を照合し、二重登録・二重リマインドをしない。別の `taskName` は状態を共有しない。

## V1. 自動登録

`closed=false`、担当者のユーザー ID が参加者に存在、`needsReview=false`、根拠が1件以上で検証済み、利用者による抑止がない、かつスレッド内である場合だけ登録する。

## V2. canvas 更新

スレッド内で、決定・未決定・V1 の ToDo のいずれかがある場合、または同じスレッドの管理節が既にある場合だけ更新する。利用者による抑止があれば実行しない。人が書いた部分は変更しない。

## V3. 範囲表示

取得件数、最初と最後の投稿時刻、指定した対象期間、Slack の履歴制限を区別する。件数0なら時刻は表示せず「投稿0件」とする。
