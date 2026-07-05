import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

function createTempConfig(t, contents, fileName = 'bots.json') {
  const dir = mkdtempSync(join(tmpdir(), 'mattermost-llm-bot-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const configPath = join(dir, fileName);
  writeFileSync(configPath, JSON.stringify(contents, null, 2));
  return { dir, configPath };
}

test('loadConfig parses JSON config, merges defaults, and resolves bot secrets', (t) => {
  const { dir } = createTempConfig(t, {
    defaults: {
      mattermost: {
        url: 'http://localhost:8065/',
      },
      llm: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1/',
        stream: true,
      },
    },
    bots: [
      {
        name: 'support-ja',
        llm: {
          model: 'gpt-5.1-mini',
        },
      },
      {
        name: 'review-en',
        mattermost: {
          url: 'https://mattermost.example.com/team/',
        },
        llm: {
          model: 'gpt-5.1',
          baseUrl: 'https://example.com/custom/v1/',
          stream: false,
          compatibilityProfile: 'gemini-openai',
          reasoningEffort: 'high',
          verbosity: 'low',
        },
      },
    ],
  });

  const config = loadConfig(
    {
      BOT_CONFIG_PATH: './bots.json',
      BOT_SUPPORT_JA_TOKEN: 'support-token',
      BOT_SUPPORT_JA_LLM_API_KEY: 'support-key',
      BOT_REVIEW_EN_TOKEN: 'review-token',
      BOT_REVIEW_EN_LLM_API_KEY: 'review-key',
    },
    { cwd: dir },
  );

  assert.equal(config.configPath, join(dir, 'bots.json'));
  assert.equal(config.bots.length, 2);
  assert.deepEqual(config.bots[0], {
    name: 'support-ja',
    mattermost: {
      url: 'http://localhost:8065',
      token: 'support-token',
      typingIntervalMs: 1000,
    },
    llm: {
      provider: 'openai',
      apiKey: 'support-key',
      model: 'gpt-5.1-mini',
      stream: true,
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      reasoningEffort: null,
      verbosity: null,
      streamUpdateIntervalMs: 1000,
    },
  });
  assert.deepEqual(config.bots[1], {
    name: 'review-en',
    mattermost: {
      url: 'https://mattermost.example.com/team',
      token: 'review-token',
      typingIntervalMs: 1000,
    },
    llm: {
      provider: 'openai',
      apiKey: 'review-key',
      model: 'gpt-5.1',
      stream: false,
      apiUrl: 'https://example.com/custom/v1/chat/completions',
      reasoningEffort: 'high',
      verbosity: 'low',
      streamUpdateIntervalMs: 1000,
    },
  });
});

test('loadConfig rejects a missing bots array', (t) => {
  const { configPath } = createTempConfig(t, {
    defaults: {},
  });

  assert.throws(
    () =>
      loadConfig({
        BOT_CONFIG_PATH: configPath,
      }),
    /must contain a "bots" array/,
  );
});

test('loadConfig rejects an empty bots array', (t) => {
  const { configPath } = createTempConfig(t, {
    bots: [],
  });

  assert.throws(
    () =>
      loadConfig({
        BOT_CONFIG_PATH: configPath,
      }),
    /must define at least one bot/,
  );
});

test('loadConfig rejects duplicate bot names', (t) => {
  const { configPath } = createTempConfig(t, {
    defaults: {
      mattermost: { url: 'http://localhost:8065' },
      llm: { model: 'gpt-default' },
    },
    bots: [{ name: 'support-ja' }, { name: 'support-ja' }],
  });

  assert.throws(
    () =>
      loadConfig({
        BOT_CONFIG_PATH: configPath,
        BOT_SUPPORT_JA_TOKEN: 'token',
        BOT_SUPPORT_JA_LLM_API_KEY: 'key',
      }),
    /Bot name "support-ja" is duplicated/,
  );
});

test('loadConfig reports missing merged values with bot context', (t) => {
  const { configPath } = createTempConfig(t, {
    defaults: {
      mattermost: { url: 'http://localhost:8065' },
    },
    bots: [{ name: 'support-ja' }],
  });

  assert.throws(
    () =>
      loadConfig({
        BOT_CONFIG_PATH: configPath,
        BOT_SUPPORT_JA_TOKEN: 'token',
        BOT_SUPPORT_JA_LLM_API_KEY: 'key',
      }),
    /Bot "support-ja" llm\.model is required/,
  );
});

test('loadConfig reports missing bot-scoped secrets with bot context', (t) => {
  const { configPath } = createTempConfig(t, {
    defaults: {
      mattermost: { url: 'http://localhost:8065' },
      llm: { model: 'gpt-test' },
    },
    bots: [{ name: 'support-ja' }],
  });

  assert.throws(
    () =>
      loadConfig({
        BOT_CONFIG_PATH: configPath,
      }),
    /Bot "support-ja" requires BOT_SUPPORT_JA_TOKEN/,
  );
});

test('loadConfig rejects unsupported llm.provider values', (t) => {
  const { configPath } = createTempConfig(t, {
    defaults: {
      mattermost: { url: 'http://localhost:8065' },
    },
    bots: [
      {
        name: 'support-ja',
        llm: {
          provider: 'anthropic',
          model: 'claude-test',
        },
      },
    ],
  });

  assert.throws(
    () =>
      loadConfig({
        BOT_CONFIG_PATH: configPath,
        BOT_SUPPORT_JA_TOKEN: 'token',
        BOT_SUPPORT_JA_LLM_API_KEY: 'key',
      }),
    /Bot "support-ja" llm\.provider "anthropic" is not supported/,
  );
});

test('loadConfig rejects llm.baseUrl values that already include chat completions', (t) => {
  const { configPath } = createTempConfig(t, {
    defaults: {
      mattermost: { url: 'http://localhost:8065' },
    },
    bots: [
      {
        name: 'support-ja',
        llm: {
          model: 'gpt-test',
          baseUrl: 'https://example.com/v1/chat/completions',
        },
      },
    ],
  });

  assert.throws(
    () =>
      loadConfig({
        BOT_CONFIG_PATH: configPath,
        BOT_SUPPORT_JA_TOKEN: 'token',
        BOT_SUPPORT_JA_LLM_API_KEY: 'key',
      }),
    /must be a base URL and must not include \/chat\/completions/,
  );
});
