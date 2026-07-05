# 画像添付対応の実装計画

## 概要

Mattermost の投稿に画像が添付された場合、その画像を LLM API（OpenAI Chat Completions 互換）に渡して処理させる。本計画は、既存のスレッド→OpenAI メッセージ構築フローを拡張し、画像をマルチモーダル入力として LLM に送るための設計と実装手順を定める。

## 背景・現状

- `src/bots/chat-bot.js` の `buildOpenAIRequestMessages` はスレッド内の全ポストを時系列順に OpenAI メッセージ列へ変換する。各メッセージの `content` は文字列のみ。
- `src/mattermost/client.js`（`MattermostService`）は `@mattermost/client` の `Client4` をラップし、スレッド取得・チャンネル取得・投稿作成・更新などを提供する。
- `src/openai/rest-client.js`（`OpenAIRestClient`）は Chat Completions API を呼び出す。ログサマリーは `normalizeContent` で文字列/配列両対応済みだが、画像パーツの存在はログに現れない。
- Mattermost の `Post` 型は `file_ids?: string[]` を持つ。`@mattermost/client` は `getFileInfosForPost(postId)`・`getFileUrl(fileId, timestamp)` などを提供する。
- 依存ライブラリは `@mattermost/client`・`dotenv`・`ws` のみで、画像処理ライブラリは未導入。

## 設計判断

以下、質疑応答で合意した判断を整理する。

| # | 判断項目 | 決定 |
| --- | --- | --- |
| 1 | 対象添付ファイル | `mime_type` が `image/*` のみ画像として渡す。非画像添付（PDF/Word 等）は無視し、テキスト注記も残さない。 |
| 2 | LLM への画像の渡し方 | Mattermost から画像 bytes をダウンロードし、base64 データ URL（`data:image/jpeg;base64,...`（#18 参照））として `image_url.url` に埋め込む。公開リンク機能には依存しない。 |
| 3 | 画像取得範囲 | スレッド内の全ポストの画像を、そのポストに対応するメッセージの `content` 配列に配置する。テキストの扱いと一貫させる。 |
| 4 | 実装配置 | `MattermostService` に `getFileInfosForPost(postId)` と `getFileContent(fileId)` を追加。`ChatBot.processPost` で事前取得し、`buildOpenAIRequestMessages` は画像データを引数で受け取る純粋関数のまま維持する。 |
| 5 | `content` の形式 | 画像がないポストは従来通り文字列。画像があるポストだけパーツ配列にする。既存テストはそのまま通る。 |
| 6 | 画像サイズ制限 | 長辺の最大サイズを 1536px とし、超える画像はリサイズして送信する。 |
| 7 | リサイズライブラリ | `sharp` を新規依存に追加する。 |
| 8 | 設定の外部化 | `llm.images.maxLongEdge`（デフォルト 1536）のみボット設定に追加する。画像機能の ON/OFF フラグは設けず常に有効。 |
| 9 | メッセージ内の画像の並び順 | テキストパーツを先頭に置き、その後に `file_ids` の順序で画像パーツを並べる。OpenAI 公式例と同じ順序。 |
| 10 | 画像取得失敗時の処理 | その画像だけスキップし警告ログを出し、テキストと残りの画像で LLM 呼び出しを続行する。 |
| 11 | アニメーション画像の扱い | アニメーション GIF/WebP は先頭フレームのみ抽出して静止画として送る（sharp のデフォルト `animated: false`）。 |
| 12 | FileInfo の取得方法 | `file_ids` が空でないポストに対してのみ `getFileInfosForPost(postId)` を呼ぶ。 |
| 13 | OpenAI `detail` パラメータ | 省略し `auto` に委ねる。クロスプロバイダ対応を見据えた最小で安全な選択。 |
| 14 | `OpenAIRestClient` ログ拡張 | `summarizeMessageForLog` にメッセージ単位の `image_part_count` を、`summarizeMessagesForLog` にリクエスト全体の `image_part_count` を追加し画像パーツ数を記録する。base64 本体は絶対に出さない。 |
| 15 | オーケストレーション配置 | 画像収集は `chat-bot.js` 内のヘルパー `collectThreadImages`。リサイズ純粋関数は `src/images/resizer.js`。 |
| 16 | DI とテスト方針 | `resizeImageToMaxLongEdge(bytes, maxLongEdge, sharpImpl = sharp)` は `{ bytes, mimeType }` を返し、`ChatBot` コンストラクタに `resizer` 选项（既定は実物）、`MattermostService` コンストラクタに `fetchImpl = globalThis.fetch` を追加。既存の `fetchImpl`/`mattermost`/`llm` の DI パターンと一貫。 |
| 17 | 計画ドキュメントの保存先 | `docs/image-attachment-support-plan-ja.md`（本ファイル）。`config/bots.json.example` は触らない。 |
| 18 | リサイズ後の出力フォーマット | JPEG（品質80）に統一する。入力形式（SVG/GIF/WebP 等）に関わらず出力は JPEG bytes となり、data URL の MIME も常に `image/jpeg` とする。透過画像は白背景（`#ffffff`）でフラット化（`.flatten()`）してから JPEG 化する。出力形式の決定は `resizer` の責務とし、`{ bytes, mimeType }` を返す。 |

> **注意**: 設計判断 #2 は初版「`data:image/png;base64,...`」としていたが、出力フォーマットを JPEG に統一したことに伴い `data:image/jpeg;base64,...` が正しい形式となる。

### リサイズ上限 1536px の根拠

主要 3 プロバイダの自然な上限に収まる最小公倍数的な値。

- OpenAI Vision: `high` 詳細で長辺 2048px 上限・6000px（`original`/`auto`）。1536px は `high` の上限に余裕を持って収まるため OpenAI 側での追リサイズを回避できる。
- Gemini: 1536px が上限。本値がそのまま受け入れられる。
- Anthropic Claude: 長辺 1568px を推奨。1536px はこれより小さいため自動縮小されない。

## 実装詳細

### 1. 依存関係の追加

`package.json` の `dependencies` に `sharp` を追加する。

```json
{
  "dependencies": {
    "@mattermost/client": "^11.8.0",
    "dotenv": "^17.4.2",
    "sharp": "^0.33.5",
    "ws": "^8.21.0"
  }
}
```

`npm install` で prebuilt バイナリが導入される。ネイティブバイナリを含むため、CI/デプロイ環境でプラットフォーム別バイナリが解決されることを想定する。

### 2. 新規モジュール `src/images/resizer.js`

リサイズを行う純粋関数。`sharpImpl` を既定引数で注入可能にし、テストではスタブを渡せるようにする。

```js
import sharp from 'sharp';

export const DEFAULT_MAX_LONG_EDGE = 1536;
export const OUTPUT_MIME_TYPE = 'image/jpeg';
export const OUTPUT_QUALITY = 80;
export const OUTPUT_BACKGROUND = '#ffffff';

export async function resizeImageToMaxLongEdge(
  bytes,
  maxLongEdge = DEFAULT_MAX_LONG_EDGE,
  sharpImpl = sharp,
) {
  const buffer = await sharpImpl(bytes)
    .resize({
      width: maxLongEdge,
      height: maxLongEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: OUTPUT_BACKGROUND })
    .jpeg({ quality: OUTPUT_QUALITY })
    .toBuffer();

  return { bytes: buffer, mimeType: OUTPUT_MIME_TYPE };
}
```

- `fit: 'inside'` でアスペクト比を保って長辺が `maxLongEdge` に収まるように縮小する。
- `withoutEnlargement: true` で小さい画像を拡大しない。
- sharp のデフォルト（`animated: false`）でアニメーション GIF/WebP は先頭フレームのみ出力される。
- **出力フォーマットは JPEG（品質80）に統一する**。`.jpeg({ quality: 80 })` を明示的に呼ぶことで、入力が `image/svg+xml`（ベクタ→ラスタライズされる）・`image/gif`（先頭フレームのみ）・`image/webp` 等何であっても出力は JPEG bytes になる。
- **透明画像の背景処理として `.flatten({ background: OUTPUT_BACKGROUND })` を挟む**。透過 PNG / GIF / WebP / SVG を JPEG に変換する際、アルファチャネルは JPEG に存在しないため白背景でフラット化する。これを指定しないと透明領域が黒く潰れ、UI スクリーンショットや図の可読性が落ちる。
- MIME タイプ・品質・背景色は定数 `OUTPUT_MIME_TYPE`/`OUTPUT_QUALITY`/`OUTPUT_BACKGROUND` として export し、将来の形式変更はこれらの定数だけで済む。
- **戻り値を `Uint8Array` ではなく `{ bytes, mimeType }` オブジェクトにする**。これにより「出力形式の決定」も `resizer` の責務に集約され、`collectThreadImages` 側は `resizer` が返した `mimeType` をそのまま data URL に使えばよくなる。将来 `resizer` を差し替えて別形式（PNG 等）を返す場合でも、bytes と MIME が常に一致する。
- 【修正メモ 1】初版では「`.resize()` 単独なら出力フォーマットは入力を維持するので元の `mime_type` を使う」としていた。しかし `image/svg+xml` は sharp が PNG にラスタライズするなど形式によって崩れるため、出力を JPEG に固定し MIME も `image/jpeg` に統一した。
- 【修正メモ 2】初版では `resizer` は `Uint8Array` を返し、MIME 決定は `collectThreadImages` 側で `OUTPUT_MIME_TYPE` を import して行っていた。これだと `resizer` を差し替えたときに bytes と MIME が食い違うため、`resizer` の戻り値を `{ bytes, mimeType }` に変更し、出力形式の責務を `resizer` に閉じ込めた。
- 【修正メモ 3】初版では `.flatten()` を挟んでいなかった。透過画像を JPEG 化する際に透明領域が黒く潰れる問題があるため、`.flatten({ background: '#ffffff' })` で白背景にフラット化するようにした。

### 3. `src/mattermost/client.js` の拡張

`MattermostService` に以下を追加する。

#### 3.1 コンストラクタに `fetchImpl` の DI シームを追加

```js
constructor(config, logger = console, fetchImpl = globalThis.fetch) {
  // 既存フィールド ...
  this.fetchImpl = fetchImpl;
}
```

`OpenAIRestClient` と同じ DI パターン。テストでは `new MattermostService(config, logger, fakeFetch)` でスタブを渡せる。

#### 3.2 `getFileInfosForPost(postId)` の追加

```js
async getFileInfosForPost(postId) {
  this.ensureClient();
  return this.client.getFileInfosForPost(postId);
}
```

#### 3.3 `getFileContent(fileId)` の追加

```js
async getFileContent(fileId) {
  this.ensureClient();
  const fileUrl = this.client.getFileUrl(fileId, Date.now());
  const response = await this.fetchImpl(fileUrl, {
    headers: { authorization: `Bearer ${this.token}` },
  });

  if (!response.ok) {
    throw new Error(
      `Mattermost file download failed with status ${response.status}: ${fileId}`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}
```

- `Client4.getFileUrl` は `getBaseRoute()`（`${this.url}${this.urlVersion}`）を前置した**絶対 URL**（`http://host/api/v4/files/{file_id}?{timestamp}`）を返すため、`this.url` を再前置しない。`this.client` は `connect()` で `setUrl(this.url)` 済みなので URL 構築を Client4 に委ねる。
- `Authorization: Bearer ${this.token}` ヘッダーでボットトークン認証を行う。`Client4` は独自 fetch を差し替える口を持たないため、`fetchImpl` で直接認証ヘッダーを付与する。
- 戻り値は `Uint8Array`。`sharp` は `Uint8Array`/`Buffer` を入力として受け付ける。
- 【修正メモ】初版では `getFileUrl` を相対パスと誤認し `${this.url}${relativeUrl}` で再前置していた。`Client4.getBaseRoute()` が `${this.url}${this.urlVersion}` を返す（`client4.js:103-105`）ため再前置するとホスト名が二重になりダウンロード不能になる。

### 4. `src/config.js` の拡張

`llm.images.maxLongEdge` をパースする。

#### 4.1 `buildRuntimeBotConfig` の `llm` ブロックに `images` を追加

```js
llm: {
  // 既存フィールド ...
  images: {
    maxLongEdge: normalizeMaxLongEdge(
      getOptionalObject(mergedBot.llm.images, `${botLabel} llm.images`).maxLongEdge,
      `${botLabel} llm.images.maxLongEdge`,
    ),
  },
},
```

- 既存の `getOptionalObject`（`config.js:150-160`）を `images` にも適用する。`undefined` は `{}` に正規化され、`true`・`[]`・`"foo"` 等の非オブジェクトは `${botLabel} llm.images must be an object.` で弾かれる。これにより `.maxLongEdge` は常に `undefined | number` に絞られ、`normalizeMaxLongEdge` は値の範囲だけ検証すればよくなる。
- これは `mattermost`/`llm` ブロックを `getOptionalObject(...)` で検証している現行 `config.js` の方針（`config.js:190-197`）と一貫する。

#### 4.2 `normalizeMaxLongEdge` ヘルパーを追加

```js
const DEFAULT_MAX_LONG_EDGE = 1536;

function normalizeMaxLongEdge(value, name) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MAX_LONG_EDGE;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}
```

- 省略時はデフォルト 1536。
- 0 以下・非数値・**小数**は拒否する。`maxLongEdge` はピクセル長辺を表す整数のみを受け付け、`1536.5` のような小数は設定ミスとして弾く（`sharp.resize()` 側の暗黙変換に依存しない）。
- 既存の `deepFreeze` により `config.llm.images.maxLongEdge` も read-only になる。

### 5. `src/bots/chat-bot.js` の拡張

#### 5.1 `collectThreadImages` ヘルパーを追加

スレッド内の全ポストの画像を収集し、`imagesByPostId` マップ（`{ [postId]: Array<{ dataUrl, mimeType }> }`）を返す。`buildOpenAIRequestMessages`・`shouldRespondToThread` と同じく `export` し、`test/chat-bot.test.js` から直接 import して純粋関数として検証できるようにする。

```js
function isImageMimeType(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

export async function collectThreadImages({ thread, mattermost, resizer, maxLongEdge, logger }) {
  const imagesByPostId = {};

  for (const post of getThreadPostsInConversationOrder(thread)) {
    const fileIds = Array.isArray(post.file_ids) ? post.file_ids : [];

    if (fileIds.length === 0) {
      continue;
    }

    let fileInfos;

    try {
      fileInfos = await mattermost.getFileInfosForPost(post.id);
    } catch (error) {
      logger.warn(`Failed to load file infos for post ${post.id}.`, error);
      continue;
    }

    // getFileInfosForPost の返却順は file_ids 順と一致する保証がないため、
    // file_ids 順に明示的に並び替える（設計判断 #9 の契約を守る）。
    const fileInfoById = new Map(fileInfos.map((info) => [info.id, info]));
    const orderedFileInfos = fileIds
      .map((id) => fileInfoById.get(id))
      .filter((info) => info !== undefined);

    const imageParts = [];

    for (const fileInfo of orderedFileInfos) {
      if (!isImageMimeType(fileInfo.mime_type)) {
        continue;
      }

      try {
        const bytes = await mattermost.getFileContent(fileInfo.id);
        // resizer は { bytes, mimeType } を返す。出力形式の決定は resizer 側の責務。
        const { bytes: resizedBytes, mimeType } = await resizer(bytes, maxLongEdge);
        const base64 = Buffer.from(resizedBytes).toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;

        imageParts.push({ dataUrl, mimeType });
      } catch (error) {
        logger.warn(
          `Failed to process image file ${fileInfo.id} for post ${post.id}.`,
          error,
        );
      }
    }

    if (imageParts.length > 0) {
      imagesByPostId[post.id] = imageParts;
    }
  }

  return imagesByPostId;
}
```

- `chat-bot.js` から `export` する。`buildOpenAIRequestMessages`・`shouldRespondToThread` と同じエクスポートパターンで、アーキテクチャ上の境界（mattermost/openai/bots）を壊さず、テスト時の注入シームも維持できる。
- ポストごとに `getFileInfosForPost` を呼び、`mime_type` が `image/*` の FileInfo だけを処理する。
- 画像ごとに bytes ダウンロード → リサイズ → base64 データ URL 化を行う。data URL の MIME は `resizer` が返した `mimeType` をそのまま使う（出力形式の決定は `resizer` 側の責務、設計判断 #18）。
- 1 枚の失敗は警告ログに出し、その画像だけスキップして残りを続行する。
- FileInfo 取得に失敗したポストは警告ログを出して次のポストへ進む。
- ログには `file_id`・`post.id`・原因のみを記録し、bytes や base64 は絶対に出さない。
- 【修正メモ】初版では `fileInfos` を `getFileInfosForPost` の返却順そのまま使っていた。Mattermost API が `file_ids` 順を保証しない場合、設計判断 #9「`file_ids` 順に画像を並べる」と矛盾するため、`fileIds` で明示的に並び替えるようにした。`file_ids` に含まれない FileInfo が返ってきた場合は無視する（`filter` で落ちる）。

#### 5.2 `buildOpenAIRequestMessages` の拡張

引数に `imagesByPostId` を追加（既定 `= {}` で後方互換）。ポストに画像がある場合は `content` をパーツ配列にする。

```js
export function buildOpenAIRequestMessages({
  thread,
  botUserId,
  botUsername,
  systemPrompt,
  imagesByPostId = {},
}) {
  const messages = [{ role: 'system', content: systemPrompt }];

  for (const post of getThreadPostsInConversationOrder(thread)) {
    const imageParts = imagesByPostId[post.id] ?? [];
    const textContent =
      post.user_id === botUserId
        ? stripStreamingCursor(post.message ?? '')
        : sanitizeUserMessage(post.message ?? '', botUsername);

    if (imageParts.length === 0) {
      messages.push({
        role: post.user_id === botUserId ? 'assistant' : 'user',
        content: textContent,
      });
      continue;
    }

    messages.push({
      role: post.user_id === botUserId ? 'assistant' : 'user',
      content: [
        { type: 'text', text: textContent },
        ...imageParts.map((part) => ({
          type: 'image_url',
          image_url: { url: part.dataUrl },
        })),
      ],
    });
  }

  return messages;
}
```

- 画像がないポストは従来通り文字列の `content`。既存テストは修正なしで通る。
- 画像があるポストは `[ {type:'text', text}, {type:'image_url', image_url:{url}}, ... ]` の配列。テキスト→画像（`file_ids` 順）の順序。
- `detail` は省略し `auto` に委ねる。

#### 5.3 `ChatBot` コンストラクタに `resizer` の DI シームを追加

```js
import { resizeImageToMaxLongEdge } from '../images/resizer.js';

export class ChatBot {
  constructor({ mattermost, llm, config, logger = console, resizer = resizeImageToMaxLongEdge }) {
    // 既存フィールド ...
    this.resizer = resizer;
  }
  // ...
}
```

#### 5.4 `processPost` で画像収集を呼び出し

`getChannel` の後、`buildOpenAIRequestMessages` の前に画像を収集する。ただし**タイピング表示は画像収集の前に開始する**。

```js
const channel = await this.mattermost.getChannel(post.channel_id);

// タイピング表示は画像ダウンロード・リサイズの待ち時間を隠すため、
// collectThreadImages の前に開始する（UX 上の回帰を防ぐ）。
const typing = this.mattermost.startTypingLoop(post.channel_id, post.root_id || '');

try {
  const imagesByPostId = await collectThreadImages({
    thread,
    mattermost: this.mattermost,
    resizer: this.resizer,
    maxLongEdge: this.config.llm.images.maxLongEdge,
    logger: this.logger,
  });
  const messages = buildOpenAIRequestMessages({
    thread,
    botUserId: this.botUser.id,
    botUsername: this.botUser.username,
    systemPrompt: channel.header ?? '',
    imagesByPostId,
  });

  // …既存の LLM 呼び出し・返信作成ロジック…
} finally {
  typing.stop();
}
```

- 【修正メモ】初版では `collectThreadImages` 完了後に `startTypingLoop` していた。大きい画像や複数添付のスレッドでは「メンション直後に何も反応しない」時間が伸び、現行実装から UX 上の回帰となるため、順序を入れ替えた。
- `typing.stop()` は `finally` で守られているため、画像収集や LLM 呼び出しで例外になってもタイピングが止まる。これは現行 `try { ... } finally { typing.stop(); }` の構造と同じ。
- 画像収集で例外が起きても `processPost` の外側の `handlePost` `catch` に到達し `reportError` されるため、ユーザーにはエラーポストで通知される（現行挙動と同じ）。

### 6. `src/openai/rest-client.js` のログ拡張

`summarizeMessageForLog` にメッセージ単位の `image_part_count` を、`summarizeMessagesForLog` にリクエスト全体の `image_part_count` を追加する。

```js
function countImageParts(content) {
  if (!Array.isArray(content)) {
    return 0;
  }

  return content.filter(
    (part) => part && typeof part === 'object' && part.type === 'image_url',
  ).length;
}

function summarizeMessageForLog(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const content = normalizeContent(message.content);

  return {
    role: typeof message.role === 'string' ? message.role : 'unknown',
    content_preview: truncateForLog(content),
    content_length: content.length,
    image_part_count: countImageParts(message.content),
  };
}

function summarizeMessagesForLog(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const lastMessage = safeMessages.at(-1);
  const imagePartCount = safeMessages.reduce(
    (sum, message) => sum + countImageParts(message?.content),
    0,
  );

  return {
    total: safeMessages.length,
    omitted: safeMessages.length > 1 ? safeMessages.length - 1 : 0,
    image_part_count: imagePartCount,
    last: summarizeMessageForLog(lastMessage),
  };
}
```

- `normalizeContent` は変更せず、テキストのみを結合して `content_preview` にする（base64 は絶対に出ない）。
- 新設の `countImageParts` で画像パーツ数だけを数える。
- `summarizeMessagesForLog` には**リクエスト全体の画像パーツ総数**を `image_part_count` として持たせる。スレッド前半に画像があり最後の投稿がテキストだけだった場合でも、`messages.image_part_count` で画像の有無が分かる。`messages.last.image_part_count`（`summarizeMessageForLog` 経由）は「最後のメッセージに何枚画像があるか」のローカル情報として残す。
- `summarizeResponseForLog` 経由の `message` は assistant 応答のため `image_part_count` は常に `0` になるが、`summarizeMessageForLog` 共通化のためそのまま残す（無害な無駄フィールドだが共通関数の単体テスト性を優先）。
- 【修正メモ】初版では `summarizeMessageForLog` の `last` にだけ `image_part_count` を付けていた。スレッド前半の画像が見えなくなる観測性のズレがあったため、`summarizeMessagesForLog` にリクエスト全体集計を追加した。

### 7. `src/index.js` の変更

不要。`ChatBot` のデフォルト `resizer` が実物の `resizeImageToMaxLongEdge` を使うため、`createRuntimeBundle` の `botFactory` を変更する必要はない。

## テスト計画

既存の `node:test` + スタブ DI のパターンに従う。実ネットワーク呼び出し・実 sharp バイナリ呼び出しは行わない。

### `test/chat-bot.test.js` に追加

1. **`buildOpenAIRequestMessages` が `imagesByPostId` を画像パーツとして展開する**
   - 1 ポストにテキスト + 画像 1 枚の `imagesByPostId` を渡し、`content` が `[ {type:'text'}, {type:'image_url'} ]` になることを検証。
2. **複数画像が `file_ids` 順に並ぶ**
   - 1 ポストに画像 2 枚を渡し、テキスト→画像 1→画像 2 の順になることを検証。
2a. **`collectThreadImages` が `file_ids` 順を保持する**
   - `post.file_ids = ['b', 'a']` に対し `getFileInfosForPost` が `[a, b]` 順で返しても、`imagesByPostId[post.id]` が `b → a` 順で構築されることを検証（`fileIds` で並び替える設計判断 #9 の契約）。
3. **画像がないポストは従来通り文字列 `content`**
   - `imagesByPostId` を空で渡し、既存の文字列 `content` になることを検証（既存テストがそのままカバー）。
4. **`imagesByPostId` 省略時は後方互換**
   - 引数なしでも文字列 `content` になることを検証（既存テストがそのままカバー）。
5. **`collectThreadImages` が画像を収集する**
   - スタブ `mattermost`（`getFileInfosForPost`/`getFileContent` を返す）とスタブ `resizer`（`{ bytes, mimeType }` を返す）を注入し、`imagesByPostId` が正しく構築されることを検証。`imageParts[i].dataUrl` が `data:image/jpeg;base64,...` で始まり、`imageParts[i].mimeType` が `'image/jpeg'` であることも検証（`resizer` が返した `mimeType` がそのまま data URL に使われることの確認、設計判断 #18）。
6. **`collectThreadImages` が非画像添付を無視する**
   - `mime_type: 'application/pdf'` の FileInfo を含め、画像として扱われないことを検証。
7. **`collectThreadImages` が画像取得失敗をスキップする**
   - `getFileContent` が拒否された画像だけスキップし、残りの画像が `imagesByPostId` に含まれることを検証。
8. **`collectThreadImages` が FileInfo 取得失敗のポストをスキップする**
   - `getFileInfosForPost` が拒否されたポストは `imagesByPostId` に含まれないことを検証。
9. **`ChatBot` がスタブ `resizer` を使う**
   - `new ChatBot({ ..., resizer: fakeResizer })`（`fakeResizer` は `{ bytes, mimeType }` を返す）で `processPost` 全体を流し、`buildOpenAIRequestMessages` の結果に画像パーツが含まれることを検証。
10. **タイピング表示が画像収集の前に開始される**

- `startTypingLoop` と `getFileInfosForPost`/`getFileContent` の呼び出し順を記録し、`startTypingLoop` が先に呼ばれることを検証（UX 回帰防止、Finding 6）。

### `test/resizer.test.js` を新規追加

1. **`resizeImageToMaxLongEdge` が `sharpImpl` を呼ぶ**
   - スタブ `sharpImpl`（関数で `(bytes) => ({ resize: ... })` なチェーンを返す）を注入し、`resize` オプション（`fit: 'inside'`, `withoutEnlargement: true`, `width`/`height` = `maxLongEdge`）、`.flatten({ background: '#ffffff' })`、`.jpeg({ quality: 80 })`、`.toBuffer()` がこの順で呼ばれることを検証。
2. **`maxLongEdge` 省略時はデフォルト 1536**
   - スタブ `sharpImpl` に渡る `resize` オプションの `width`/`height` が 1536 になることを検証。
3. **出力フォーマットが JPEG（品質80）に固定される**
   - スタブ `sharpImpl` のチェーンで `.jpeg({ quality: 80 })` が呼ばれることを検証。`OUTPUT_MIME_TYPE` が `'image/jpeg'`・`OUTPUT_QUALITY` が `80`・`OUTPUT_BACKGROUND` が `'#ffffff'` であることも併せて検証。
4. **戻り値が `{ bytes, mimeType }` 形式である**
   - スタブ `sharpImpl` が返す `toBuffer()` の戻り値を `bytes` に、`OUTPUT_MIME_TYPE` を `mimeType` に持つオブジェクトが返されることを検証。`bytes` はスタブから返した値そのまであることも確認（bytes と mimeType の対応関係が壊れていないことの検証）。

### `test/config.test.js` に追加

1. **`llm.images.maxLongEdge` がパースされる**
   - `bots.json` で `1024` を指定した場合、`config.llm.images.maxLongEdge` が `1024` になることを検証。
2. **省略時はデフォルト 1536**
   - `images` ブロックを省略した場合、`config.llm.images.maxLongEdge` が `1536` になることを検証。
3. **0 以下・非数値・小数は拒否**
   - `0`・`-1`・`"abc"`・`1536.5` を指定した場合にエラーになることを検証（`must be a positive integer.`）。
4. **`images` が非オブジェクトなら拒否**
   - `"images": true`・`"images": []`・`"images": "fast"` 等の非オブジェクトを指定した場合に `${botLabel} llm.images must be an object.` で弾かれることを検証（`getOptionalObject` 由来）。

### `test/rest-client.test.js` に追加・更新

既存テストは `assert.deepEqual` でサマリー全体を比較しているため、`image_part_count` を追加すると**既存テストの期待値がそのままでは壊れる**。新規テストの追加だけでなく、既存テストの期待値更新も必須である。

1. **【更新】既存 `deepEqual` テストの期待値に `image_part_count: 0` を追加**
   - `summarizeMessagesForLog` に `image_part_count`（リクエスト全体集計）が増えたため、request summary の `messages` オブジェクトにも `image_part_count: 0` が必要。
   - `summarizeMessageForLog` に `image_part_count`（メッセージ単位）が増えたため、request summary の `messages.last` と response summary の `message` にも `image_part_count: 0` が必要。
   - 対象テストと更新箇所:
     - `rest-client.test.js:106-122`（非ストリーミング request summary）→ `messages.image_part_count: 0` と `messages.last.image_part_count: 0` を追記
     - `rest-client.test.js:124-138`（非ストリーミング response summary）→ `message.image_part_count: 0` を追記
     - `rest-client.test.js:188-202`（optional フィールド省略時 request summary）→ `messages.image_part_count: 0` と `messages.last.image_part_count: 0` を追記
     - `rest-client.test.js:330-348`（ストリーミング request summary）→ `messages.image_part_count: 0` と `messages.last.image_part_count: 0` を追記
     - `rest-client.test.js:350-365`（ストリーミング response summary）→ `message.image_part_count: 0` を追記
   - `rest-client.test.js:205-265`（multi-turn ロング応答テスト）は `assert.equal`/`assert.match` で部分比較しており `image_part_count` を検証しないため更新不要。
2. **【追加】`image_part_count` がログサマリーに現れる**
   - `content` が `[ {type:'text'}, {type:'image_url'}, {type:'image_url'} ]` のメッセージを渡し、`messages.image_part_count: 2` かつ `messages.last.image_part_count: 2` が記録されることを検証。
3. **【追加】前半メッセージの画像が `messages.image_part_count` に集計される（回帰防止）**
   - `messages = [{role:'user', content:[{type:'text'}, {type:'image_url'}]}, {role:'user', content:'text only'}]` のように「前半に画像1枚・最後はテキストのみ」の入力を渡し、`messages.image_part_count: 1`（リクエスト全体集計）かつ `messages.last.image_part_count: 0`（最後のメッセージ単位）が共に記録されることを検証。これにより、まさく直したかった観測性のズレを防ぐ。
4. **【追加】画像パーツの base64 は `content_preview` に出ない**
   - `image_url.url` に長い base64 を入れても `content_preview` に含まれないことを検証（`normalizeContent` が `image_url` パーツの `text` を拾わないことの再確認）。

## 検証手順

実装完了後に以下を実行し、全て通ることを確認する。

```bash
npm install
npm test
npm run lint
```

## やらないこと（スコープ外）

- 非画像添付ファイル（PDF/Word 等）の LLM への直接引き渡し。今回は完全に無視する。
- アニメーション画像のアニメーション維持。先頭フレームのみ送る。
- OpenAI `detail` パラメータの指定。省略（`auto`）とする。
- 公開リンク（Public Link）方式での画像渡し。base64 データ URL のみを使用する。
- 画像機能の ON/OFF フラグ。常に有効とする。
- `bots.json.example` の更新。オプショナル設定は `config.js` のデフォルト値で説明する。
- 画像の mime_type が空の場合の拡張子からの推定。`mime_type` が `image/*` でない FileInfo は無視する。

## リスクと緩和

| リスク | 影響 | 緩和 |
| --- | --- | --- |
| `sharp` のネイティブバイナリが CI/デプロイ環境で解決しない | インストール失敗 | prebuilt バイナリが提供されているため基本は問題ない。環境固有の問題は別途対応する。 |
| 大量画像添付でメモリ使用量が増大 | ボットプロセスの OOM | 1 ポストあたり数枚程度を想定。将来のキャップ導入は拡張ポイントとして残す。 |
| `mime_type` が空の画像が無視される | ユーザーの意図した画像が渡らない | Mattermost は通常 `mime_type` を付与するため実害は小さい。必要になったら拡張子推定を追加する。 |
| 画像ダウンロード失敗で画像欠落 | LLM が画像を見られない | 警告ログで運用時に検知可能。テキスト応答は継続するため会話全体は止まらない。 |
| クロスプロバイダ時に `image_url` スキーマ差異 | 他プロバイダでエラー | 現状 `provider: 'openai'` のみ許可。他プロバイダ対応は別課題とする。 |

## ファイル変更一覧

| ファイル | 変更種別 | 概要 |
| --- | --- | --- |
| `package.json` | 変更 | `dependencies` に `sharp` を追加。 |
| `src/images/resizer.js` | 新規 | `resizeImageToMaxLongEdge` 純粋関数（`{ bytes, mimeType }` を返す）。`sharpImpl` DI シーム。`flatten`・`jpeg` で JPEG 化。 |
| `src/mattermost/client.js` | 変更 | `fetchImpl` DI・`getFileInfosForPost`・`getFileContent` を追加。 |
| `src/config.js` | 変更 | `llm.images.maxLongEdge` パース・`normalizeMaxLongEdge` を追加。 |
| `src/bots/chat-bot.js` | 変更 | `collectThreadImages`・`buildOpenAIRequestMessages` 拡張・`ChatBot` コンストラクタ `resizer` DI・`processPost` 拡張。 |
| `src/openai/rest-client.js` | 変更 | `countImageParts`・`image_part_count` ログ追加。 |
| `src/index.js` | 変更なし | デフォルト `resizer` で動作するため修正不要。 |
| `test/chat-bot.test.js` | 変更 | `collectThreadImages`・`buildOpenAIRequestMessages` 画像対応のテストを追加。 |
| `test/resizer.test.js` | 新規 | `resizeImageToMaxLongEdge` のスタブテストを追加。 |
| `test/config.test.js` | 変更 | `llm.images.maxLongEdge` パースのテストを追加。 |
| `test/rest-client.test.js` | 変更 | `image_part_count` ログのテストを追加。 |
| `docs/image-attachment-support-plan-ja.md` | 新規 | 本計画ドキュメント。 |
