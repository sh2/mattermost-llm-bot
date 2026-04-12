# Mattermost LLM Bot

A Mattermost chat bot implemented in JavaScript for Node.js. It connects to Mattermost with `@mattermost/client` and calls the OpenAI REST API directly without using the SDK.

## Features

- Responds to new posts in a thread when the bot is mentioned anywhere in that thread
- Ignores bots whose sender name starts with `ai-`
- Uses the channel header as the system prompt
- Reflects OpenAI streaming responses to Mattermost posts about once per second
- Sends typing notifications to Mattermost while generating a response

## Setup

```bash
npm install
cp .env.example .env
```

Set the required values in `.env` and start the bot:

```bash
npm start
```

## Environment Variables

| Name | Required | Default | Description |
| ---- | ---- | ---- | ---- |
| `MATTERMOST_URL` | yes | - | Mattermost base URL in the form `http://host:8065` |
| `BOT_TOKEN` | yes | - | Mattermost bot token |
| `OPENAI_API_KEY` | yes | - | OpenAI API key |
| `OPENAI_MODEL` | yes | - | OpenAI model name to use |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Base URL for OpenAI / Azure OpenAI. Do not include `/chat/completions` |
| `OPENAI_STREAM` | no | `true` | Set to `false` to disable streaming replies |
| `OPENAI_REASONING_EFFORT` | no | `medium` | `reasoning_effort` for Chat Completions requests |
| `OPENAI_VERBOSITY` | no | `medium` | `verbosity` for Chat Completions requests |

## Implementation Notes

- The Mattermost WebSocket uses `@mattermost/client`'s `WebSocketClient`
- OpenAI accepts `OPENAI_BASE_URL` as the base URL and appends `/chat/completions` internally
- Example Azure OpenAI base URL: `https://sh2oai05.openai.azure.com/openai/v1`
- No Dockerfile or container run instructions are included
