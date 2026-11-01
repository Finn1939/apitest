# Human Discord Bot

A configurable Discord chat and research bot. It can chat conversationally, responds when mentioned, and answers search requests using the `t` prefix.

## Setup

1. Create a Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, enable **Message Content Intent**.
3. Invite the bot with `bot` permissions and the permission to read/send messages.
4. Create a [NVIDIA API key](https://build.nvidia.com/) for the NVIDIA API Catalog.
5. Install Node.js 19 or newer.
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

Spontaneous conversation openers only target channels where real human
conversation happened in the last 24 hours (at least three human messages that
are not bot-game commands). Quiet channels and bot-game channels such as
Karuta are left alone; she never starts conversations there.

She recognizes people: every reply carries who is speaking, how close she
feels to them (affinity grows with each interaction), when they last really
talked, and what she knows about them. Facts are keyed by Discord user ID,
so she still recognizes someone after a rename. Her clock runs on Philippine
time (set `TIMEZONE` to change it).

## Persistent memory

All visible messages are stored immediately in `memory.db`, including the bot's
own replies. Embeddings are generated locally by `@huggingface/transformers`
(all-MiniLM-L6-v2, 384 dimensions) and semantic KNN search runs through the
`sqlite-vec` virtual table, fused with FTS5 keyword matches and scored by
relevance, recency, and importance. Retrieval is scoped per guild so memories
never leak across servers. Durable facts are keyed by Discord user ID,
reinforced (not duplicated) when re-observed, and decay only once per day.
When someone asks about the past ("remember", "back when", ...), retrieval
digs deeper automatically. Summaries and facts are consolidated in the
background, and a nightly journal entry feeds the weekly self-reflection.

Keep these files outside deployment archive replacement:

- `memory.db` - persistent SQLite messages, facts, summaries, relationships, and self-model
- `data/channel-memory.json` - recent channel history and channel facts

Do not delete or extract over either of these directories during bot updates.

Configured environment variables include:

- `DB_PATH`
- `PERSONALITY_PATH`
- `ADMIN_USER_IDS`
- `NVIDIA_API_KEYS` (optional key pool, comma-separated)

Admin-only slash commands are `/memory_stats`, `/memories`, `/forget_all`, and
`/reflect_now`.

To run the memory round-trip smoke test:

```bash
npm run smoke
```

Embeddings run locally (no embedding API calls). The only external calls are
chat completions against the model configured in `AI_MODEL` (default
`nvidia/nemotron-3.5-super-vl-120b-a12b` on build.nvidia.com). Live replies
stream token-by-token with thinking disabled for speed; background jobs
(consolidation, reflection, journal) run with thinking enabled. RSS is logged
every 10 minutes and should remain below 550 MB.

## API keys

Set a single key with `NVIDIA_API_KEY`, or a comma-separated pool with
`NVIDIA_API_KEYS=key1,key2,key3` to spread requests across several keys. The
pool round-robins requests, spaces them out to stay under each key's rate
limit, cools a key down on 429 (respecting Retry-After), and disables keys
that return 401/403. All keys hit the same model and endpoint.

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