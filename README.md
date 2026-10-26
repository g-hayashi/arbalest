# Arbalest

> **English summary** — Arbalest is a Slack bot (with an experimental Microsoft Teams backend) that reads a thread or channel conversation and replies with a summary of **decisions, open questions, to-dos and findings**, each linked back to the source messages. Just mention `@arbalest` in a thread. It can register to-dos, keep a section of the channel canvas up to date, and send reminders for upcoming deadlines. It runs on Google Cloud Run + Cloud Tasks + Firestore and talks to any OpenAI-compatible LLM API (Azure OpenAI by default). The bot's UI and docs are in Japanese.

Slack の会話を読んで、**決定事項・未決定事項・ToDo・Findings（学び）** を、根拠の投稿へのリンク付きでまとめるボットです。スレッドで `@arbalest` とメンションするだけで動きます。

- **まとめる**: スレッドの概要、決定・未決定・ToDo・問いを返信する。取得件数と最初・最後の投稿時刻も示す
- **残す**: 条件を満たす ToDo を自動で登録し、チャネル canvas のそのスレッドの節を作成・更新する
- **思い出させる**: 期限が近い ToDo を平日 9 時にリマインドする。完了は一覧のボタンか ✅ のリアクションで付ける
- **振り返る**: 「先週の動きを振り返って」のような依頼で、期間内の会話からテーマごとの Findings を返す

Microsoft Teams 版も同じ分析の仕組みで動きます（標準チャネルのみ。[Teams 導入手順](docs/teams-setup.md)）。

## 使い方

| 依頼の例                                                             | 動作                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `@arbalest` / `@arbalest この会話をまとめて`                         | スレッドを分析して返信する。条件を満たす ToDo の登録と canvas の更新も行う |
| `@arbalest 見るだけ` / `@arbalest 登録しないでまとめて`              | 返信だけ。ToDo の登録と canvas の更新は行わない                            |
| チャネル直下で `@arbalest`                                           | 直近 7 日の会話を対象に返信する。ToDo の登録と canvas の更新は行わない     |
| `@arbalest 先週の動きを振り返って` / `@arbalest この2週間の学びは？` | 対象期間を明記して、テーマごとの Findings を返す                           |

従来のコマンドも使えます。

| コマンド                                     | 動作                                             |
| -------------------------------------------- | ------------------------------------------------ |
| `@arbalest まとめ`（`summary` / `要約`）     | 上の `@arbalest` と同じ処理                      |
| `@arbalest canvas`（`キャンバス`）           | スレッドのまとめをチャネル canvas の節に書き出す |
| `@arbalest todo`（`タスク`）                 | ToDo を登録して一覧を返す                        |
| `@arbalest findings 30日`（`振り返り 14日`） | 指定した日数の振り返り（既定 30 日、最大 90 日） |

<details>
<summary>動作の細かい決まり</summary>

- ToDo を自動で登録するのは、未完了で、担当者が参加者の中から特定でき、根拠を確かめられた ToDo だけです。担当が決まっていない ToDo や要確認の ToDo は、返信の中で確認を求めます。
- 返信には、登録した件数、要確認の項目、canvas の結果（作成・更新・対象なし・失敗）、依頼によって行わなかった操作を示します。
- 同じスレッドで再実行しても、既存の ToDo と canvas の節を更新するだけで、重複は作りません。完了の状態も保ちます。まとめが前回と変わらなければ、短い返信で済ませます。
- 意図や期間があいまいな依頼には、何も操作せずに確認を返します。
- 振り返りの期間は日本時間で数えます。`先週` は前週の月曜 0 時から今週の月曜 0 時まで、`今週` は今週の月曜 0 時から現在まで、`今月` は月初の 0 時から現在までです。期間を省略すると直近 30 日、上限は 90 日です。

</details>

## 仕組み

```
Slack ──イベント──▶ ingress (Cloud Run) ──▶ Cloud Tasks ──▶ worker (Cloud Run, 非公開)
                      3 秒以内に ack                            │  会話を取得 → AI で抽出・統合
                                                                │  → 根拠を検証 → 返信・canvas・ToDo
Cloud Scheduler ──────────────────────────────────────────────▶ │  /cron/reminders（リマインド）
                                                         Firestore（ToDo・状態）
```

- 同じコンテナイメージを、環境変数 `APP_ROLE`（`ingress` か `worker`）で 2 つのサービスに使い分けます。
- AI の呼び出しは `LlmProvider` を経由します。OpenAI 互換の API ならどれでも使えます（既定は Azure OpenAI）。会話をいくつかに分けて抽出し、それを統合する 2 段階で処理します。出力は根拠の投稿と照らし合わせ、根拠を確かめられない項目は採りません。詳しくは [AI での分析の方式](docs/ai-analysis-design.md) を参照してください。
- 設計の資料は `specs/` にあります（[Spec Kit](https://github.com/github/spec-kit) の形式）。

| ディレクトリ    | 中身                                                       |
| --------------- | ---------------------------------------------------------- |
| `src/ingress/`  | Slack のイベントを受けてジョブを積む                       |
| `src/worker/`   | ジョブの実行（まとめ、canvas、ToDo、Findings、リマインド） |
| `src/analysis/` | 会話の前処理、分割、抽出、統合、決定の判定                 |
| `src/llm/`      | `LlmProvider` と OpenAI 互換の実装、プロンプト             |
| `src/store/`    | Firestore とメモリのストア                                 |
| `src/teams/`    | Teams 版                                                   |
| `eval/`         | 合成の会話で AI の出力の質を測る評価                       |
| `specs/`        | 機能ごとの仕様、計画、タスク                               |

## 自分の環境で動かす

### 必要なもの

- Node.js 22.12 以上
- Google Cloud のプロジェクト（Cloud Run、Cloud Tasks、Cloud Scheduler、Firestore、Secret Manager）
- OpenAI 互換の LLM API（抽出用と統合用のモデル）
- Slack アプリ（ワークスペースにインストールする権限）

### 1. Slack アプリを作る

1. [api.slack.com/apps](https://api.slack.com/apps) でアプリを作り、Bot Token Scopes に次を付けます。コードが呼ぶ API から割り出したものです。
   - `app_mentions:read`, `chat:write`, `reactions:read`
   - `channels:history`, `channels:read`（プライベートチャネルでも使うなら `groups:history`, `groups:read`）
   - `canvases:read`, `canvases:write`
   - `users:read`, `im:write`（リマインドの DM）
2. Event Subscriptions を有効にして、Request URL に `https://<ingress のホスト>/slack/events` を設定します。購読するボットイベントは `app_mention` と `reaction_added` です。
3. Interactivity を有効にして、同じ URL を設定します（ToDo の完了ボタンに使います）。
4. ワークスペースにインストールし、Bot User OAuth Token（`xoxb-...`）と Signing Secret を控えます。

### 2. Google Cloud に載せる

1. Firestore（Native モード）、Cloud Tasks のキュー、worker を呼ぶためのサービスアカウントを用意します。
2. Slack のトークン、Signing Secret、LLM の API キーを Secret Manager に入れます。
3. イメージを build して push します（Cloud Run は amd64 です）。

   ```sh
   docker build --platform linux/amd64 -t <region>-docker.pkg.dev/<project>/<repo>/arbalest:latest .
   docker push <region>-docker.pkg.dev/<project>/<repo>/arbalest:latest
   ```

4. 同じイメージで 2 つの Cloud Run サービスをデプロイします。
   - `arbalest-ingress`: `APP_ROLE=ingress`。公開して Slack から呼べるようにします。
   - `arbalest-worker`: `APP_ROLE=worker`。非公開にして、Cloud Tasks のサービスアカウントだけに呼び出しを許します。
5. Cloud Scheduler で、平日の朝に worker の `/cron/reminders` を OIDC 付きで呼ぶジョブを作ります。

### 環境変数

| 名前                                            | 必須                  | 説明                                                     |
| ----------------------------------------------- | --------------------- | -------------------------------------------------------- |
| `APP_ROLE`                                      | ○                     | `ingress` か `worker`                                    |
| `WORKER_URL`                                    | ingress で○           | worker の URL（Cloud Tasks の送り先）                    |
| `GCP_PROJECT`                                   | ○                     | GCP のプロジェクト ID                                    |
| `TASKS_QUEUE` / `TASKS_LOCATION`                | ○                     | Cloud Tasks のキューと場所                               |
| `TASKS_INVOKER_SA`                              | ○                     | Cloud Tasks が worker を呼ぶときのサービスアカウント     |
| `TASKS_MAX_RETRY_COUNT`                         |                       | 再試行の上限（最後の試行で失敗したら、その旨を返信する） |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET`      | ○                     | Secret Manager から渡す                                  |
| `LLM_PROVIDER`                                  | ○                     | `openai-compatible` か `fake`                            |
| `LLM_BASE_URL` / `LLM_API_KEY`                  | openai-compatible で○ | 接続先と API キー（キーは Secret Manager から渡す）      |
| `LLM_MODEL_EXTRACT` / `LLM_MODEL_SYNTH`         | openai-compatible で○ | 抽出用と統合用のモデル名（デプロイ名）                   |
| `LLM_REASONING_EXTRACT` / `LLM_REASONING_SYNTH` |                       | 推論の強さ（対応するモデルだけ）                         |
| `FIRESTORE_DATABASE`                            |                       | 既定は `(default)`                                       |
| `PORT`                                          |                       | 待ち受けるポート。未設定なら 8080                        |

Teams 版の環境変数は [Teams 導入手順](docs/teams-setup.md) にあります。

## 開発

```sh
npm ci
npm run lint        # Biome
npm run typecheck
npm test            # vitest。Slack・AI・Firestore はフェイクかメモリの実装を使い、外部には接続しない
npm run build       # dist/ に出力
```

- `npm run test:firestore`: 実際の Firestore のテスト用データベースで、ストアの実装を確かめます。ADC と `FIRESTORE_TEST_DATABASE` が必要です（未設定なら飛ばします）。
- `npm run eval`: 合成の会話（`eval/cases/`）で実際の AI を呼び、抽出の精度などを測ります。LLM の環境変数が必要です。`LLM_PROVIDER=fake` なら接続しません。推定の AI 費用も測るときは、`EVAL_PRICING` に単価を JSON で渡します（[評価の契約](specs/001-slack-coordination-bot/contracts/eval.md#出力)）。

トークン、API キー、実際の会話のデータを、リポジトリ、ログ、テストデータ、評価データに書かないでください。評価には合成の会話だけを使います。

## ライセンス

[MIT](LICENSE)
