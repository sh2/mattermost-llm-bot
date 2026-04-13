import assert from 'node:assert/strict';
import test from 'node:test';

import { startBotBundles, startRuntime, stopBotBundles } from '../src/index.js';

function createArrayLogger() {
  const entries = [];

  return {
    entries,
    info: (...args) => {
      entries.push({ level: 'info', args });
    },
    warn: (...args) => {
      entries.push({ level: 'warn', args });
    },
    error: (...args) => {
      entries.push({ level: 'error', args });
    },
  };
}

function createFakeBundle(name, calls, options = {}) {
  const { startError, stopError } = options;

  return {
    name,
    bot: {
      async start() {
        calls.push(`start:${name}`);

        if (startError) {
          throw startError;
        }
      },
      async stop() {
        calls.push(`stop:${name}`);

        if (stopError) {
          throw stopError;
        }
      },
    },
  };
}

function createFakeProcessRef() {
  const listeners = new Map();
  const exitCalls = [];

  return {
    listeners,
    exitCalls,
    once(signal, listener) {
      listeners.set(signal, listener);
    },
    removeListener(signal, listener) {
      if (listeners.get(signal) === listener) {
        listeners.delete(signal);
      }
    },
    exit(code) {
      exitCalls.push(code);
    },
  };
}

test('startBotBundles starts all bots and logs the started bot list', async () => {
  const calls = [];
  const logger = createArrayLogger();
  const bundles = [
    createFakeBundle('support-ja', calls),
    createFakeBundle('review-en', calls),
  ];

  await startBotBundles(bundles, logger);

  assert.deepEqual(calls, ['start:support-ja', 'start:review-en']);
  assert.match(logger.entries[0].args[0], /Started 2 Mattermost bot\(s\): support-ja, review-en/);
});

test('startBotBundles rolls back already started bots when a later bot fails', async () => {
  const calls = [];
  const logger = createArrayLogger();
  const bundles = [
    createFakeBundle('support-ja', calls),
    createFakeBundle('review-en', calls, {
      startError: new Error('boom'),
    }),
  ];

  await assert.rejects(() => startBotBundles(bundles, logger), /boom/);
  assert.deepEqual(calls, [
    'start:support-ja',
    'start:review-en',
    'stop:review-en',
    'stop:support-ja',
  ]);
});

test('stopBotBundles continues stopping remaining bots after a stop failure', async () => {
  const calls = [];
  const logger = createArrayLogger();
  const bundles = [
    createFakeBundle('support-ja', calls, {
      stopError: new Error('failed stop'),
    }),
    createFakeBundle('review-en', calls),
  ];

  await stopBotBundles(bundles, logger);

  assert.deepEqual(calls, ['stop:review-en', 'stop:support-ja']);
  assert.equal(logger.entries.length, 1);
  assert.match(logger.entries[0].args[0], /\[support-ja\] Failed to stop bot\./);
});

test('startRuntime registers signal handlers and stops all bots on signal', async () => {
  const calls = [];
  const logger = createArrayLogger();
  const processRef = createFakeProcessRef();
  const runtime = await startRuntime({
    logger,
    processRef,
    loadConfigImpl: () => ({
      configPath: '/tmp/bots.json',
      bots: [
        { name: 'support-ja', llm: { provider: 'openai' } },
        { name: 'review-en', llm: { provider: 'openai' } },
      ],
    }),
    bundleFactory: (botConfig) => createFakeBundle(botConfig.name, calls),
  });

  assert.equal(typeof processRef.listeners.get('SIGTERM'), 'function');

  await processRef.listeners.get('SIGTERM')();

  assert.equal(runtime.bundles.length, 2);
  assert.deepEqual(calls, [
    'start:support-ja',
    'start:review-en',
    'stop:review-en',
    'stop:support-ja',
  ]);
  assert.deepEqual(processRef.exitCalls, [0]);
});
