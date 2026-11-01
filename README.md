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
# If better-sqlite3 fails to build on your Node version, restore the bundled binding:
cp better_sqlite3.compat.node node_modules/better-sqlite3/build/Release/better_sqlite3.node
npm start
```

The bot uses a persistent SQLite memory database and loads its fixed character
instructions from `personality.txt`. It never rewrites that file.

The static expression layer in `src/aliveness.js` follows the personality and
is expanded with a local hourly mood, time, and last-speech state. Her clock
runs on Philippine time (`TIMEZONE`, default `Asia/Manila`). Replies of eight
words or fewer may be delayed by 1-4 seconds; short reaction-style replies may
also receive a random emoji reaction.

Spontaneous conversation openers only target channels where real human
conversation happened in the last 24 hours (at least three human messages that
are not bot-game commands). Quiet channels and bot-game channels such as
Karuta are left alone; she never starts conversations there.

She recognizes people: every reply carries who is speaking (display name and
@username), how close she feels to them (affinity grows with each interaction),
when they last really talked, and what she knows about them. Facts are keyed
by Discord user ID, so she still recognizes someone after a rename. A live
roster of recent members is injected into every reply, so questions like
"what's his username?" can be answered, and raw @mention markup is rendered
into readable names (`<@123>` → `@Jake`) before the model or her memory ever
sees it. Pronouns like "he/his" resolve to the last person who spoke.

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

Prompt context is bounded to a configurable model budget so large channels
remain safe. `MEMORY_CONTEXT_TOKENS` defaults to 32000 and allocates space
between recent messages, relevant retrieved memories, facts, personality, and
reply context. The database can retain far more history than the prompt budget;
older history is prioritized through summaries, facts, and relevance-ranked
retrieval rather than loading every raw message.

Keep these files outside deployment archive replacement:

- `memory.db` - persistent SQLite messages, facts, summaries, relationships, and self-model
- `data/channel-memory.json` - recent channel history and channel facts

Do not delete or extract over either of these directories during bot updates.

Configured environment variables include:

- `DB_PATH`
- `PERSONALITY_PATH`
- `ADMIN_USER_IDS`
- `NVIDIA_API_KEYS` (optional key pool, comma-separated)
- `TIMEZONE` / `TIMEZONE_LABEL` (default `Asia/Manila` / `PHT`)

Admin-only slash commands are `/memory_stats`, `/memories`, `/forget_all`, and
`/reflect_now`.

To run the memory round-trip smoke test:

```bash
npm run smoke
```

To verify an old database upgrades cleanly in place:

```bash
node migration-check.mjs
```
