const JSON_HEADERS = {
  'content-type': 'application/json',
};

function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .flatMap((part) => {
      if (typeof part === 'string') {
        return [part];
      }

      if (part && typeof part.text === 'string') {
        return [part.text];
      }

      return [];
    })
    .join('');
}

function extractEventData(rawEvent) {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

export async function* iterateServerSentEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const rawEvent of events) {
      const eventData = extractEventData(rawEvent);

      if (eventData) {
        yield eventData;
      }
    }

    if (done) {
      break;
    }
  }

  const remainingEvent = extractEventData(buffer.trim());

  if (remainingEvent) {
    yield remainingEvent;
  }
}

export function extractAssistantMessage(payload) {
  const text = normalizeContent(payload?.choices?.[0]?.message?.content);

  if (!text) {
    throw new Error('OpenAI returned an empty response.');
  }

  return text;
}

export function extractStreamDelta(payload) {
  return normalizeContent(payload?.choices?.[0]?.delta?.content);
}

async function buildOpenAIError(response) {
  const responseText = await response.text();
  let message = responseText;

  if (responseText) {
    try {
      const parsed = JSON.parse(responseText);
      message = parsed?.error?.message ?? responseText;
    } catch {
      message = responseText;
    }
  } else {
    message = response.statusText;
  }

  return new Error(`OpenAI request failed with status ${response.status}: ${message}`);
}

export class OpenAIRestClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('global fetch is required.');
    }

    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiUrl = config.apiUrl;
    this.reasoningEffort = config.reasoningEffort;
    this.verbosity = config.verbosity;
    this.fetchImpl = fetchImpl;
  }

  async createChatCompletion(messages, options = {}) {
    const { stream = false, onDelta, signal } = options;
    const response = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        reasoning_effort: this.reasoningEffort,
        verbosity: this.verbosity,
        stream,
      }),
      signal,
    });

    if (!response.ok) {
      throw await buildOpenAIError(response);
    }

    if (stream) {
      return this.consumeStreamResponse(response, onDelta);
    }

    const payload = await response.json();
    return extractAssistantMessage(payload);
  }

  async consumeStreamResponse(response, onDelta) {
    if (!response.body) {
      throw new Error('OpenAI streaming response body is missing.');
    }

    let replyText = '';

    for await (const eventData of iterateServerSentEvents(response.body)) {
      if (eventData === '[DONE]') {
        break;
      }

      const payload = JSON.parse(eventData);
      const delta = extractStreamDelta(payload);

      if (!delta) {
        continue;
      }

      replyText += delta;

      if (onDelta) {
        await onDelta(replyText, delta);
      }
    }

    if (!replyText) {
      throw new Error('OpenAI returned an empty streamed response.');
    }

    return replyText;
  }
}
