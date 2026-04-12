import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenAIRequestMessages, shouldRespondToThread } from '../src/bots/chat-bot.js';

test('shouldRespondToThread returns true when any post mentions the bot', () => {
  const thread = {
    order: ['root', 'reply'],
    posts: {
      root: { id: 'root', message: '@ai-bot hello' },
      reply: { id: 'reply', message: 'follow-up' },
    },
  };

  assert.equal(shouldRespondToThread(thread, 'alice', 'ai-bot'), true);
});

test('shouldRespondToThread ignores ai-* senders', () => {
  const thread = {
    order: ['root'],
    posts: {
      root: { id: 'root', message: '@ai-bot hello' },
    },
  };

  assert.equal(shouldRespondToThread(thread, 'ai-helper', 'ai-bot'), false);
});

test('buildOpenAIRequestMessages maps thread history to OpenAI messages', () => {
  const thread = {
    order: ['root', 'reply1', 'reply2'],
    posts: {
      root: {
        id: 'root',
        user_id: 'user-1',
        message: '@ai-bot hello there',
      },
      reply1: {
        id: 'reply1',
        user_id: 'bot-1',
        message: 'Hi!▌',
      },
      reply2: {
        id: 'reply2',
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
