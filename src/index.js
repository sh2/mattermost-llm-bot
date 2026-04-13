import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBot } from './bots/chat-bot.js';
import { loadConfig } from './config.js';
import { MattermostService } from './mattermost/client.js';
import { OpenAIRestClient } from './openai/rest-client.js';

export function createPrefixedLogger(botName, logger = console) {
  const prefix = `[${botName}]`;

  return {
    info: (...args) => logger.info(prefix, ...args),
    warn: (...args) => logger.warn(prefix, ...args),
    error: (...args) => logger.error(prefix, ...args),
  };
}

function createLLMClient(botConfig, logger = console) {
  if (botConfig.llm.provider !== 'openai') {
    throw new Error(
      `Unsupported llm.provider "${botConfig.llm.provider}" for bot "${botConfig.name}".`,
    );
  }

  return new OpenAIRestClient(botConfig.llm, undefined, logger);
}

export function createRuntimeBundle(botConfig, options = {}) {
  const {
    baseLogger = console,
    loggerFactory = createPrefixedLogger,
    mattermostFactory = (config, logger) => new MattermostService(config.mattermost, logger),
    llmFactory = (config, logger) => createLLMClient(config, logger),
    botFactory = ({ mattermost, llm, config, logger }) =>
      new ChatBot({ mattermost, llm, config, logger }),
  } = options;
  const logger = loggerFactory(botConfig.name, baseLogger);
  const mattermost = mattermostFactory(botConfig, logger);
  const llm = llmFactory(botConfig, logger);
  const bot = botFactory({
    mattermost,
    llm,
    config: botConfig,
    logger,
  });

  return {
    name: botConfig.name,
    config: botConfig,
    mattermost,
    llm,
    bot,
    logger,
  };
}

export async function stopBotBundles(bundles, logger = console) {
  for (const bundle of [...bundles].reverse()) {
    try {
      await bundle.bot.stop();
    } catch (error) {
      logger.error(`[${bundle.name}] Failed to stop bot.`, error);
    }
  }
}

export async function startBotBundles(bundles, logger = console) {
  const startedBundles = [];

  for (const bundle of bundles) {
    try {
      await bundle.bot.start();
      startedBundles.push(bundle);
    } catch (error) {
      try {
        await bundle.bot.stop();
      } catch (stopError) {
        logger.error(
          `[${bundle.name}] Failed to stop bot during startup rollback.`,
          stopError,
        );
      }

      await stopBotBundles(startedBundles, logger);
      throw error;
    }
  }

  logger.info(
    `Started ${bundles.length} Mattermost bot(s): ${bundles.map(({ name }) => name).join(', ')}`,
  );
}

export function registerSignalHandlers({ processRef = process, shutdown }) {
  const listeners = new Map();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => shutdown(signal);
    listeners.set(signal, listener);
    processRef.once(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) {
      processRef.removeListener(signal, listener);
    }
  };
}

export async function startRuntime(options = {}) {
  const {
    env = process.env,
    logger = console,
    processRef = process,
    loadConfigImpl = loadConfig,
    bundleFactory = createRuntimeBundle,
    mattermostFactory,
    llmFactory,
    botFactory,
    loggerFactory,
  } = options;
  const config = loadConfigImpl(env);
  const bundles = config.bots.map((botConfig) =>
    bundleFactory(botConfig, {
      baseLogger: logger,
      mattermostFactory,
      llmFactory,
      botFactory,
      loggerFactory,
    }),
  );
  let shuttingDown = false;
  let unregisterSignalHandlers = () => {};

  const shutdown = async ({ signal, exitCode } = {}) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    unregisterSignalHandlers();

    if (signal) {
      logger.info(`Signal ${signal} received.`);
    }

    await stopBotBundles(bundles, logger);

    if (exitCode !== undefined) {
      processRef.exit(exitCode);
    }
  };

  unregisterSignalHandlers = registerSignalHandlers({
    processRef,
    shutdown: (signal) => shutdown({ signal, exitCode: 0 }),
  });

  try {
    await startBotBundles(bundles, logger);
  } catch (error) {
    unregisterSignalHandlers();
    throw error;
  }

  return {
    config,
    bundles,
    shutdown: () => shutdown(),
  };
}

export async function main() {
  await startRuntime();
}

const isMainModule = process.argv[1]
  && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
