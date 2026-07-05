const JSON_HEADERS = {
  'content-type': 'application/json',
};

const LOG_PREVIEW_LIMIT = 240;

function truncateForLog(value, maxLength = LOG_PREVIEW_LIMIT) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function countImageParts(content) {
  if (!Array.isArray(content)) {
    return 0;
  }

  return content.filter((part) => part && typeof part === 'object' && part.type === 'image_url')
    .length;
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

function summarizeResponseForLog({ model, usage, replyText, stream, deltaCount }) {
  return {
    model: typeof model === 'string' ? model : null,
    stream,
    usage: usage && typeof usage === 'object' ? usage : null,
    delta_count: stream ? deltaCount : undefined,
    message: summarizeMessageForLog({ role: 'assistant', content: replyText }),
  };
}

function logSummary(logger, label, payload) {
  logger.info(`${label}: ${JSON.stringify(payload)}`);
}

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
  constructor(config, fetchImpl = globalThis.fetch, logger = console) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('global fetch is required.');
    }

    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiUrl = config.apiUrl;
    this.reasoningEffort = config.reasoningEffort;
    this.verbosity = config.verbosity;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  async createChatCompletion(messages, options = {}) {
    const { stream = false, onDelta, signal } = options;
    const requestBody = {
      model: this.model,
      messages,
      stream,
    };

    if (this.reasoningEffort !== null && this.reasoningEffort !== undefined) {
      requestBody.reasoning_effort = this.reasoningEffort;
    }

    if (this.verbosity !== null && this.verbosity !== undefined) {
      requestBody.verbosity = this.verbosity;
    }

    if (stream) {
      requestBody.stream_options = {
        include_usage: true,
      };
    }

    logSummary(this.logger, 'OpenAI request summary', {
      model: requestBody.model,
      stream: requestBody.stream,
      reasoning_effort: requestBody.reasoning_effort,
      verbosity: requestBody.verbosity,
      stream_options: requestBody.stream_options ?? null,
      messages: summarizeMessagesForLog(requestBody.messages),
    });

    const response = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      throw await buildOpenAIError(response);
    }

    if (stream) {
      return this.consumeStreamResponse(response, onDelta);
    }

    const payload = await response.json();
    const replyText = extractAssistantMessage(payload);

    logSummary(
      this.logger,
      'OpenAI response summary',
      summarizeResponseForLog({
        model: payload?.model ?? this.model,
        usage: payload?.usage,
        replyText,
        stream: false,
      }),
    );

    return replyText;
  }

  async consumeStreamResponse(response, onDelta) {
    if (!response.body) {
      throw new Error('OpenAI streaming response body is missing.');
    }

    let replyText = '';
    let usage = null;
    let responseModel = this.model;
    let deltaCount = 0;

    for await (const eventData of iterateServerSentEvents(response.body)) {
      if (eventData === '[DONE]') {
        break;
      }

      const payload = JSON.parse(eventData);

      if (payload?.usage && typeof payload.usage === 'object') {
        usage = payload.usage;
      }

      if (typeof payload?.model === 'string') {
        responseModel = payload.model;
      }

      const delta = extractStreamDelta(payload);

      if (!delta) {
        continue;
      }

      deltaCount += 1;
      replyText += delta;

      if (onDelta) {
        await onDelta(replyText, delta);
      }
    }

    if (!replyText) {
      throw new Error('OpenAI returned an empty streamed response.');
    }

    logSummary(
      this.logger,
      'OpenAI response summary',
      summarizeResponseForLog({
        model: responseModel,
        usage,
        replyText,
        stream: true,
        deltaCount,
      }),
    );

    return replyText;
  }
}
