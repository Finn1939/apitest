# Human Discord Bot

A configurable Discord chat and research bot. It can chat conversationally, responds when mentioned, and answers search requests using the `t` prefix.

## Setup

1. Create a Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, enable **Message Content Intent**.
3. Invite the bot with `bot` permissions and the permission to read/send messages.
4. Create a [NVIDIA API key](https://build.nvidia.com/) for the NVIDIA API Catalog.
5. Install Node.js 20 or newer.
6. Copy `.env.example` to `.env` and fill in the values.

```bash
npm install
npm start
```

The bot uses a persistent SQLite memory database and loads its fixed character
instructions from `personality.txt`. It never rewrites that file.

The static expression layer in `src/aliveness.js` follows the personality and
is expanded with a local hourly mood, time, and last-speech state. Replies of
eight words or fewer may be delayed by 1-4 seconds; short reaction-style replies
may also receive a random emoji reaction.

## Persistent memory

All visible messages are stored immediately in `memory.db`. Embeddings are
generated locally by `@huggingface/transformers` and searched alongside FTS5
text matches. Summaries and facts are consolidated in the background, while
live replies are left unaffected by memory jobs.

Configured environment variables include:

- `DB_PATH`
- `PERSONALITY_PATH`
- `ADMIN_USER_IDS`

Admin-only slash commands are `/memory_stats`, `/memories`, `/forget_all`, and
`/reflect_now`.

To run the memory round-trip smoke test:

```bash
npm run smoke
```

RSS is logged every 10 minutes. Keep it below 550 MB; if local embedding usage
pushes it too high, disable the local embedder and use NVIDIA's `/embeddings`
endpoint instead.

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