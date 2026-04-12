import { ChatBot } from './bots/chat-bot.js';
import { loadConfig } from './config.js';
import { MattermostService } from './mattermost/client.js';
import { OpenAIRestClient } from './openai/rest-client.js';

async function main() {
  const config = loadConfig();
  const mattermost = new MattermostService(config.mattermost);
  const openai = new OpenAIRestClient(config.openai);
  const bot = new ChatBot({ mattermost, openai, config });

  const shutdown = async (signal) => {
    console.info(`Signal ${signal} received.`);
    await bot.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await bot.start();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
