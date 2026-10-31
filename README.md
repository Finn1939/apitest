# Human Discord Bot

A configurable Discord chat and research bot. It can chat conversationally, responds when mentioned, and answers search requests using the `t` prefix.

## Setup

1. Create a Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, enable **Message Content Intent**.
3. Invite the bot with `bot` permissions and the permission to read/send messages.
4. Create a [NVIDIA API key](https://build.nvidia.com/) for the NVIDIA API Catalog.
5. Install Node.js 18 or newer.
6. Copy `.env.example` to `.env` and fill in the values.

```bash
npm install
npm start
```

## Usage

Chat naturally by mentioning the bot:

```text
@Bot what are you up to?
```

Search and answer questions with the configured prefix:

```text
t hey whats the definition of tweak?
```

The `t` request performs a DuckDuckGo search, gives the results to the AI, and responds in your configured personality.

## Personality

Set `BOT_PERSONALITY` in `.env`. For example:

```dotenv
BOT_PERSONALITY=Warm, sarcastic, highly curious, and playful. Use short replies with occasional dry humor.
```

To change the command prefix, set `BOT_PREFIX`, then restart the bot:

```dotenv
BOT_PREFIX=task
```

## Memory

The bot keeps the latest 30 messages per channel in memory and can use explicitly saved channel facts:

- Mention the bot followed by `remember: ...` to save a fact.
- Mention the bot followed by `clear memory` to remove that channel's recent history and facts.

Recent history and remembered facts are saved to `data/channel-memory.json`, so they survive restarts. This file is ignored by Git. Channel history is limited to the latest 30 messages, while facts are limited to 100 per channel.