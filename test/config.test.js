import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('loadConfig uses the new OpenAI defaults', () => {
  const config = loadConfig({
    MATTERMOST_URL: 'http://localhost:8065',
    BOT_TOKEN: 'bot-token',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'gpt-test',
  });

  assert.equal(config.openai.apiUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(config.openai.reasoningEffort, 'medium');
  assert.equal(config.openai.verbosity, 'medium');
  assert.equal(config.openai.stream, true);
});

test('loadConfig builds the chat completions endpoint from an overridden base URL', () => {
  const config = loadConfig({
    MATTERMOST_URL: 'http://localhost:8065',
    BOT_TOKEN: 'bot-token',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'gpt-test',
    OPENAI_BASE_URL: 'https://example.com/custom/v1/',
    OPENAI_REASONING_EFFORT: 'low',
    OPENAI_VERBOSITY: 'high',
    OPENAI_STREAM: 'false',
  });

  assert.equal(config.openai.apiUrl, 'https://example.com/custom/v1/chat/completions');
  assert.equal(config.openai.reasoningEffort, 'low');
  assert.equal(config.openai.verbosity, 'high');
  assert.equal(config.openai.stream, false);
});

test('loadConfig rejects OPENAI_BASE_URL values that already include chat completions', () => {
  assert.throws(
    () =>
      loadConfig({
        MATTERMOST_URL: 'http://localhost:8065',
        BOT_TOKEN: 'bot-token',
        OPENAI_API_KEY: 'openai-key',
        OPENAI_MODEL: 'gpt-test',
        OPENAI_BASE_URL: 'https://sh2oai05.openai.azure.com/openai/v1/chat/completions',
      }),
    /must be a base URL up to \/v1 and must not include \/chat\/completions/,
  );
});
