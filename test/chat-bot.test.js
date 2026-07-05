import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenAIRequestMessages,
  ChatBot,
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
