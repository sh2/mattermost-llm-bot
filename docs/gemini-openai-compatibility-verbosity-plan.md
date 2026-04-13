## Plan: Gemini OpenAI-compatible payload handling

Status: planned. As of 2026-04-13, `gemini-openai` compatibility is not implemented in the request payload path yet.

対象は Gemini provider 対応そのものではなく、Gemini の OpenAI互換 API エンドポイントに対する互換性差分である。現状は `llm.compatibilityProfile` の設定値だけがあり、`src/openai/rest-client.js` は profile 分岐を持たず `verbosity` を常に送っているため、`gemini-openai` 用の差分吸収は未実装である。将来本来の Gemini API に対応することを見据え、`llm.provider === 'gemini'` をこの用途には使わない。

`llm.provider` は native client の切り替えに使う識別子として維持し、このケースは `llm.provider === 'openai'` のまま、OpenAI互換 API 上の差分を表す別フィールドで扱う。`llm.compatibilityProfile` は既に config に存在するが、現時点では送信側の分岐に未接続で、既定値は `openai`、Gemini の OpenAI互換 API 向け値は `gemini-openai` とする想定である。

**Steps**
1. `src/config.js` にある `compatibilityProfile` 設定の現状を維持する。`llm.provider` は `openai` のままにし、既定値は `openai` にする。
2. `src/index.js` から `OpenAIRestClient` へ `compatibilityProfile` を渡せるようにする。
3. `src/openai/rest-client.js` で request body を条件付き生成に変える。`compatibilityProfile === 'gemini-openai'` の場合は `verbosity` を省略し、それ以外では従来通り送る。
4. `test/rest-client.test.js` に、標準 OpenAI profile では `verbosity` が含まれること、Gemini OpenAI互換 profile では含まれないことを確認するテストを追加する。`reasoning_effort` は今回も維持する。
5. 必要なら `docs/archive/multi-bot-design.md` を参照し、`llm.provider` と OpenAI互換 profile の役割分担を確認する。

**Relevant files**
- `src/config.js` - `compatibilityProfile` を含む runtime config の解決。
- `src/index.js` - config を `OpenAIRestClient` へ配線。
- `src/openai/rest-client.js` - request JSON の条件付き組み立て。
- `test/rest-client.test.js` - payload 送信の回帰テスト。
- `docs/archive/multi-bot-design.md` - 完了済みの複数 bot 設計。履歴参照用。

**Verification**
1. `test/rest-client.test.js` に Gemini OpenAI互換 profile の payload 期待値を追加し、`verbosity` が欠落していることを確認する。
2. `npm test` を実行して、既存の OpenAI 経路と他テストに影響がないことを確認する。
3. 必要なら設定テストを追加し、`compatibilityProfile` の既定値と明示値の解決を確認する。

**Decisions**
- `llm.provider` は native API ごとの client 境界を表す値として使う。
- Gemini の OpenAI互換 API は `provider` ではなく OpenAI互換 profile で表現する。
- 送信抑止対象は `verbosity` のみ。`reasoning_effort` は現時点では送る。
- 既存の OpenAI 経路の payload は維持する。