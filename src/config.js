import dotenv from 'dotenv';

dotenv.config();

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function readRequiredString(env, name) {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function readStringWithDefault(env, name, fallback) {
  const value = env[name]?.trim();
  return value || fallback;
}

function parseBoolean(env, name, fallback) {
  const value = env[name];

  if (value === undefined || value === '') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean-like value.`);
}

function normalizeMattermostUrl(value) {
  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MATTERMOST_URL must start with http:// or https://');
  }

  return url.toString().replace(/\/+$/, '');
}

function normalizeHttpUrl(value, name) {
  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must start with http:// or https://`);
  }

  return url.toString();
}

function normalizeOpenAIBaseUrl(value) {
  const url = new URL(normalizeHttpUrl(value, 'OPENAI_BASE_URL'));
  const normalizedPath = url.pathname.replace(/\/+$/, '');

  if (normalizedPath.endsWith('/chat/completions')) {
    throw new Error(
      'OPENAI_BASE_URL must be a base URL up to /v1 and must not include /chat/completions.',
    );
  }

  url.pathname = `${normalizedPath}/chat/completions`;
  url.search = '';
  url.hash = '';

  return url.toString();
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    mattermost: Object.freeze({
      url: normalizeMattermostUrl(readRequiredString(env, 'MATTERMOST_URL')),
      token: readRequiredString(env, 'BOT_TOKEN'),
      typingIntervalMs: 1000,
    }),
    openai: Object.freeze({
      apiKey: readRequiredString(env, 'OPENAI_API_KEY'),
      model: readRequiredString(env, 'OPENAI_MODEL'),
      stream: parseBoolean(env, 'OPENAI_STREAM', true),
      apiUrl: normalizeOpenAIBaseUrl(
        readStringWithDefault(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      ),
      reasoningEffort: readStringWithDefault(env, 'OPENAI_REASONING_EFFORT', 'medium'),
      verbosity: readStringWithDefault(env, 'OPENAI_VERBOSITY', 'medium'),
      streamUpdateIntervalMs: 1000,
    }),
  });
}
