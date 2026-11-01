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

Game-bot panels are visible to her: when another bot answers with embeds and
buttons (OwO's HighLow card, for example), the panel is flattened into
readable text in her memory, so "can you help me decide?" gets a real answer
about the actual card and payouts. A short pointer like "here @OwO" is
understood as showing her that bot's message above, not as a command for that
bot. HighLow-style commands (`whl`, `hl`, `highlow`) are treated as game
traffic and never answered as conversation.

She sees the whole conversation, not just plain text:

- **Images** — when someone sends her a photo while talking to her, she
  actually looks at it (the model is vision-language capable). Photos are
  downscaled locally with sharp before being sent, so payloads stay small and
  it costs no extra API request. Her description of the image is stored as
  part of the conversation, which is how she remembers what she saw.
- **Attachments, stickers, polls** — everything she cannot open (videos,
  voice messages, files) is still recorded as readable metadata:
  `[attached: voice message (audio/ogg, 88 KB, 14s)]`, `[sticker: Sadge]`,
  `[poll: Movie night? — options: Yes, No]`.
- **Emoji reactions** — reactions on her messages are noticed and included in
  her next reply's context. What each reaction meant is decided by a small AI
  judgment call (see below), so a heart on a flirty joke lands differently
  than a heart on homework help — both on the romance axis and in how she
  words her next reply.
- **Edited and deleted messages** — when someone edits a message, her stored
  copy becomes the current text (marked `(edited)`, so she can tease about
  it); deletions never erase what she saw — the memory is kept and marked
  `(deleted)`. Game-bot panels that edit in place (a HighLow card changing)
  keep her view current too.

### AI judgment layer

Beyond composing replies, the same model makes small structured judgments
(strict-JSON in, validated out) that make her decisions smarter than regexes:

- **Reaction interpretation** — reactions on her messages queue up and are
  interpreted in one batched call, with the message text they landed on, the
  recent channel conversation, and what she knows about whoever reacted. The
  result sets how much romance (if any) the reaction carries, whether she
  mirrors a small emoji back onto her own message, and a short note that
  becomes a durable memory — so the diary remembers *why* the heart felt
  nice, not just that it happened. Meanings surface in her reply context
  ("❤️ from Ren — flirty teasing").
- **Game-channel spectating** — when a game bot posts a panel with a
  win/loss-worthy signal (jackpot, bankruptcy, all-in), she occasionally
  asks whether the moment deserves ONE spectator comment — teasing an epic
  loss, celebrating a big win. A per-channel cooldown and a probability gate
  keep it rare; the judgment can always decide to stay silent.
- **Command learning** — the same game judgment can recognize the command
  word that triggered a bot's panel ("whl", "daily"), validate it strictly
  (short alphanumeric, provably the start of the human message right before
  the panel, never a pointer word like "here"), and persist it to the
  `learned_commands` table. The game-traffic filter grows on its own — the
  "whl" fix, automated for the next game bot.

Judgment calls share the 3-key pool with replies but have their own sliding
budget (default 10 calls/min — about 8% of 120 RPM), so live replies always
keep priority. Every failure mode — budget spent, API down, malformed JSON,
  wrong shape — falls back to the previous deterministic rules; analysis
  enhances behavior, it never gates it. `/status` shows how many judgments
  ran and how many fell back.

All judgment settings are optional environment variables with working
defaults: `ANALYSIS_ENABLED` (`false` disables the whole layer, reactions fall
back to the flat heart rule), `ANALYSIS_MAX_PER_MIN`,
`REACTION_FLUSH_MINUTES`, `GAME_WATCH_CHANCE`, `GAME_WATCH_COOLDOWN_MINUTES`.

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

Slash commands everyone can use:

- `/help` — how to talk to her plus the full command list
- `/relationship` — how she feels about you (friendship tier and, if real,
  romance; admins can pass a user to inspect someone else)
- `/status` — uptime, ping, model, and memory stats
- `/diary` — her latest diary entry

Admin-only slash commands are `/memory_stats`, `/memories`, `/forget_all`,
`/forget_fact`, `/friends`, `/reflect_now`, and `/reload_personality` (re-reads
`personality.txt` without a restart). `/forget_fact <user> <text>` removes only
the matching facts, unlike `/forget_all` which forgets a person completely.

To run the memory round-trip smoke test:

```bash
npm run smoke
```

To verify an old database upgrades cleanly in place:

```bash
node migration-check.mjs
```
