# Capri (Cyberpunk: Edgerunners 2) — Autonomous Discord Takeover Bot

Capri is a living, autonomous Discord persona with full-server CRUD control, deep member/channel awareness, multimodal media reading, and hybrid SQLite + vector memory.

## Key Upgrades
- **Full Server Control (Create, Read, Update, Delete)**: Manages servers, roles, channels, categories, permission overwrites (lock/hide/allow/deny), members, bans, timeouts, voice moves/mutes/deafens, messages, bulk purges, threads, webhooks, emojis, stickers, scheduled events, AutoMod rules, invites, and audit logs.
- **Confirm-Gated Deletes, Instant Everything Else**: All create/read/update/moderation operations execute immediately. Any destructive deletion or purge pauses behind interactive **Confirm deletion** and **Cancel** buttons.
- **Casual Chat Commands**: No rigid command syntax or prefix required. Chat normally and embed requests mid-sentence — Capri executes the server actions and weaves the real outcome into her reply.
- **Autonomous Living Mind**: Tracks mood, energy, and conversation momentum; chimes into active chats on her own, welcomes new members, reacts silently with emojis like a real lurking member, and never waits solely for @mentions.
- **Multimodal & Context Awareness**: Reads images (including replied-to messages and link embeds), attached code/text/log files, embeds/buttons/polls/stickers, and (with Gemini) native audio voice notes, video clips, and PDFs.
- **Full Member & Topology Directory**: Syncs every member in the server (`GuildMembers` intent), roles, nicknames, and voice presence into SQLite (`guild_members` + `guild_state`) alongside `sqlite-vec` + FTS5 hybrid memory.
- **Dual AI Provider**: Supports **Google Gemini (`GEMINI_API_KEY`)** out of the box AND **NVIDIA / OpenAI-compatible endpoints (`NVIDIA_API_KEYS`)**.

## Quick setup (Python `discord.py`, default)
For a complete fresh-clone, update, and voice setup walkthrough, see
[Pull and run Capri](./RUN_BOT.md).

1. **Install Python dependencies**:
   ```bash
   python -m pip install -r python/requirements.txt
   ```
2. **Enable Discord Bot Intents** in the [Discord Developer Portal](https://discord.com/developers/applications) under **Bot -> Privileged Gateway Intents**:
   - **Presence Intent** (optional)
   - **Server Members Intent** (REQUIRED so Capri knows every member)
   - **Message Content Intent** (REQUIRED)
3. **Configure `.env`**:
   ```bash
   cp .env.minimal.example .env
   ```
   Fill in `DISCORD_TOKEN`, `GEMINI_API_KEY` (or `NVIDIA_API_KEY`), and `COMMAND_USER_IDS`.
4. **Run tests & start the Python bot**:
   ```bash
   python -m unittest discover -s python
   npm start
   ```

## Node.js alternative

The `discord.js` implementation remains available. Install Node.js 20+ and the npm
dependencies, then use `npm run start:node` instead of `npm start`:
```bash
npm install
npm test
npm run start:node
```

## Python voice features

The Python implementation reads the same `.env`, `personality.txt`, and `memory.db`:
```bash
pip install -r python/requirements.txt
python python/test_actions_schema.py
python python/test_voice_live.py
python python/test_provider_config.py
python python/test_memory_store.py
python python/bot.py
```
- **Live VC usage**: Use `/vc_join` to connect, speak naturally for a reply, `/vc_say` to request speech, `/vc_beep` to play a generated two-second playback test without calling a TTS API, `/vc_status` to inspect voice state and audio diagnostics, and `/vc_leave` to disconnect. Gemini Live Transcription recognizes user turns; only recognized turns are sent to chat.
- **Voice fallback**: If no voice audio arrives within 30 seconds, Capri posts a text-chat hint. If ASR is unavailable, `/vc_say` can still connect in TTS-only mode; failed speech replies are sent as text instead.
- **Voice providers**: Set `GEMINI_API_KEY` for live transcription and `FISH_AUDIO_API_KEY` plus `FISH_AUDIO_REFERENCE_ID` for the selected Fish TTS voice. With `AI_PROVIDER=openai`, NVIDIA handles the chat response between transcription and TTS.
- **Python voice runtime**: Install `python/requirements.txt` and run `python python/bot.py`; the Node bot does not support voice channels. See [ENV_SETUP.md](./ENV_SETUP.md).
- **Minimal Storage**: Streams audio purely in RAM (~35 MB for Python voice packages + system `libopus`/`ffmpeg`, 0 MB audio saved to disk; only text transcripts go to SQLite).
