# Mattermost LLM Bot

A Mattermost chat bot implemented in JavaScript for Node.js. It connects to Mattermost with `@mattermost/client` and calls the OpenAI REST API directly without using the SDK.

## Features

- Runs multiple Mattermost bots in a single Node.js process
- Responds to new posts in a thread when each bot is mentioned anywhere in that thread
- Ignores senders whose normalized sender name starts with `ai-`
- Uses the channel header as the system prompt
- Reflects OpenAI streaming responses to Mattermost posts about once per second
- Sends typing notifications to Mattermost while generating a response

## Setup

```bash
npm install
cp .env.example .env
cp config/bots.json.example config/bots.json
```

Edit `config/bots.json` for non-secret settings, set the matching secrets in `.env`, and start the bot:

```bash
npm start
```

The default `config/bots.json` looks like this:

```json
{
  "defaults": {
    "mattermost": {
      "url": "http://127.0.0.1:8065"
    },
    "llm": {
      "provider": "openai",
      "compatibilityProfile": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "stream": true,
      "reasoningEffort": "medium",
      "verbosity": "medium"
    }
  },
  "bots": [
    {
      "name": "support-ja",
      "llm": {
        "model": "gpt-5.4-mini"
      }
    }
  ]
}
```

## Environment Variables

| Name | Required | Default | Description |
| ---- | ---- | ---- | ---- |
| `BOT_CONFIG_PATH` | no | `./config/bots.json` | Path to the JSON bot config file |
| `BOT_<BOT_NAME>_TOKEN` | yes | - | Mattermost bot token for one bot |
| `BOT_<BOT_NAME>_LLM_API_KEY` | yes | - | OpenAI-compatible API key for one bot |

`<BOT_NAME>` is derived from `bots[].name` by uppercasing it and replacing non-alphanumeric characters with `_`.

Examples:

- `support-ja` -> `BOT_SUPPORT_JA_TOKEN`, `BOT_SUPPORT_JA_LLM_API_KEY`
- `review-en` -> `BOT_REVIEW_EN_TOKEN`, `BOT_REVIEW_EN_LLM_API_KEY`

## Implementation Notes

- The Mattermost WebSocket uses `@mattermost/client`'s `WebSocketClient`
- The JSON config accepts an OpenAI-compatible `llm.baseUrl` and appends `/chat/completions` internally
- `llm.provider` currently supports only `openai`
- No Dockerfile or container run instructions are included
