# Data Model

## D1 — TeamsJobPayload

platform=teams、taskName、tenantId、teamId、channelId、conversationId、rootMessageId、mentionId、userId、serviceUrl、requestText、requestedAt。
taskNameはtenant/team/channel/root/activity IDのSHA256。payloadはCloud Tasksに一時保存。本文はログ/Firestoreへ保存しない。

## D2 — NormalizedConversation

messages（既存の分析型）、names、links（分析ID→検証済みTeams URL）、sourceIds（分析ID→元ID）。
分析IDはcreatedDateTimeを秒6桁小数へ変換。ミリ秒単位内の衝突は残り3桁で決定的に分離。1000件以上の同一msは失敗。
内部での投稿識別はroot/親か返信か/idの組とする。タスク名もrootを含め、別スレッドの同IDを混同しない。

## D3 — Namespaces

targetId/channelId/lockId は `teams_` とtenant/team/channel/rootのSHA256を使う。Slack の `t_`/`c_`/`f_` と衝突させない。
既存 TargetDoc と TTL を利用する。ToDoRepo と CanvasesRepo には Teams データを書かない。

## V1 — Trust

SDK JWT検証後もtenant・team allowlist・channelData・メンション・サービスURL・conversationIdとchannelIdの関係を検証。
Graph nextLinkは同一originかつ元のコレクションパスに限る。リダイレクト禁止。上限・循環は失敗し、不完全な分析を返さない。

## V2 — Evidence

共通の引用・ID検証を利用し、リンクは同じ取得メッセージのものだけを使う。AIのURL・返信先は使わない。

## D4 — Retry snapshot

処理進捗に任意の `replyChunks: string[]` を追加し、最初の投稿より先に完成した返信を保存する。
これはコードで整形した分析結果であり、元会話や依頼の本文ではない。既存の進捗と同じ7日TTL。
UTF-8 JSON全体で256KiB以下、1chunk 8000 UTF-16単位以下。上限超過は投稿前に失敗する。
再試行では履歴/LLMを再実行せず保存したsnapshotの未送信slotだけを投稿する。
