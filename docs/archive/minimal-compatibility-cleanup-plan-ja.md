## Plan: compatibilityProfile削除の最小改修

Status: proposed. 既存の Markdown は変更せず、この文書を新規追加して最小改修の方針を整理する。

## 背景

現状の実装は OpenAI Chat Completions API を前提としているが、設定には `llm.compatibilityProfile` が残っている。一方で、現在のコードでは `compatibilityProfile` による実際の分岐はほぼ存在せず、設定値として保持されているだけになっている。

また、`llm.reasoningEffort` と `llm.verbosity` は既定値として `medium` が入るため、設定ファイルで明示していなくても HTTP request に `reasoning_effort` と `verbosity` が送られる。この挙動は OpenAI 以外の OpenAI互換 API ではエラーの原因になりやすい。

そのため、まずは大きな再設計に進む前段として、不要な `compatibilityProfile` を削除し、`reasoningEffort` と `verbosity` を未指定時は送らない安全寄りの挙動へ戻す最小改修を行う。

## 目的

この最小改修の目的は次の 2 点である。

1. 実装で使われていない `llm.compatibilityProfile` を設定モデルから削除する。
2. `llm.reasoningEffort` と `llm.verbosity` を任意項目に戻し、未指定時は `null` として扱い、HTTP payload には含めないようにする。

## 対象範囲

今回の対象は最小限に絞る。

- `src/config.js` の runtime config 生成
- `src/openai/rest-client.js` の request body 生成
- `test/config.test.js` と `test/rest-client.test.js` の期待値更新
- `config/bots.json.example` などの設定例更新
- `README.md` の設定例と説明の更新

今回の対象外:

- capability resolver の導入
- Azure OpenAI など transport 境界の分離
- model family ごとの capability 制御
- 既存 Markdown の書き換え

## 変更方針

### 1. `compatibilityProfile` を削除する

`llm.compatibilityProfile` は runtime config から削除する。設定ローダーはこの項目を読まないようにし、生成される bot config にも含めない。

この変更は、現状のコードで `compatibilityProfile` が実質未使用であることを前提にした整理である。今回の段階では、代替として新しい capability 設定は導入しない。

### 2. `reasoningEffort` と `verbosity` の既定値を廃止する

`llm.reasoningEffort` と `llm.verbosity` は、未指定時の既定値を `medium` から `null` に変更する。

期待する runtime config 上の扱い:

- 明示指定あり: 文字列値を保持する
- 未指定: `null`

### 3. `null` のときは payload に含めない

`src/openai/rest-client.js` では request body を条件付きで組み立てる。

必須項目:

- `model`
- `messages`
- `stream`

任意項目:

- `reasoning_effort`
- `verbosity`

任意項目は、対応する runtime config 値が `null` または `undefined` の場合はキー自体を送信しない。

## 実施ステップ

### Phase 1 — 設定モデルの簡素化

1. `src/config.js` から `llm.compatibilityProfile` の正規化処理を削除する。
2. 同ファイルの runtime config 出力から `compatibilityProfile` を削除する。
3. `llm.reasoningEffort` と `llm.verbosity` の既定値 `medium` を廃止する。
4. 未指定時は `null` が入るようにする。

### Phase 2 — request payload の条件付き生成

1. `src/openai/rest-client.js` の request body 組み立てを変更する。
2. `reasoning_effort` は値があるときだけ追加する。
3. `verbosity` は値があるときだけ追加する。
4. request summary log も実際の request body と整合させる。

### Phase 3 — テスト更新

1. `test/config.test.js` の期待値から `compatibilityProfile` を削除する。
2. 未指定時の `reasoningEffort` と `verbosity` が `null` であることを確認する。
3. 明示指定時は従来通り文字列値が保持されることを確認する。
4. `test/rest-client.test.js` で、未指定時に `reasoning_effort` と `verbosity` が request body に含まれないことを確認する。
5. 明示指定時にのみそれらが request body に含まれることを確認する。

### Phase 4 — 設定例と説明の整合

1. `config/bots.json.example` から `compatibilityProfile` を削除する。
2. `reasoningEffort` と `verbosity` はデフォルト例から外す。
3. `README.md` では、これらが任意項目であり、未指定時は送信されないことを明記する。

## 影響範囲

主な影響先は次の通り。

- `src/config.js`
- `src/openai/rest-client.js`
- `test/config.test.js`
- `test/rest-client.test.js`
- `config/bots.json.example`
- `config/bots.json`
- `README.md`

`config/bots.json` がローカル実運用に使われている場合は、変更前に用途確認が必要である。

## 検証項目

実装後は次を確認する。

1. runtime config に `compatibilityProfile` が存在しないこと。
2. `reasoningEffort` と `verbosity` が未指定時 `null` になること。
3. request body に `reasoning_effort` と `verbosity` が未指定時は含まれないこと。
4. 明示指定時のみ `reasoning_effort` と `verbosity` が送信されること。
5. `npm test` が通ること。
6. `README.md` と設定例に `compatibilityProfile` が残っていないこと。

## 判断事項

- この段階では capability ベース設計への全面移行は行わない。
- まずは不要項目の削除と unsafe default の解消だけを行う。
- GPT-5 向けの推奨値を残したい場合でも、既定値にはせず、必要時の明示設定として扱う。

## 補足

この文書は最小改修の実施計画であり、中長期の OpenAI互換 API 再設計案とは切り分けて扱う。より大きな設計変更は別途 capability ベース設計の文書で扱う。