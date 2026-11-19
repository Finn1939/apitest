# Pull and run Capri

## 1. Get the code

For a fresh checkout:

```bash
git clone https://github.com/Finn1939/apitest.git
cd apitest
```

For an existing checkout, first preserve any local changes you need, then update:

```bash
git pull --ff-only origin main
```

## 2. Install Python

The default bot is Python (`npm start` runs `python python/bot.py`). Use Python 3.10 or newer.
Create a virtual environment and install the bot dependencies from the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r python/requirements.txt
```

On Windows, activate with `.venv\Scripts\activate` and use `py -3` instead of `python3` if needed.
For Discord voice on Debian or Ubuntu, install the system Opus library:

```bash
sudo apt-get update
sudo apt-get install -y libopus0
```

Other Linux distributions need their equivalent Opus runtime package. The bot reports a clear
error on startup if the library is missing when joining voice.

## 3. Configure credentials

Create a local `.env` file:

```bash
cp .env.minimal.example .env
```

At minimum, set:

- `DISCORD_TOKEN`: the bot token from the Discord Developer Portal.
- `GEMINI_API_KEY` or `NVIDIA_API_KEY`: a key for at least one configured chat provider.
- `COMMAND_USER_IDS`: comma-separated numeric Discord user IDs allowed to request server actions.

For NVIDIA chat, also set `AI_PROVIDER=openai`. For Gemini chat, `AI_PROVIDER=auto` uses Gemini
when its key is configured.

For live voice, configure all of the following:

- `GEMINI_API_KEY` for Gemini Live Transcription (`GEMINI_ASR_MODEL`, default
  `gemini-3.5-transcribe-live`).
- `FISH_AUDIO_API_KEY` and `FISH_AUDIO_REFERENCE_ID` for speech output.
- An AI chat provider key. Set `AI_PROVIDER=openai` and `NVIDIA_API_KEY` to use NVIDIA for
  voice replies; otherwise the selected chat provider generates them.

Keep `.env` private. Never commit API keys, bot tokens, or the local `memory.db`.

## 4. Set up the Discord application

In the Discord Developer Portal:

1. Enable **Message Content Intent** and **Server Members Intent** under Bot intents.
2. Invite the bot with the `bot` and `applications.commands` scopes.
3. Grant only the permissions Capri needs in the target server. Voice requires permission to
   view/connect to the voice channel and speak; text commands need access to the relevant text
   channels. Server actions also require the corresponding Discord permissions and role position.

See [DISCORD_ACTIONS.md](./DISCORD_ACTIONS.md) for action permissions and
[ENV_SETUP.md](./ENV_SETUP.md) for provider and authorization details.

## 5. Check and start

From the repository root, with the virtual environment active:

```bash
python -m unittest discover -s python
npm start
```

`npm start` is the default Python launcher. Keep only one bot process connected with the token.
Stop it with `Ctrl+C`. The separate Node implementation is optional and starts with
`npm run start:node`; it does not provide the Python voice features.

## 6. Connect to voice

After the bot is online and its slash commands have synced:

1. Join the desired Discord voice channel.
2. Run `/vc_join` and select that channel.
3. Say “Capri” in each turn that should get a reply. The voice responder requires the name in
   each individual recognized transcript; it does not use a cooldown or follow-up window.
4. Use `/vc_status` to inspect listening, transcription, and playback counters. Use `/vc_beep`
   to test playback without TTS, `/vc_say` to request speech, and `/vc_leave` to disconnect.

## Troubleshooting

- **Missing `DISCORD_TOKEN` or provider key:** check the local `.env` and restart the bot.
- **Voice join reports missing Opus:** install the platform's Opus runtime library, then restart.
- **Listening is active but no response:** check `/vc_status`. The ASR turn count should increase;
  if it does but Capri does not respond, verify that the transcript recognized “Capri.”
- **TTS succeeds but audio is silent or stops:** check DAVE readiness and playback errors in
  `/vc_status`, then try `/vc_leave` followed by `/vc_join`.
- **API errors or limits:** check provider credentials, availability, account quotas, and billing.
  Local queue settings cannot remove provider-side limits.
