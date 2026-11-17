# Environment setup

If upgrading, edit your existing .env. Preserve your tokens, provider settings, DB_PATH and all memory files. Replace personality.txt with the new version (or update the custom file selected by PERSONALITY_PATH). Restart the bot after editing .env.

For a new install, copy .env.minimal.example to .env and replace the three placeholders:

```dotenv
DISCORD_TOKEN=your_discord_bot_token
NVIDIA_API_KEY=your_nvidia_api_key
NVIDIA_API_KEYS=
COMMAND_USER_IDS=YOUR_DISCORD_USER_ID
ADMIN_USER_IDS=
PERSONALITY_PATH=personality.txt
DISCORD_ACTIONS_ENABLED=true
REPLY_THINKING=false
REPLY_TEMPERATURE=0.85
TIMEZONE=Asia/Manila
```

| Setting | What to enter |
| --- | --- |
| DISCORD_TOKEN | Your bot token, not a user account token |
| NVIDIA_API_KEY | Your existing NVIDIA API key |
| NVIDIA_API_KEYS | Leave empty for one key. If using a pool, comma-separated real keys. This overrides NVIDIA_API_KEY when nonempty; remove old example placeholders. |
| COMMAND_USER_IDS | Your numeric Discord user ID. Multiple allowed users: comma-separated IDs. Not a username, role ID, server ID, or bot ID. Blank disables all commands while everyone can still chat. Invalid IDs cause a clear startup error. |
| ADMIN_USER_IDS | Optional narrower allowlist for maintenance commands. Leave blank to use COMMAND_USER_IDS. Adding an ID here alone does not grant command access. |
| PERSONALITY_PATH | personality.txt, or your custom character file path |
| DISCORD_ACTIONS_ENABLED | true enables server actions; false disables them |
| REPLY_THINKING | false reduces chat reasoning latency; it does not make provider/network calls instantaneous |
| REPLY_TEMPERATURE | 0.85 for more varied chat; action planning remains at temperature 0 |
| TIMEZONE | Asia/Manila for Philippine time |

Keep your working AI_API_URL and AI_MODEL if already configured. The code retains the previous provider/model defaults; model availability was not live-tested. Other providers require their own compatible endpoint, model and key configuration.

No confirmation setting is needed: delete/purge operations require confirmation; other supported actions run immediately. Discord permission and role-hierarchy checks still apply to both the requester and the bot. The ID allowlist does not turn an ordinary Discord member into a server administrator.

Everyone can use normal chat, including conversational questions and automatic memory of their conversations. Explicit command controls are reserved for your allowlist. COMMAND_USER_IDS does not limit which users appear in normal conversation memory.

Use .env.example for all optional settings. Do not upload your .env or include it when sharing the ZIP.
