# Environment setup

For an upgrade, keep your existing `.env`, database, and memory files. Review the current `.env.example` for new options, then restart the bot after changing configuration. Do not replace a custom personality file unless you want to use the included `personality.txt`.

For a new install, copy `.env.minimal.example` to `.env` and set `DISCORD_TOKEN`, `GEMINI_API_KEY` (or an NVIDIA/OpenAI-compatible provider key), and `COMMAND_USER_IDS`. Use numeric Discord user IDs; separate multiple IDs with commas. A blank `COMMAND_USER_IDS` disables server-action commands, but does not disable ordinary chat.

The `.env.example` documents optional provider, autonomy, server-sync, memory, analysis, and generation settings. `AI_PROVIDER=auto` uses Gemini for chat when `GEMINI_API_KEY` is configured; otherwise it uses the NVIDIA/OpenAI-compatible settings. Set `AI_PROVIDER=openai` to force NVIDIA for text chat even when Gemini is configured.

To use **NVIDIA for chat and Fish Audio for Discord voice**, set `AI_PROVIDER=openai`, configure `NVIDIA_API_KEY` (and `AI_API_URL` / `AI_MODEL` if needed), then set `FISH_AUDIO_API_KEY` and `FISH_AUDIO_REFERENCE_ID`. The Python bot streams Discord audio to Fish's realtime transcription API, sends completed user turns to the selected chat provider, and streams Fish TTS audio back into Discord. `FISH_ASR_MODEL` defaults to the preview model `transcribe-stream-1`; `FISH_TTS_MODEL` defaults to `s2.1-pro-free`. Live transcription is billed per session duration according to Fish Audio's plan. Voice is implemented by the Python bot, not the Node bot: install `python/requirements.txt` and run `python python/bot.py`. Stop the Node process first; only one bot process should connect with the same Discord token. In Discord, use `/vc_join`, then talk to Capri or use `/vc_say`; use `/vc_leave` when finished. Never commit or share `.env`.

If you pasted a Fish Audio API key into chat or another shared place, revoke it and create a replacement. Store the replacement only in `.env` as `FISH_AUDIO_API_KEY`; do not send it in chat or commit it.

Only allow trusted user IDs to issue server actions. `ALLOW_GUILD_ADMINS` and `COMMAND_TRUST_LEVEL` control additional command authorization; they do not grant the bot Discord permissions it does not have. Discord permission and role-hierarchy checks still apply. Supported destructive deletions and purges require the interactive confirmation described in [DISCORD_ACTIONS.md](./DISCORD_ACTIONS.md).
