import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import dotenv from 'dotenv';

dotenv.config();

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_CONFIG_PATH = './config/bots.json';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_LONG_EDGE = 1536;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return value;
}

function readRequiredEnvString(env, name) {
  const value = env[name];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
}

function readEnvStringWithDefault(env, name, fallback) {
  const value = env[name];

  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim() || fallback;
}

function normalizeRequiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
}

function normalizeOptionalString(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string.`);
  }

  return value.trim() || fallback;
}

function parseBooleanLike(value, name, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a boolean-like value.`);
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

function parseHttpUrl(value, name) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must start with http:// or https://`);
  }

  return url;
}

function normalizeMattermostUrl(value, name) {
  return parseHttpUrl(value, name).toString().replace(/\/+$/, '');
}

function normalizeOpenAIBaseUrl(value, name) {
  const url = parseHttpUrl(value, name);
  const normalizedPath = url.pathname.replace(/\/+$/, '');

  if (normalizedPath.endsWith('/chat/completions')) {
    throw new Error(`${name} must be a base URL and must not include /chat/completions.`);
  }

  url.pathname = `${normalizedPath}/chat/completions`;
  url.search = '';
  url.hash = '';

  return url.toString();
}

function readJsonFile(configPath, readFileSyncImpl) {
  let rawConfig;

  try {
    rawConfig = readFileSyncImpl(configPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read bot config at ${configPath}: ${message}`);
  }

  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse bot config at ${configPath}: ${message}`);
  }
}

function getOptionalObject(value, name) {
  if (value === undefined) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error(`${name} must be an object.`);
  }

  return value;
}

function mergeOptionalNestedObject(base, override) {
  if (override === undefined) {
    return base;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    return {
      ...base,
      ...override,
    };
  }

  return override;
}

function normalizeMaxLongEdge(value, name) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MAX_LONG_EDGE;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function getConfigRoot(configPath, readFileSyncImpl) {
  const parsed = readJsonFile(configPath, readFileSyncImpl);

  if (!isPlainObject(parsed)) {
    throw new Error(`Bot config at ${configPath} must contain a JSON object.`);
  }

  return parsed;
}

function readBotSecret(env, envName, botLabel) {
  try {
    return readRequiredEnvString(env, envName);
  } catch {
    throw new Error(`${botLabel} requires ${envName}.`);
  }
}

function mergeBotDefinition(defaults, botDefinition, index) {
  if (!isPlainObject(botDefinition)) {
    throw new Error(`bots[${index}] must be an object.`);
  }

  const name = normalizeRequiredString(botDefinition.name, `bots[${index}].name`);

  const defaultMattermost = getOptionalObject(defaults.mattermost, 'defaults.mattermost');
  const botMattermost = getOptionalObject(botDefinition.mattermost, `bots[${index}].mattermost`);
  const defaultLlm = getOptionalObject(defaults.llm, 'defaults.llm');
  const botLlm = getOptionalObject(botDefinition.llm, `bots[${index}].llm`);

  return {
    index,
    name,
    mattermost: {
      ...defaultMattermost,
      ...botMattermost,
    },
    llm: {
      ...defaultLlm,
      ...botLlm,
      images: mergeOptionalNestedObject(defaultLlm.images, botLlm.images),
    },
  };
}

function buildRuntimeBotConfig(mergedBot, env) {
  const botLabel = `Bot "${mergedBot.name}"`;
  const mattermostUrl = normalizeMattermostUrl(
    normalizeRequiredString(mergedBot.mattermost.url, `${botLabel} mattermost.url`),
    `${botLabel} mattermost.url`,
  );
  const provider = normalizeOptionalString(
    mergedBot.llm.provider,
    `${botLabel} llm.provider`,
    'openai',
  );

  if (provider !== 'openai') {
    throw new Error(
      `${botLabel} llm.provider "${provider}" is not supported. Only "openai" is supported.`,
    );
  }

  const apiUrl = normalizeOpenAIBaseUrl(
    normalizeOptionalString(
      mergedBot.llm.baseUrl,
      `${botLabel} llm.baseUrl`,
      DEFAULT_OPENAI_BASE_URL,
    ),
    `${botLabel} llm.baseUrl`,
  );
  const envSuffix = normalizeBotEnvName(mergedBot.name);

  return {
    name: mergedBot.name,
    mattermost: {
      url: mattermostUrl,
      token: readBotSecret(env, `BOT_${envSuffix}_TOKEN`, botLabel),
      typingIntervalMs: 1000,
    },
    llm: {
      provider,
      apiKey: readBotSecret(env, `BOT_${envSuffix}_LLM_API_KEY`, botLabel),
      model: normalizeRequiredString(mergedBot.llm.model, `${botLabel} llm.model`),
      stream: parseBooleanLike(mergedBot.llm.stream, `${botLabel} llm.stream`, true),
      apiUrl,
      images: {
        maxLongEdge: normalizeMaxLongEdge(
          getOptionalObject(mergedBot.llm.images, `${botLabel} llm.images`).maxLongEdge,
          `${botLabel} llm.images.maxLongEdge`,
        ),
      },
      reasoningEffort: normalizeOptionalString(
        mergedBot.llm.reasoningEffort,
        `${botLabel} llm.reasoningEffort`,
        null,
      ),
      verbosity: normalizeOptionalString(
        mergedBot.llm.verbosity,
        `${botLabel} llm.verbosity`,
        null,
      ),
      streamUpdateIntervalMs: 1000,
    },
  };
}

export function normalizeBotEnvName(name) {
  return normalizeRequiredString(name, 'bot name')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
}

export function loadConfig(env = process.env, options = {}) {
  const { cwd = process.cwd(), readFileSyncImpl = readFileSync } = options;
  const configPath = resolvePath(
    cwd,
    readEnvStringWithDefault(env, 'BOT_CONFIG_PATH', DEFAULT_CONFIG_PATH),
  );
  const configRoot = getConfigRoot(configPath, readFileSyncImpl);
  const defaults = getOptionalObject(configRoot.defaults, 'defaults');
  const bots = configRoot.bots;

  if (!Array.isArray(bots)) {
    throw new Error(`Bot config at ${configPath} must contain a "bots" array.`);
  }

  if (bots.length === 0) {
    throw new Error(`Bot config at ${configPath} must define at least one bot.`);
  }

  const mergedDefaults = {
    mattermost: getOptionalObject(defaults.mattermost, 'defaults.mattermost'),
    llm: getOptionalObject(defaults.llm, 'defaults.llm'),
  };
  const mergedBots = bots.map((botDefinition, index) =>
    mergeBotDefinition(mergedDefaults, botDefinition, index),
  );
  const seenNames = new Set();
  const seenEnvNames = new Map();

  for (const mergedBot of mergedBots) {
    if (seenNames.has(mergedBot.name)) {
      throw new Error(`Bot name "${mergedBot.name}" is duplicated.`);
    }

    seenNames.add(mergedBot.name);

    const envName = normalizeBotEnvName(mergedBot.name);
    const existingBotName = seenEnvNames.get(envName);

    if (existingBotName) {
      throw new Error(
        `Bot names "${existingBotName}" and "${mergedBot.name}" resolve to the same environment variable prefix BOT_${envName}_*.`,
      );
    }

    seenEnvNames.set(envName, mergedBot.name);
  }

  const runtimeBots = mergedBots.map((mergedBot) => buildRuntimeBotConfig(mergedBot, env));

  return deepFreeze({
    configPath,
    bots: runtimeBots,
  });
}
