# 複数ボット単一プロセス構成 詳細設計

## 目的

1つの Node.js プロセスで複数の Mattermost bot を動作させる。

機微情報は環境変数に置き、非機微設定は1つの JSON ファイルに集約する。

## 非目的

- 複数 bot token で 1 本の Mattermost WebSocket を共有すること
- 初期実装で hot reload を導入すること
- このリポジトリの用途を超える汎用設定基盤を作ること
- 複数ボット分離のために必要な場合を除き、既存の応答仕様を変えること

## 現状の制約

- 現在のランタイムは 1 プロセス 1 bot を前提としている。
- 現在の設定はすべて環境変数で与える構成になっている。
- `ChatBot` は単一 token で Mattermost に接続し、自身の bot identity を取得している。
- エントリポイントは `MattermostService`、`OpenAIRestClient`、`ChatBot` をそれぞれ 1 つずつ生成している。
- 送信者抑止ルールは `ai-` prefix に固定されている。

## 目標アーキテクチャ

ランタイムは次の 4 層に分割する。

1. 設定ロード層
2. 起動オーケストレーション層
3. bot 実行層
4. 共有ユーティリティ層

### 設定ロード層

設定は 2 つのソースから読み込む。

- 環境変数
  - 機微情報とプロセス全体の運用オーバーライドのみを保持する
  - 例: Mattermost bot token、LLM API key、設定ファイルパス
- JSON ファイル
  - 非機微な bot 定義と共通デフォルトを保持する
  - 例: bot 名、Mattermost base URL、LLM provider、モデル名

### 起動オーケストレーション層

エントリポイントは全設定を読み込み、bot ごとに実行バンドルを作成し、全バンドルを起動し、協調 shutdown を管理する。

各実行バンドルは次を持つ。

- bot 設定
- `MattermostService` インスタンス
- LLM REST client インスタンス
- `ChatBot` インスタンス

### bot 実行層

すべての bot は同一プロセス上で動作するが、メモリ上の状態は bot ごとに分離する。

分離境界は次の通り。

- Mattermost REST client を分離する
- Mattermost WebSocket を分離する
- LLM client 設定を分離する
- 処理中 post の追跡状態を分離する
- bot identity と mention 判定を分離する

### 共有ユーティリティ層

以下は共有コードとして維持するが、共有 mutable state は持たない。

- URL 正規化
- boolean 変換
- LLM response 解析
- Mattermost event 解析

## 設定モデル

### 環境変数

プロセス単位の変数:

- `BOT_CONFIG_PATH`
  - 任意
  - 既定値: `./config/bots.json`

bot 単位の必須機微情報:

- `BOT_<BOT_NAME>_TOKEN`
- `BOT_<BOT_NAME>_LLM_API_KEY`

`<BOT_NAME>` は `bots[].name` を正規化して作る。

- 英大文字に変換する
- 英数字以外は `_` に置換する

例:

- bot 名: `support-ja`
- token 用環境変数: `BOT_SUPPORT_JA_TOKEN`
- API key 用環境変数: `BOT_SUPPORT_JA_LLM_API_KEY`

### JSON ファイル形式

```json
{
  "defaults": {
    "mattermost": {
      "url": "http://localhost:8065"
    },
    "llm": {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "stream": true,
      "reasoningEffort": "medium",
      "verbosity": "medium"
    }
  },
  "bots": [
    {
      "name": "support-ja",
      "llm": {
        "model": "gpt-5.1-mini"
      }
    },
    {
      "name": "review-en",
      "mattermost": {
        "url": "https://mattermost.example.com"
      },
      "llm": {
        "provider": "openai",
        "model": "gpt-5.1"
      }
    }
  ]
}
```

### 設定項目の意味

- `defaults`
  - 任意
  - 各 bot 定義へバリデーション前にマージする
- `bots`
  - 必須
  - 空でない配列
- `bots[].name`
  - 必須
  - ファイル内で一意
- `mattermost.url`
  - defaults マージ後に必須
  - 非機微情報
- `llm.provider`
  - 任意
  - 既定値: `openai`
  - 初回実装では `openai` のみ許容する
  - native client の切り替えに使う値として保持する
  - 将来 `gemini`、`anthropic` などを追加できる値として予約する
- `llm.compatibilityProfile`
  - 任意
  - 既定値: `openai`
  - `llm.provider=openai` のときの OpenAI互換 API 差分を表す
  - 例: `openai`、`gemini-openai`
- `llm.model`
  - defaults マージ後に必須
  - 非機微情報
- `llm.baseUrl`
  - 任意
  - 既定値: `https://api.openai.com/v1`
  - `provider=openai` の場合は `/chat/completions` を含んではならない
  - 将来ほかの provider を追加する際も、エンドポイント全体ではなく provider ごとの基底 URL を置く項目として使う
- `llm.stream`
  - 任意
  - 既定値: `true`
- `llm.reasoningEffort`
  - 任意
  - 既定値: `medium`
- `llm.verbosity`
  - 任意
  - 既定値: `medium`

送信者抑止ルールは設定項目にせず、`ai-` 固定とする。

## ランタイムデータモデル

### プロセス設定

設定ローダーは次の形の不変オブジェクトを返す。

```js
{
  configPath: "/abs/path/config/bots.json",
  bots: [
    {
      name: "support-ja",
      mattermost: {
        url: "http://localhost:8065",
        token: "...secret...",
        typingIntervalMs: 1000
      },
      llm: {
        provider: "openai",
        compatibilityProfile: "openai",
        apiKey: "...secret...",
        model: "gpt-5.1-mini",
        stream: true,
        apiUrl: "https://api.openai.com/v1/chat/completions",
        reasoningEffort: "medium",
        verbosity: "medium",
        streamUpdateIntervalMs: 1000
      }
    }
  ]
}
```

`llm.provider` は初回実装では `openai` 固定だが、設定データ上は将来の native Gemini API や Anthropic API 追加を見越して保持する。

`llm.compatibilityProfile` は OpenAI互換 API 上の差分を表す。たとえば Gemini の OpenAI互換 API を叩く場合は `llm.provider=openai` のまま `llm.compatibilityProfile=gemini-openai` とし、将来の native Gemini API 対応とは区別する。

`llm.apiUrl` は実行時に provider ごとの規則で組み立てた最終リクエスト先 URL を表す。初回実装では OpenAI 用の `/chat/completions` URL のみを扱う。

### 実行バンドル

各 bot インスタンスは次の実行バンドルとして表現する。

```js
{
  name,
  config,
  mattermost,
  llm,
  bot
}
```

このバンドルはエントリポイント内部の管理用であり、他のバンドルと共有しない。

## 起動シーケンス

### 通常起動

1. `src/index.js` が `loadConfig()` を呼ぶ。
2. 設定ローダーが JSON ファイルを読み、環境変数の機微情報をマージする。
3. バリデーションを完了してからネットワーク接続を開始する。
4. エントリポイントが bot ごとに実行バンドルを作る。
5. エントリポイントが全 bot を起動する。
6. 全 bot の起動成功後、起動済み bot 一覧をログ出力する。
7. シグナルハンドラーが協調 shutdown を管理する。

### 起動失敗時の方針

初期実装は fail-fast とする。

- 設定ロードに失敗した場合、プロセス起動を失敗させる
- いずれかの bot が起動失敗した場合、先に起動済みの bot をすべて停止する
- プロセスは非 0 で終了する

理由:

- 部分起動は運用上の状態が曖昧になる
- fail-fast の方がデプロイ失敗に気づきやすい
- 初期実装の復旧ロジックを単純に保てる

## 停止シーケンス

1. `SIGINT` または `SIGTERM` を受信する。
2. エントリポイントが全 bot インスタンスの停止を開始する。
3. 各 bot が WebSocket post listener を解除する。
4. 各 Mattermost client が WebSocket を閉じる。
5. signal 経由の shutdown では終了コード `0` で終了する。

shutdown は best-effort とする。

- 1 bot の停止に失敗してもエラーを記録する
- 残りの bot に対する停止は継続する

## bot ルーティング規則

### mention 判定

各 `ChatBot` インスタンスは自分自身の username に対してのみ応答する。

- mention 判定には Mattermost 接続後に取得した bot username を使う
- メッセージ整形ではその bot への mention のみを除去する
- スレッドから LLM 向けメッセージを組み立てる際、その bot 自身の post のみを assistant メッセージとして扱う

### 送信者抑止

送信者抑止ルールは `ai-` 固定のままとする。

各 bot に対して次を適用する。

- `senderName` が `ai-` で始まる場合は無視する

これにより現在の挙動を維持しつつ、不必要な設定項目の追加を避ける。

### 重複処理防止

各 bot は独自の `processingPostIds` set を持つ。

これにより、bot 間で結合せずに bot 単位の重複処理を防ぐ。

## ファイル単位の責務

### `src/config.js`

責務:

- `.env` を読み込む
- JSON 設定ファイルを読み込んで解析する
- defaults と bot 個別設定をマージする
- bot 単位の環境変数を解決する
- URL と boolean を正規化する
- 設定の構造と必須項目を検証する
- 不変なプロセス設定を返す

やらないこと:

- ネットワークアクセス
- service client の生成

### `src/index.js`

責務:

- プロセス設定を読み込む
- 実行バンドルを生成する
- 全 bot を起動する
- 全 bot を停止する
- プロセスのライフサイクルとログ出力を管理する

やらないこと:

- 個別設定項目の解析処理
- bot の応答ロジック

### `src/bots/chat-bot.js`

責務:

- 1 bot identity を 1 本の Mattermost event stream に結びつける
- この bot が応答すべき post かどうかを判定する
- 1 thread 分の LLM メッセージ列を構築する
- streaming / non-streaming の返信を送る

やらないこと:

- 他 bot インスタンスの認識
- process env の直接参照

### `src/mattermost/client.js`

責務:

- 1 つの Mattermost REST client と WebSocket connection を所有する
- posted event を解析する
- thread、channel、reply 操作のヘルパーを提供する

やらないこと:

- bot 固有の routing policy 実装

### `src/openai/rest-client.js`

責務:

- 1 つの OpenAI client 設定を所有する
- completion request を送る
- streaming / non-streaming response を解析する

やらないこと:

- Mattermost の詳細を知ること
- bot 名や routing policy を知ること

将来的に Gemini API や Anthropic API に対応する場合は、同等の責務を持つ provider 別 client を追加し、呼び出し側は `llm.provider` に応じて切り替える。Gemini の OpenAI互換 API はこの文脈では `openai` client の互換 profile として扱う。

## バリデーション方針

バリデーションは起動前に完了させ、原因が追いやすいエラーを返す。

例:

- `bots` array がない
- `bots` array が空
- bot 名が重複している
- defaults マージ後でも `mattermost.url` がない
- defaults マージ後でも `llm.model` がない
- `BOT_<BOT_NAME>_TOKEN` がない
- `BOT_<BOT_NAME>_LLM_API_KEY` がない
- URL が HTTP/HTTPS ではない
- `llm.provider` が初回実装で未対応の値になっている
- `llm.baseUrl` に `provider=openai` なのに `/chat/completions` が含まれている

エラーメッセージには可能な限り bot 名または配列 index を含める。

## ロギング設計

bot 固有のログには bot 名を含める。
