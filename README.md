# Mattermost LLM Bot

A Mattermost chat bot implemented in JavaScript for Node.js. It connects to Mattermost with `@mattermost/client` and calls the OpenAI REST API directly without using the SDK.

## Features

- Runs multiple Mattermost bots in a single Node.js process
- Responds to new posts in a thread when each bot is mentioned anywhere in that thread
- Ignores senders whose normalized sender name starts with `ai-`
- Uses the channel header as the system prompt
- Reflects OpenAI streaming responses to Mattermost posts about once per second
- Sends typing notifications to Mattermost while generating a response
- Forwards image attachments in a thread to the LLM as multimodal `image_url` parts

## Setup

Requires Node.js 20 or newer.

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
      "baseUrl": "https://api.openai.com/v1",
      "stream": true
    }
  },
  "bots": [
    {
      "name": "support-ja",
      "llm": {
        "model": "gpt-5.4-mini"
      }
    },
    {
      "name": "review-en",
      "llm": {
        "model": "gpt-5.4",
        "reasoningEffort": "high",
        "verbosity": "medium"
      }
    }
  ]
}
```

`llm.reasoningEffort` and `llm.verbosity` are optional per-bot settings:

- Omit them entirely when the target endpoint does not support them. In that case, the bot does **not** send the `reasoning_effort` or `verbosity` request parameters at all.
- Set them under each bot's `llm` block when you want to enable them for a specific bot, like `review-en` in the example above.
- The JSON config uses `reasoningEffort` / `verbosity`, and those are translated to `reasoning_effort` / `verbosity` in the OpenAI-compatible HTTP request only when values are explicitly configured.

### Image Attachments

When a post in a thread has image attachments (`mime_type` starting with `image/`), the bot downloads each image, resizes it so the long edge is at most `llm.images.maxLongEdge` pixels, converts it to JPEG, and embeds it as a base64 data URL in the corresponding message's `content` array. Non-image attachments are ignored. If a single image fails to download or process, that image is skipped with a warning log and the rest of the thread is still sent to the LLM.

`llm.images.maxLongEdge` is an optional per-bot (or default) setting:

- Omit it to use the default of `1536`, which fits within the natural long-edge limits of OpenAI Vision, Gemini, and Anthropic Claude without triggering provider-side rescaling.
- Set it to a positive integer to override the resize cap, e.g. `1024` for stricter limits.
- Fractional, zero, negative, or non-numeric values are rejected at config load time.

```json
{
  "bots": [
    {
      "name": "support-ja",
      "llm": {
        "model": "gpt-5.4-mini",
        "images": {
          "maxLongEdge": 1024
        }
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
- Image attachments are downloaded via the Mattermost file API, resized with `sharp` (long edge capped at `llm.images.maxLongEdge`, flattened onto a white background, and re-encoded as JPEG at quality 80), then sent as `image_url` data URL parts. The OpenAI `detail` parameter is omitted so the provider defaults to `auto`.
- No Dockerfile or container run instructions are included
