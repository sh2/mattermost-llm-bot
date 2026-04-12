# Project Guidelines

## Build and Test
- Install dependencies with `npm install`.
- Run tests with `npm test`.
- Start the bot with `npm start`.
- Use Node.js 20 or newer. This repository is ESM-only (`"type": "module"`).

## Architecture
- `src/index.js` wires configuration, Mattermost integration, OpenAI integration, and bot startup/shutdown.
- `src/config.js` owns environment loading, validation, URL normalization, and frozen runtime config.
- `src/bots/chat-bot.js` owns reply behavior, thread/message transformation, streaming updates, and error reporting.
- `src/mattermost/client.js` is the Mattermost adapter boundary.
- `src/openai/rest-client.js` is the OpenAI adapter boundary and uses direct REST calls, not the official SDK.

## Conventions
- Keep OpenAI integration on the existing REST client path in `src/openai/rest-client.js`; do not replace it with the SDK unless requested.

## Working Guidance
- Prefer small edits inside existing module boundaries rather than broad refactors.
