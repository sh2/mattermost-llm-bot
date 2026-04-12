import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OpenAIRestClient,
  extractAssistantMessage,
  iterateServerSentEvents,
} from '../src/openai/rest-client.js';

test('extractAssistantMessage returns the first completion text', () => {
  const payload = {
    choices: [
      {
        message: {
          content: 'hello world',
        },
      },
    ],
  };

  assert.equal(extractAssistantMessage(payload), 'hello world');
});

test('iterateServerSentEvents joins chunked SSE frames', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel'));
      controller.enqueue(encoder.encode('lo"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  const messages = [];

  for await (const message of iterateServerSentEvents(stream)) {
    messages.push(message);
  }

  assert.deepEqual(messages, ['{"choices":[{"delta":{"content":"Hello"}}]}', '[DONE]']);
});

test('OpenAIRestClient sends non-streaming requests with auth headers', async () => {
  let request;

  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'non-stream reply',
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  const client = new OpenAIRestClient(
    {
      apiKey: 'test-key',
      model: 'gpt-test',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      reasoningEffort: 'medium',
      verbosity: 'medium',
    },
    fetchImpl,
  );

  const result = await client.createChatCompletion([{ role: 'user', content: 'hello' }]);

  assert.equal(result, 'non-stream reply');
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: 'medium',
    verbosity: 'medium',
    stream: false,
  });
});

test('OpenAIRestClient accumulates streamed deltas', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  const seenReplies = [];
  const fetchImpl = async () =>
    new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

  const client = new OpenAIRestClient(
    {
      apiKey: 'test-key',
      model: 'gpt-test',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      reasoningEffort: 'medium',
      verbosity: 'medium',
    },
    fetchImpl,
  );

  const result = await client.createChatCompletion([{ role: 'user', content: 'hello' }], {
    stream: true,
    onDelta: async (replyText) => {
      seenReplies.push(replyText);
    },
  });

  assert.equal(result, 'Hello world');
  assert.deepEqual(seenReplies, ['Hello', 'Hello world']);
});
