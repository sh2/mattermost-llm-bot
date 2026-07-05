import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenAIRequestMessages,
  ChatBot,
  collectThreadImages,
  shouldRespondToThread,
} from '../src/bots/chat-bot.js';

test('shouldRespondToThread returns true when any post mentions the bot', () => {
  const thread = {
    order: ['root', 'reply'],
    posts: {
      root: { id: 'root', message: '@ai-bot hello' },
      reply: { id: 'reply', message: 'follow-up' },
    },
  };

  assert.equal(shouldRespondToThread(thread, 'ai-bot'), true);
});

test('shouldRespondToThread ignores mentions to other bots', () => {
  const thread = {
    order: ['root'],
    posts: {
      root: { id: 'root', message: '@review-en hello' },
    },
  };

  assert.equal(shouldRespondToThread(thread, 'support-ja'), false);
});

test('ChatBot ignores posts from ai-* senders after stripping @ prefix', async () => {
  const calls = [];
  const mattermost = {
    async connect() {
      calls.push('connect');
      return { id: 'bot-1', username: 'ai-dev-01' };
    },
    onPost() {
      calls.push('onPost');
      return () => {};
    },
    close() {},
    async getThread() {
      calls.push('getThread');
      throw new Error('should not load thread for ai-* sender');
    },
  };
  const bot = new ChatBot({
    mattermost,
    llm: {},
    config: { llm: {} },
    logger: { info() {}, warn() {}, error() {} },
  });

  await bot.start();
  await bot.processPost({
    post: {
      id: 'reply-2',
      user_id: 'external-user-id',
      channel_id: 'channel-1',
      message: 'hello from another bot process',
    },
    senderName: '@ai-dev-02',
  });

  assert.deepEqual(calls, ['connect', 'onPost']);
});

test('ChatBot ignores its own posts even when sender name does not match ai-*', async () => {
  const calls = [];
  const mattermost = {
    async connect() {
      calls.push('connect');
      return { id: 'bot-1', username: 'support-ja' };
    },
    onPost() {
      calls.push('onPost');
      return () => {};
    },
    close() {},
    async getThread() {
      calls.push('getThread');
      throw new Error("should not load thread for the bot's own post");
    },
  };
  const bot = new ChatBot({
    mattermost,
    llm: {},
    config: { llm: {} },
    logger: { info() {}, warn() {}, error() {} },
  });

  await bot.start();
  await bot.processPost({
    post: {
      id: 'reply-3',
      user_id: 'bot-1',
      channel_id: 'channel-1',
      message: 'Self-authored reply',
    },
    senderName: 'Support Bot',
  });

  assert.deepEqual(calls, ['connect', 'onPost']);
});

test('ChatBot loads the thread using the root post id for replies', async () => {
  let requestedThreadId;
  const mattermost = {
    async connect() {
      return { id: 'bot-1', username: 'support-ja' };
    },
    onPost() {
      return () => {};
    },
    close() {},
    async getThread(threadId) {
      requestedThreadId = threadId;
      throw new Error('stop after capturing thread id');
    },
  };
  const bot = new ChatBot({
    mattermost,
    llm: {},
    config: { llm: {} },
    logger: { info() {}, warn() {}, error() {} },
  });

  await bot.start();
  await assert.rejects(
    () =>
      bot.processPost({
        post: {
          id: 'reply-4',
          root_id: 'root-1',
          user_id: 'user-1',
          channel_id: 'channel-1',
          message: 'follow-up',
        },
        senderName: 'SH2',
      }),
    /stop after capturing thread id/,
  );

  assert.equal(requestedThreadId, 'root-1');
});

test('ChatBot streaming replies create the Mattermost post only after text arrives', async () => {
  const createReplyCalls = [];
  const updatePostCalls = [];
  const llmCalls = [];
  const mattermost = {
    async connect() {
      return { id: 'bot-1', username: 'support-ja' };
    },
    onPost() {
      return () => {};
    },
    close() {},
    async getThread() {
      return {
        order: ['root'],
        posts: {
          root: {
            id: 'root',
            user_id: 'user-1',
            message: '@support-ja hello',
          },
        },
      };
    },
    async getChannel() {
      return { header: 'Stay concise.' };
    },
    startTypingLoop() {
      return { stop() {} };
    },
    async createReply(payload) {
      createReplyCalls.push(payload);
      return { id: 'reply-1' };
    },
    async updatePostMessage(postId, message) {
      updatePostCalls.push({ postId, message });
    },
  };
  const llm = {
    async createChatCompletion(messages, options) {
      llmCalls.push({ messages, options: { stream: options.stream } });
      await options.onDelta('partial reply');
      return 'final reply';
    },
  };
  const bot = new ChatBot({
    mattermost,
    llm,
    config: {
      llm: {
        stream: true,
        streamUpdateIntervalMs: 0,
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await bot.start();
  await bot.processPost({
    post: {
      id: 'root',
      user_id: 'user-1',
      channel_id: 'channel-1',
      message: '@support-ja hello',
    },
    senderName: 'Human',
  });

  assert.equal(llmCalls.length, 1);
  assert.deepEqual(createReplyCalls, [
    {
      channelId: 'channel-1',
      rootId: 'root',
      message: 'partial reply▌',
    },
  ]);
  assert.deepEqual(updatePostCalls, [
    {
      postId: 'reply-1',
      message: 'final reply',
    },
  ]);
});

test('ChatBot streaming replies fall back to a final create when no deltas arrive', async () => {
  const createReplyCalls = [];
  const updatePostCalls = [];
  const mattermost = {
    async connect() {
      return { id: 'bot-1', username: 'support-ja' };
    },
    onPost() {
      return () => {};
    },
    close() {},
    async getThread() {
      return {
        order: ['root'],
        posts: {
          root: {
            id: 'root',
            user_id: 'user-1',
            message: '@support-ja hello',
          },
        },
      };
    },
    async getChannel() {
      return { header: '' };
    },
    startTypingLoop() {
      return { stop() {} };
    },
    async createReply(payload) {
      createReplyCalls.push(payload);
      return { id: 'reply-2' };
    },
    async updatePostMessage(postId, message) {
      updatePostCalls.push({ postId, message });
    },
  };
  const llm = {
    async createChatCompletion(_messages, options) {
      assert.equal(options.stream, true);
      return 'final only';
    },
  };
  const bot = new ChatBot({
    mattermost,
    llm,
    config: {
      llm: {
        stream: true,
        streamUpdateIntervalMs: 0,
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await bot.start();
  await bot.processPost({
    post: {
      id: 'root',
      user_id: 'user-1',
      channel_id: 'channel-1',
      message: '@support-ja hello',
    },
    senderName: 'Human',
  });

  assert.deepEqual(createReplyCalls, [
    {
      channelId: 'channel-1',
      rootId: 'root',
      message: 'final only',
    },
  ]);
  assert.deepEqual(updatePostCalls, []);
});

test('buildOpenAIRequestMessages maps thread history to OpenAI messages', () => {
  const thread = {
    order: ['root', 'reply1', 'reply2'],
    posts: {
      root: {
        id: 'root',
        create_at: 100,
        user_id: 'user-1',
        message: '@ai-bot hello there',
      },
      reply1: {
        id: 'reply1',
        create_at: 200,
        user_id: 'bot-1',
        message: 'Hi!▌',
      },
      reply2: {
        id: 'reply2',
        create_at: 300,
        user_id: 'user-2',
        message: 'thanks @ai-bot',
      },
    },
  };

  assert.deepEqual(
    buildOpenAIRequestMessages({
      thread,
      botUserId: 'bot-1',
      botUsername: 'ai-bot',
      systemPrompt: 'You are a helpful bot.',
    }),
    [
      { role: 'system', content: 'You are a helpful bot.' },
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'thanks' },
    ],
  );
});

test('buildOpenAIRequestMessages sorts thread posts chronologically', () => {
  const thread = {
    order: ['reply2', 'root', 'reply1'],
    posts: {
      root: {
        id: 'root',
        create_at: 100,
        user_id: 'user-1',
        message: '@support-ja 好きな食べ物はありますか。',
      },
      reply1: {
        id: 'reply1',
        create_at: 200,
        user_id: 'bot-1',
        message: '寿司やカレーが人気です。あなたは何が好きですか？',
      },
      reply2: {
        id: 'reply2',
        create_at: 300,
        user_id: 'user-1',
        message: 'ラーメンが好きです。',
      },
    },
  };

  assert.deepEqual(
    buildOpenAIRequestMessages({
      thread,
      botUserId: 'bot-1',
      botUsername: 'support-ja',
      systemPrompt: 'あなたはアシスタントAIです。',
    }),
    [
      { role: 'system', content: 'あなたはアシスタントAIです。' },
      { role: 'user', content: '好きな食べ物はありますか。' },
      { role: 'assistant', content: '寿司やカレーが人気です。あなたは何が好きですか？' },
      { role: 'user', content: 'ラーメンが好きです。' },
    ],
  );
});

test('buildOpenAIRequestMessages removes only the current bot mention', () => {
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        user_id: 'user-1',
        message: '@support-ja please coordinate with @review-en',
      },
    },
  };

  assert.deepEqual(
    buildOpenAIRequestMessages({
      thread,
      botUserId: 'bot-1',
      botUsername: 'support-ja',
      systemPrompt: '',
    }),
    [
      { role: 'system', content: '' },
      { role: 'user', content: 'please coordinate with @review-en' },
    ],
  );
});

test('buildOpenAIRequestMessages treats other bots posts as user messages', () => {
  const thread = {
    order: ['root', 'reply'],
    posts: {
      root: {
        id: 'root',
        user_id: 'user-1',
        message: '@support-ja hello',
      },
      reply: {
        id: 'reply',
        user_id: 'bot-2',
        message: '@review-en checking this now',
      },
    },
  };

  assert.deepEqual(
    buildOpenAIRequestMessages({
      thread,
      botUserId: 'bot-1',
      botUsername: 'support-ja',
      systemPrompt: 'Stay concise.',
    }),
    [
      { role: 'system', content: 'Stay concise.' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: '@review-en checking this now' },
    ],
  );
});

test('buildOpenAIRequestMessages always includes the system prompt entry', () => {
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        user_id: 'user-1',
        message: '@ai-bot hello',
      },
    },
  };

  assert.deepEqual(
    buildOpenAIRequestMessages({
      thread,
      botUserId: 'bot-1',
      botUsername: 'ai-bot',
      systemPrompt: '',
    }),
    [
      { role: 'system', content: '' },
      { role: 'user', content: 'hello' },
    ],
  );
});

test('buildOpenAIRequestMessages expands imagesByPostId into multimodal content', () => {
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        user_id: 'user-1',
        message: '@support-ja see this',
      },
    },
  };

  assert.deepEqual(
    buildOpenAIRequestMessages({
      thread,
      botUserId: 'bot-1',
      botUsername: 'support-ja',
      systemPrompt: 'Stay concise.',
      imagesByPostId: {
        root: [{ dataUrl: 'data:image/jpeg;base64,abc', mimeType: 'image/jpeg' }],
      },
    }),
    [
      { role: 'system', content: 'Stay concise.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,abc' },
          },
        ],
      },
    ],
  );
});

test('buildOpenAIRequestMessages keeps multiple images in file order after the text part', () => {
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        user_id: 'user-1',
        message: '@support-ja compare',
      },
    },
  };

  const messages = buildOpenAIRequestMessages({
    thread,
    botUserId: 'bot-1',
    botUsername: 'support-ja',
    systemPrompt: '',
    imagesByPostId: {
      root: [
        { dataUrl: 'data:image/jpeg;base64,first', mimeType: 'image/jpeg' },
        { dataUrl: 'data:image/jpeg;base64,second', mimeType: 'image/jpeg' },
      ],
    },
  });

  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'compare' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,first' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,second' } },
    ],
  });
});

test('collectThreadImages builds image parts with resized data URLs', async () => {
  const calls = [];
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        user_id: 'user-1',
        file_ids: ['img-1'],
      },
    },
  };
  const mattermost = {
    async getFileInfosForPost(postId) {
      calls.push(['getFileInfosForPost', postId]);
      return [{ id: 'img-1', mime_type: 'image/png' }];
    },
    async getFileContent(fileId) {
      calls.push(['getFileContent', fileId]);
      return new Uint8Array([1, 2, 3]);
    },
  };
  const resizer = async (bytes, maxLongEdge) => {
    calls.push(['resizer', Array.from(bytes), maxLongEdge]);
    return {
      bytes: Buffer.from('resized-image'),
      mimeType: 'image/jpeg',
    };
  };

  const imagesByPostId = await collectThreadImages({
    thread,
    mattermost,
    resizer,
    maxLongEdge: 1024,
    logger: { warn() {} },
  });

  assert.deepEqual(calls, [
    ['getFileInfosForPost', 'root'],
    ['getFileContent', 'img-1'],
    ['resizer', [1, 2, 3], 1024],
  ]);
  assert.equal(imagesByPostId.root.length, 1);
  assert.equal(imagesByPostId.root[0].mimeType, 'image/jpeg');
  assert.equal(
    imagesByPostId.root[0].dataUrl,
    `data:image/jpeg;base64,${Buffer.from('resized-image').toString('base64')}`,
  );
});

test('collectThreadImages preserves post file_ids order', async () => {
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        file_ids: ['b', 'a'],
      },
    },
  };
  const mattermost = {
    async getFileInfosForPost() {
      return [
        { id: 'a', mime_type: 'image/png' },
        { id: 'b', mime_type: 'image/png' },
      ];
    },
    async getFileContent(fileId) {
      return Buffer.from(fileId);
    },
  };
  const resizer = async (bytes) => ({ bytes, mimeType: 'image/jpeg' });

  const imagesByPostId = await collectThreadImages({
    thread,
    mattermost,
    resizer,
    maxLongEdge: 1536,
    logger: { warn() {} },
  });

  assert.deepEqual(
    imagesByPostId.root.map((part) => part.dataUrl),
    [
      `data:image/jpeg;base64,${Buffer.from('b').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from('a').toString('base64')}`,
    ],
  );
});

test('collectThreadImages ignores non-image attachments', async () => {
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        file_ids: ['doc-1'],
      },
    },
  };
  const mattermost = {
    async getFileInfosForPost() {
      return [{ id: 'doc-1', mime_type: 'application/pdf' }];
    },
    async getFileContent() {
      throw new Error('should not download non-image file');
    },
  };

  const imagesByPostId = await collectThreadImages({
    thread,
    mattermost,
    resizer: async () => ({ bytes: Buffer.alloc(0), mimeType: 'image/jpeg' }),
    maxLongEdge: 1536,
    logger: { warn() {} },
  });

  assert.deepEqual(imagesByPostId, {});
});

test('collectThreadImages skips only the image that fails to download', async () => {
  const warnings = [];
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        file_ids: ['bad', 'good'],
      },
    },
  };
  const mattermost = {
    async getFileInfosForPost() {
      return [
        { id: 'bad', mime_type: 'image/png' },
        { id: 'good', mime_type: 'image/png' },
      ];
    },
    async getFileContent(fileId) {
      if (fileId === 'bad') {
        throw new Error('boom');
      }

      return Buffer.from('good');
    },
  };

  const imagesByPostId = await collectThreadImages({
    thread,
    mattermost,
    resizer: async (bytes) => ({ bytes, mimeType: 'image/jpeg' }),
    maxLongEdge: 1536,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to process image file bad for post root/);
  assert.deepEqual(
    imagesByPostId.root.map((part) => part.dataUrl),
    [`data:image/jpeg;base64,${Buffer.from('good').toString('base64')}`],
  );
});

test('collectThreadImages skips posts whose file infos cannot be loaded', async () => {
  const warnings = [];
  const thread = {
    order: ['root'],
    posts: {
      root: {
        id: 'root',
        file_ids: ['img-1'],
      },
    },
  };

  const imagesByPostId = await collectThreadImages({
    thread,
    mattermost: {
      async getFileInfosForPost() {
        throw new Error('failed');
      },
      async getFileContent() {
        throw new Error('should not be called');
      },
    },
    resizer: async () => ({ bytes: Buffer.alloc(0), mimeType: 'image/jpeg' }),
    maxLongEdge: 1536,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to load file infos for post root/);
  assert.deepEqual(imagesByPostId, {});
});

test('ChatBot uses the injected resizer and starts typing before loading thread images', async () => {
  const callOrder = [];
  const llmCalls = [];
  const mattermost = {
    async connect() {
      return { id: 'bot-1', username: 'support-ja' };
    },
    onPost() {
      return () => {};
    },
    close() {},
    async getThread() {
      return {
        order: ['root'],
        posts: {
          root: {
            id: 'root',
            user_id: 'user-1',
            channel_id: 'channel-1',
            message: '@support-ja hello',
            file_ids: ['img-1'],
          },
        },
      };
    },
    async getChannel() {
      return { header: 'Stay concise.' };
    },
    startTypingLoop() {
      callOrder.push('startTypingLoop');
      return { stop() {} };
    },
    async getFileInfosForPost() {
      callOrder.push('getFileInfosForPost');
      return [{ id: 'img-1', mime_type: 'image/png' }];
    },
    async getFileContent() {
      callOrder.push('getFileContent');
      return Buffer.from('source-image');
    },
    async createReply() {},
  };
  const llm = {
    async createChatCompletion(messages) {
      llmCalls.push(messages);
      return 'reply';
    },
  };
  const fakeResizer = async (bytes, maxLongEdge) => {
    callOrder.push(['resizer', maxLongEdge, bytes.toString()]);
    return {
      bytes: Buffer.from('resized-image'),
      mimeType: 'image/jpeg',
    };
  };
  const bot = new ChatBot({
    mattermost,
    llm,
    config: {
      llm: {
        stream: false,
        images: {
          maxLongEdge: 768,
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    resizer: fakeResizer,
  });

  await bot.start();
  await bot.processPost({
    post: {
      id: 'root',
      user_id: 'user-1',
      channel_id: 'channel-1',
      message: '@support-ja hello',
    },
    senderName: 'Human',
  });

  assert.equal(callOrder[0], 'startTypingLoop');
  assert.deepEqual(callOrder.slice(1), [
    'getFileInfosForPost',
    'getFileContent',
    ['resizer', 768, 'source-image'],
  ]);
  assert.equal(llmCalls.length, 1);
  assert.deepEqual(llmCalls[0], [
    { role: 'system', content: 'Stay concise.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${Buffer.from('resized-image').toString('base64')}`,
          },
        },
      ],
    },
  ]);
});
