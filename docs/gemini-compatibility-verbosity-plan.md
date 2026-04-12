## Plan: Gemini compatibility payload handling

GeminiのOpenAI API互換エンドポイントでは `verbosity` が存在するだけでエラーになるため、OpenAI互換クライアントのリクエスト組み立てを provider-aware にする。今回の方針は、`llm.provider` を明示設定として持たせ、Gemini 互換時は `verbosity` だけを送らない。既存の OpenAI 経路は変えない。

**Steps**
1. `src/config.js` に provider 設定を加える。既存の設定構造に `provider` を追加し、デフォルトは `openai` にする。*depends on user decision*
2. `src/index.js` から `OpenAIRestClient` へ provider を渡せるようにする。既存の呼び出し方は維持しつつ、設定の接続だけ広げる。
3. `src/openai/rest-client.js` で request body を条件付き生成に変える。`provider === 'gemini'` の場合は `verbosity` を省略し、それ以外では従来通り送る。
4. `test/rest-client.test.js` に、OpenAI 経路では `verbosity` が含まれること、Gemini 経路では含まれないことを確認するテストを追加する。`reasoning_effort` は今回は維持する。
5. 必要なら `docs/multi-bot-design.md` に、Gemini 互換時の送信ルールを簡潔に追記する。

**Relevant files**
- `/home/taira/nfs/git/mattermost-llm-bot/src/config.js` — provider を含む runtime config の解決。
- `/home/taira/nfs/git/mattermost-llm-bot/src/index.js` — config を OpenAI クライアントへ配線。
- `/home/taira/nfs/git/mattermost-llm-bot/src/openai/rest-client.js` — request JSON の条件付き組み立て。
- `/home/taira/nfs/git/mattermost-llm-bot/test/rest-client.test.js` — payload 送信の回帰テスト。
- `/home/taira/nfs/git/mattermost-llm-bot/docs/multi-bot-design.md` — 将来の provider 方針との整合。

**Verification**
1. `test/rest-client.test.js` に Gemini 経路の payload 期待値を追加し、`verbosity` が欠落していることを確認する。
2. `npm test` を実行して、既存の OpenAI 経路と他テストに影響がないことを確認する。
3. 必要なら設定テストを追加し、`provider` のデフォルトと明示値の解決を確認する。

**Decisions**
- 判定方法は明示的な `provider` 設定を採用する。
- 送信抑止対象は `verbosity` のみ。`reasoning_effort` は現時点では送る。
- 既存の OpenAI 経路の payload は維持する.