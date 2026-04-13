import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OpenAIRestClient,
  extractAssistantMessage,
  iterateServerSentEvents,
} from '../src/openai/rest-client.js';

function parseLogSummary(logEntry, prefix) {
  assert.match(logEntry, new RegExp(`^${prefix}: `));
  return JSON.parse(logEntry.slice(`${prefix}: `.length));
}

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
  const logEntries = [];

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
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
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
    {
      info(message) {
        logEntries.push(message);
      },
    },
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

  const requestSummary = parseLogSummary(logEntries[0], 'OpenAI request summary');
  assert.deepEqual(requestSummary, {
    model: 'gpt-test',
    stream: false,
    reasoning_effort: 'medium',
    verbosity: 'medium',
    stream_options: null,
    messages: {
      total: 1,
      omitted: 0,
      last: {
        role: 'user',
        content_preview: 'hello',
        content_length: 5,
      },
    },
  });

  const responseSummary = parseLogSummary(logEntries[1], 'OpenAI response summary');
  assert.deepEqual(responseSummary, {
    model: 'gpt-test',
    stream: false,
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    },
    message: {
      role: 'assistant',
      content_preview: 'non-stream reply',
      content_length: 16,
    },
  });
});

test('OpenAIRestClient summarizes multi-turn request and long response logs', async () => {
  const longUserMessage = 'x'.repeat(300);
  const longReply = 'y'.repeat(320);
  const logEntries = [];
  const client = new OpenAIRestClient(
    {
      apiKey: 'test-key',
      model: 'gpt-test',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      reasoningEffort: 'medium',
      verbosity: 'medium',
    },
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: longReply,
              },
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 30,
            total_tokens: 50,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    {
      info(message) {
        logEntries.push(message);
      },
    },
  );

  const result = await client.createChatCompletion([
    { role: 'system', content: 'system prompt' },
    { role: 'assistant', content: 'previous reply' },
    { role: 'user', content: longUserMessage },
  ]);

  assert.equal(result, longReply);

  const requestSummary = parseLogSummary(logEntries[0], 'OpenAI request summary');
  assert.equal(requestSummary.messages.total, 3);
  assert.equal(requestSummary.messages.omitted, 2);
  assert.deepEqual(requestSummary.messages.last.role, 'user');
  assert.equal(requestSummary.messages.last.content_length, 300);
  assert.equal(requestSummary.messages.last.content_preview.length, 243);
  assert.ok(requestSummary.messages.last.content_preview.endsWith('...'));

  const responseSummary = parseLogSummary(logEntries[1], 'OpenAI response summary');
  assert.equal(responseSummary.message.content_length, 320);
  assert.equal(responseSummary.message.content_preview.length, 243);
  assert.ok(responseSummary.message.content_preview.endsWith('...'));
});

test('OpenAIRestClient accumulates streamed deltas', async () => {
  const encoder = new TextEncoder();
  let request;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
      controller.enqueue(
        encoder.encode(
          'data: {"model":"gpt-test","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  const seenReplies = [];
  const logEntries = [];
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
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
    {
      info(message) {
        logEntries.push(message);
      },
    },
  );

  const result = await client.createChatCompletion([{ role: 'user', content: 'hello' }], {
    stream: true,
    onDelta: async (replyText) => {
      seenReplies.push(replyText);
    },
  });

  assert.equal(result, 'Hello world');
  assert.deepEqual(seenReplies, ['Hello', 'Hello world']);
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: 'medium',
    verbosity: 'medium',
    stream: true,
    stream_options: {
      include_usage: true,
    },
  });

  const requestSummary = parseLogSummary(logEntries[0], 'OpenAI request summary');
  assert.deepEqual(requestSummary, {
    model: 'gpt-test',
    stream: true,
    reasoning_effort: 'medium',
    verbosity: 'medium',
    stream_options: {
      include_usage: true,
    },
    messages: {
      total: 1,
      omitted: 0,
      last: {
        role: 'user',
        content_preview: 'hello',
        content_length: 5,
      },
    },
  });

  const responseSummary = parseLogSummary(logEntries[1], 'OpenAI response summary');
  assert.deepEqual(responseSummary, {
    model: 'gpt-test',
    stream: true,
    usage: {
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    },
    delta_count: 2,
    message: {
      role: 'assistant',
      content_preview: 'Hello world',
      content_length: 11,
    },
  });
});
