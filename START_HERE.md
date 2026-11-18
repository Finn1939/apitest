# Capri Discord Bot

## Python upgrade

Use the Python launcher for persona-aware replies and downloadable study guides. Install with
`python -m pip install -r python/requirements.txt`, then run `python python/bot.py`.
In your existing `.env`, set `USERID` to your numeric Discord ID for single-controller mode.
The Python launcher keeps the existing `COMMAND_USER_IDS` and `ALLOW_GUILD_ADMINS` rules when
`USERID` is empty. Anyone can chat. Only controllers can request file generation.
Give Capri Send Messages, Read Message History, and Attach Files in the destination channel.
Run only one launcher with the token.

Try **Capri, make me a reviewer on SQL stored procedures** or attach a lecture PDF with
selectable text and say **Turn this into study notes**. See [the Python change summary](PYTHON_UPGRADE.md).

## Node.js setup
1. Install Node.js 20 or newer.
2. Install dependencies with `npm install`.
3. Copy `.env.minimal.example` to `.env` and configure the Discord token, AI provider key, and authorized Discord user IDs. See [ENV_SETUP.md](./ENV_SETUP.md).
4. Enable Message Content and Server Members intents in the Discord Developer Portal. Grant the bot only the Discord permissions needed for the actions you intend to use; see [DISCORD_ACTIONS.md](./DISCORD_ACTIONS.md).
5. Run `npm test`, then `npm start`. Back up the database and memory files before upgrades.

## Python alternative

The archive also includes a `discord.py` implementation. Install its dependencies with `pip install -r python/requirements.txt`, run `python python/test_actions_schema.py`, then start it with `python python/bot.py`. It uses the same `.env`, personality file, and memory database; run only one bot implementation at a time.

## Try it
- Ask Capri to create a role and assign it to a member.
- Ask her to rename a channel or set a slowmode.
- Ask her to post a message or inspect the server.

Use unambiguous member/channel references. Supported server actions require authorization and the relevant Discord permissions. Destructive delete and purge operations pause for interactive confirmation; see [DISCORD_ACTIONS.md](./DISCORD_ACTIONS.md) for action coverage and execution policy.

The project also includes autonomous chat behavior, multimodal context handling, and persistent memory. Configuration options are documented in `.env.example`.
