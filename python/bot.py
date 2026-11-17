import asyncio
import ctypes.util
import json
import os
import random
from pathlib import Path
from typing import Any

import discord
from discord import app_commands
from dotenv import load_dotenv
from google import genai
from openai import AsyncOpenAI

from actions import (
    ConfirmDeleteView,
    can_run_commands,
    execute_plan,
    extract_json,
)
from actions_schema import (
    ACTIONS,
    format_action_outcome,
    is_action_request,
    normalize_plan,
    requires_delete_confirmation,
    should_check_authorized_action,
    validate_plan,
)
from memory_store import (
    build_prompt_context,
    build_server_knowledge,
    fetch_guild_channels,
    log_message,
    open_memory_db,
    sync_guild_directory,
    update_affinity,
    upsert_guild_member,
)
from provider_config import select_chat_provider
from voice_live import HAS_VOICE_RECV, VoiceSessionManager

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")
load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
GEMINI_KEY = (os.getenv("GEMINI_API_KEYS") or os.getenv("GEMINI_API_KEY") or "").split(",")[0].strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-4-hydrogen").strip()
OPENAI_KEY = (os.getenv("NVIDIA_API_KEYS") or os.getenv("NVIDIA_API_KEY") or os.getenv("AI_API_KEY") or "").split(",")[0].strip()
AI_API_URL = os.getenv("AI_API_URL", "https://integrate.api.nvidia.com/v1").strip()
AI_MODEL = os.getenv("AI_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b").strip()
AI_PROVIDER = os.getenv("AI_PROVIDER", "auto").strip().lower()
CHAT_PROVIDER = select_chat_provider(AI_PROVIDER, GEMINI_KEY)

COMMAND_USER_IDS = {x.strip() for x in os.getenv("COMMAND_USER_IDS", "").split(",") if x.strip()}
ALLOW_GUILD_ADMINS = os.getenv("ALLOW_GUILD_ADMINS", "true").lower() != "false"
TRUST_LEVEL = "mirror_actor" if os.getenv("COMMAND_TRUST_LEVEL", "full").lower() == "mirror_actor" else "full"
BOT_PREFIX = os.getenv("BOT_PREFIX", "t").strip() or "t"
DB_PATH = str((ROOT_DIR / os.getenv("DB_PATH", "memory.db")).resolve()) if not os.path.isabs(os.getenv("DB_PATH", "memory.db")) else os.getenv("DB_PATH", "memory.db")
PERSONALITY_PATH = Path(os.getenv("PERSONALITY_PATH") or (ROOT_DIR / "personality.txt"))
PERSONALITY = PERSONALITY_PATH.read_text(encoding="utf-8").strip() if PERSONALITY_PATH.exists() else "You are Capri (Cyberpunk: Edgerunners 2) living in a Discord server."

FISH_AUDIO_API_KEY = os.getenv("FISH_AUDIO_API_KEY", "").strip()
FISH_AUDIO_REFERENCE_ID = os.getenv(
    "FISH_AUDIO_REFERENCE_ID",
    "fdef76c9b2e741119d817754bd8b5dd0",
).strip()
FISH_ASR_MODEL = os.getenv("FISH_ASR_MODEL", "transcribe-stream-1").strip()
FISH_TTS_MODEL = os.getenv("FISH_TTS_MODEL", "s2.1-pro-free").strip()
VOICE_VAD_THRESHOLD = float(os.getenv("VOICE_VAD_THRESHOLD", "110"))

gemini_client = genai.Client(api_key=GEMINI_KEY) if CHAT_PROVIDER == "gemini" and GEMINI_KEY else None
openai_client = AsyncOpenAI(api_key=OPENAI_KEY, base_url=AI_API_URL.replace("/chat/completions", "")) if CHAT_PROVIDER == "openai" and OPENAI_KEY else None

db = open_memory_db(DB_PATH)
voice_mgr = VoiceSessionManager()
ACTION_SCHEMA_SUMMARY = {k: v[1] for k, v in ACTIONS.items()}
DENIED_MSG = "Nice try, netrunner — you can chat with me anytime, but server takeover commands are locked to authorized controllers."


def ensure_opus_loaded() -> None:
    if discord.opus.is_loaded():
        return
    library = ctypes.util.find_library("opus")
    if not library:
        raise RuntimeError("Discord voice needs libopus. Install the system package `libopus0` and restart the bot.")
    try:
        discord.opus.load_opus(library)
    except OSError as exc:
        raise RuntimeError(f"Could not load Discord's Opus library `{library}`: {exc}") from exc


async def complete_ai(system_prompt: str, user_prompt: str, temperature: float = 0.7, attachments: list[tuple[bytes, str]] | None = None, response_mime_type: str | None = None) -> str:
    if gemini_client is not None:
        contents: list[Any] = [user_prompt]
        for data, mime in attachments or []:
            contents.append(genai.types.Part.from_bytes(data=data, mime_type=mime))
        cfg_kw: dict[str, Any] = {
            "system_instruction": system_prompt,
            "temperature": temperature,
        }
        if response_mime_type:
            cfg_kw["response_mime_type"] = response_mime_type
        resp = await asyncio.to_thread(
            gemini_client.models.generate_content,
            model=GEMINI_MODEL,
            contents=contents,
            config=genai.types.GenerateContentConfig(**cfg_kw),
        )
        return (resp.text or "").strip()

    if openai_client is not None:
        resp = await openai_client.chat.completions.create(
            model=AI_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=1200,
        )
        return (resp.choices[0].message.content or "").strip()

    raise RuntimeError("No AI provider key configured (set GEMINI_API_KEY or NVIDIA_API_KEY).")


intents = discord.Intents.all()
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)
last_bot_spoke_by_channel: dict[int, float] = {}


@client.event
async def on_ready() -> None:
    print(f"[discord.py] Logged in as {client.user} | AI: {'Gemini ' + GEMINI_MODEL if gemini_client else AI_MODEL}")
    for guild in client.guilds:
        try:
            stats = await sync_guild_directory(db, guild)
            print(f"[Capri sync] {guild.name}: {stats['member_count']} members, {stats['channel_count']} channels, {stats['role_count']} roles")
        except Exception as exc:
            print(f"[Capri sync] Failed for {guild.name}: {exc}")
    await tree.sync()


@client.event
async def on_guild_channel_create(channel: discord.abc.GuildChannel) -> None:
    await sync_guild_directory(db, channel.guild)


@client.event
async def on_guild_channel_update(_before: discord.abc.GuildChannel, after: discord.abc.GuildChannel) -> None:
    await sync_guild_directory(db, after.guild)


@client.event
async def on_guild_channel_delete(channel: discord.abc.GuildChannel) -> None:
    await sync_guild_directory(db, channel.guild)


@client.event
async def on_guild_role_create(role: discord.Role) -> None:
    await sync_guild_directory(db, role.guild)


@client.event
async def on_guild_role_update(_before: discord.Role, after: discord.Role) -> None:
    await sync_guild_directory(db, after.guild)


@client.event
async def on_guild_role_delete(role: discord.Role) -> None:
    await sync_guild_directory(db, role.guild)


@client.event
async def on_member_join(member: discord.Member) -> None:
    upsert_guild_member(db, member.guild.id, member)


@client.event
async def on_member_update(_before: discord.Member, after: discord.Member) -> None:
    upsert_guild_member(db, after.guild.id, after)


@client.event
async def on_voice_state_update(member: discord.Member, _before: discord.VoiceState, after: discord.VoiceState) -> None:
    upsert_guild_member(db, member.guild.id, member)
    if client.user and member.id == client.user.id and after.channel is None:
        if voice_mgr.get(member.guild.id):
            await voice_mgr.leave(member.guild.id)


def build_voice_system_instruction(guild: discord.Guild, text_channel: Any = None) -> str:
    knowledge = build_server_knowledge(db, guild, text_channel)
    return "\n\n".join([
        PERSONALITY,
        "<server_knowledge>\n" + knowledge + "\n</server_knowledge>",
        "VOICE CALL RULES: You are talking with people in a live Discord voice channel. Respond naturally in 1-3 concise sentences unless someone asks for detail. Address the person who spoke by name when it feels natural. Audio is streamed for transcription and is not saved to disk.",
    ])


async def handle_voice_action(
    op: str,
    *,
    guild: discord.Guild,
    voice_channel: Any = None,
    text: str = "",
    text_channel: Any = None,
) -> str:
    if op == "leave":
        had_session = await voice_mgr.leave(guild.id)
        if not had_session and guild.voice_client and guild.voice_client.is_connected():
            await guild.voice_client.disconnect(force=True)
            had_session = True
        return "Disconnected from voice channel." if had_session else "Not currently in a voice channel."

    if op == "join":
        if voice_channel is None:
            raise ValueError("Specify a voice channel or join one first.")
        ensure_opus_loaded()

        async def _on_vc_transcript(speaker_id: int, speaker_name: str, spoken_text: str, is_bot: bool) -> None:
            log_message(
                db,
                channel_id=str(voice_channel.id),
                author_id=str(client.user.id if is_bot and client.user else speaker_id),
                author_name=client.user.name if is_bot and client.user else speaker_name,
                username=client.user.name if is_bot and client.user else speaker_name,
                content=f"[VC] {spoken_text}",
                created_at_ms=int(discord.utils.utcnow().timestamp() * 1000),
                guild_id=str(guild.id),
                is_bot=is_bot,
            )
            if not is_bot and text_channel is not None and speaker_id and "capri" in spoken_text.lower():
                if is_action_request(spoken_text, BOT_PREFIX, allow_unaddressed=True, is_named=True):
                    member = guild.get_member(speaker_id)
                    if member and can_run_commands(member, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
                        await _run_spoken_vc_command(guild, member, text_channel, spoken_text)

        voice_system_instruction = build_voice_system_instruction(guild, text_channel)
        voice_history: list[str] = []

        async def _on_vc_user_turn(speaker_id: int, speaker_name: str, spoken_text: str) -> str:
            voice_history.append(f"{speaker_name}: {spoken_text}")
            del voice_history[:-10]
            reply = await complete_ai(
                voice_system_instruction,
                "Recent voice conversation:\n"
                + "\n".join(voice_history)
                + "\nReply naturally to the latest turn.",
                temperature=0.7,
            )
            if reply:
                voice_history.append(f"Capri: {reply}")
                del voice_history[:-10]
            return reply

        _sess, listen_ok = await voice_mgr.join(
            guild=guild,
            voice_channel=voice_channel,
            fish_api_key=FISH_AUDIO_API_KEY,
            reference_id=FISH_AUDIO_REFERENCE_ID,
            asr_model=FISH_ASR_MODEL,
            tts_model=FISH_TTS_MODEL,
            vad_threshold=VOICE_VAD_THRESHOLD,
            text_channel=text_channel,
            on_transcript=_on_vc_transcript,
            on_user_turn=_on_vc_user_turn,
        )
        mode_note = "Fish realtime transcription + TTS" if listen_ok else "Fish TTS only (install discord-ext-voice-recv to hear VC)"
        return f"Joined #{voice_channel.name} ({mode_note}; {FISH_ASR_MODEL} → {AI_MODEL} → {FISH_TTS_MODEL})."

    if op == "say":
        session = voice_mgr.get(guild.id)
        if session is None:
            if voice_channel is None:
                populated = [vc for vc in guild.voice_channels if len(vc.members) > 0]
                voice_channel = populated[0] if populated else (guild.voice_channels[0] if guild.voice_channels else None)
            if voice_channel is None:
                raise ValueError("Not in a voice channel and no voice channel found to join.")
            await handle_voice_action("join", guild=guild, voice_channel=voice_channel, text_channel=text_channel)
        ok = await voice_mgr.say(guild.id, f"Say this naturally out loud in Capri's voice: {text}")
        if not ok:
            raise RuntimeError("Failed to queue speech for the Fish voice session.")
        return f'Queued to speak in VC: "{text[:140]}"'

    raise ValueError(f"Unknown voice operation: {op}")


async def _run_spoken_vc_command(guild: discord.Guild, member: discord.Member, text_channel: Any, spoken_text: str) -> None:
    try:
        channels = await fetch_guild_channels(guild)
        roles = [r for r in await guild.fetch_roles() if r.id != guild.id]
        context = {
            "guildName": guild.name,
            "guildId": str(guild.id),
            "currentChannel": {"id": str(text_channel.id), "name": getattr(text_channel, "name", "")},
            "roles": [{"id": str(r.id), "name": r.name} for r in roles[:60]],
            "channels": [{"id": str(c.id), "name": c.name, "type": str(getattr(c.type, "name", c.type))} for c in channels[:80]],
        }
        planner_sys = (
            "You are Capri's Discord command planner handling a spoken request from a voice call. Return ONLY valid JSON.\n"
            f"Supported action schemas: {json.dumps(ACTION_SCHEMA_SUMMARY)}"
        )
        raw = await complete_ai(planner_sys, json.dumps({"message": spoken_text, "context": context}), temperature=0.0, response_mime_type="application/json")
        parsed = extract_json(raw)
        if not parsed or not parsed.get("actions"):
            return
        plan = validate_plan(normalize_plan({"actions": parsed["actions"]}, str(text_channel.id), spoken_text))
        if requires_delete_confirmation(plan):
            await text_channel.send(
                f"🎙️ Heard <@{member.id}> ask in VC to run a delete action — say or type that in text chat so I can drop the **Confirm deletion** button.",
                allowed_mentions=discord.AllowedMentions.none(),
            )
            return

        class _ProxyMsg:
            id = int(discord.utils.utcnow().timestamp() * 1000)
            content = spoken_text
            author = member
            channel = text_channel

        results = await execute_plan(_ProxyMsg(), plan, trust_level=TRUST_LEVEL, bot_client=client, voice_handler=handle_voice_action)  # type: ignore[arg-type]
        outcome = format_action_outcome(results)
        await sync_guild_directory(db, guild)
        await text_channel.send(f"🎙️ **VC Command executed** ({member.display_name}):\n{outcome['report']}"[:1900], allowed_mentions=discord.AllowedMentions.none())
    except Exception as exc:
        print(f"[Capri VC command error] {exc}")


@tree.command(name="help", description="How to talk to Capri and what she controls")
async def slash_help(interaction: discord.Interaction) -> None:
    await interaction.response.send_message(
        "\n".join([
            "**Capri (discord.py engine) — Live Discord Control, VC AI & Persona**",
            "- Talk naturally or mention `@Capri` — no fixed command syntax required.",
            "- Non-delete actions (rename, create, read, lock, roles, VC join/say) run **immediately** with no button.",
            "- Delete / purge / prune operations pause behind **Confirm deletion** / **Cancel** buttons.",
            "- **Live Voice AI**: Say *'capri hop in vc'* / *'leave vc'* or use `/vc_join`, `/vc_leave`, `/vc_say`, `/vc_status`.",
        ])
    )


@tree.command(name="server_sync", description="Re-sync all server members, roles, and channels")
async def slash_sync(interaction: discord.Interaction) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Run this inside a server.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    stats = await sync_guild_directory(db, interaction.guild)
    await interaction.followup.send(f"Synced **{interaction.guild.name}**: {stats['member_count']} members, {stats['channel_count']} channels, {stats['role_count']} roles.")


@tree.command(name="status", description="Show Capri status and synced brain stats")
async def slash_status(interaction: discord.Interaction) -> None:
    msgs = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    members = db.execute("SELECT COUNT(*) FROM guild_members").fetchone()[0]
    vc_note = " | VC: Live" if interaction.guild and voice_mgr.get(interaction.guild.id) else ""
    await interaction.response.send_message(f"**{client.user.name}** online on `discord.py` | Ping: {round(client.latency * 1000)}ms | Brain: {msgs} messages, {members} synced members{vc_note}")


@tree.command(name="vc_join", description="Bring Capri into a voice channel with Fish ASR, NVIDIA chat, and Fish TTS")
@app_commands.describe(channel="Voice channel to join (optional if you are already in one)")
async def slash_vc_join(interaction: discord.Interaction, channel: discord.VoiceChannel | discord.StageChannel | None = None) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Run this inside a server.", ephemeral=True)
        return
    if not can_run_commands(interaction.user, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
        await interaction.response.send_message(DENIED_MSG, ephemeral=True)
        return
    await interaction.response.defer()
    target_vc = channel or (interaction.user.voice.channel if isinstance(interaction.user, discord.Member) and interaction.user.voice else None)
    if target_vc is None:
        populated = [vc for vc in interaction.guild.voice_channels if len(vc.members) > 0]
        target_vc = populated[0] if populated else (interaction.guild.voice_channels[0] if interaction.guild.voice_channels else None)
    if target_vc is None:
        await interaction.followup.send("No voice channel found to join.")
        return
    try:
        res = await handle_voice_action("join", guild=interaction.guild, voice_channel=target_vc, text_channel=interaction.channel)
        await interaction.followup.send(f"🎙️ {res}")
    except Exception as exc:
        detail = str(exc).strip() or repr(exc)
        print(f"[Capri /vc_join error] {type(exc).__name__}: {detail}")
        await interaction.followup.send(f"Couldn't join VC: {detail}")


@tree.command(name="vc_leave", description="Disconnect Capri from the current voice channel")
async def slash_vc_leave(interaction: discord.Interaction) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Run this inside a server.", ephemeral=True)
        return
    if not can_run_commands(interaction.user, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
        await interaction.response.send_message(DENIED_MSG, ephemeral=True)
        return
    res = await handle_voice_action("leave", guild=interaction.guild, text_channel=interaction.channel)
    await interaction.response.send_message(res)


@tree.command(name="vc_say", description="Have Capri speak something aloud in the voice channel")
@app_commands.describe(prompt="What Capri should say in voice")
async def slash_vc_say(interaction: discord.Interaction, prompt: str) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Run this inside a server.", ephemeral=True)
        return
    if not can_run_commands(interaction.user, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
        await interaction.response.send_message(DENIED_MSG, ephemeral=True)
        return
    await interaction.response.defer()
    target_vc = interaction.user.voice.channel if isinstance(interaction.user, discord.Member) and interaction.user.voice else None
    try:
        res = await handle_voice_action("say", guild=interaction.guild, voice_channel=target_vc, text=prompt, text_channel=interaction.channel)
        await interaction.followup.send(f"🎙️ {res}")
    except Exception as exc:
        detail = str(exc).strip() or repr(exc)
        print(f"[Capri /vc_say error] {type(exc).__name__}: {detail}")
        await interaction.followup.send(f"VC speech failed: {detail}")


@tree.command(name="vc_status", description="Check Capri's Fish voice link and audio config")
async def slash_vc_status(interaction: discord.Interaction) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Run this inside a server.", ephemeral=True)
        return
    sess = voice_mgr.get(interaction.guild.id)
    if not sess:
        await interaction.response.send_message(
            f"Not in VC | Fish ASR: `{FISH_ASR_MODEL}` | Fish TTS: `{FISH_TTS_MODEL}` | "
            f"Voice receive: `{'installed' if HAS_VOICE_RECV else 'not installed'}` | "
            f"Fish key: `{'configured' if FISH_AUDIO_API_KEY else 'missing'}`"
        )
        return
    await interaction.response.send_message(
        f"🎙️ Connected in **#{sess.voice_channel.name}** | Fish ASR: `{sess.asr_model}` | "
        f"Fish TTS: `{sess.tts_model}` | Voice receive: `{'active' if HAS_VOICE_RECV else 'speak-only'}` | "
        f"Buffered: `{sess.audio_source.buffered_bytes()} B`"
    )


async def try_handle_actions(message: discord.Message) -> bool:
    if not message.guild:
        return False

    authorized = can_run_commands(message.author, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS)
    named = client.user in message.mentions or "capri" in message.content.lower()
    explicit = is_action_request(message.content, BOT_PREFIX, allow_unaddressed=False, is_named=named)
    has_recent = (discord.utils.utcnow().timestamp() - last_bot_spoke_by_channel.get(message.channel.id, 0)) < 300
    should_check = should_check_authorized_action(message.content, BOT_PREFIX, has_recent_context=has_recent, is_named=named)

    if not authorized:
        if explicit:
            await message.reply(DENIED_MSG, allowed_mentions=discord.AllowedMentions.none())
            return True
        return False

    if not should_check:
        return False

    channels = await fetch_guild_channels(message.guild)
    roles = [r for r in await message.guild.fetch_roles() if r.id != message.guild.id]
    db_members = [
        dict(r)
        for r in db.execute("SELECT user_id, username, global_name, display_name, nickname FROM guild_members WHERE guild_id = ?", (str(message.guild.id),)).fetchall()
    ]

    context = {
        "guildName": message.guild.name,
        "guildId": str(message.guild.id),
        "currentChannel": {"id": str(message.channel.id), "name": getattr(message.channel, "name", "")},
        "roles": [{"id": str(r.id), "name": r.name} for r in roles[:60]],
        "channels": [{"id": str(c.id), "name": c.name, "type": str(getattr(c.type, "name", c.type))} for c in channels[:80]],
        "mentionedUsers": [{"id": str(u.id), "name": u.name} for u in message.mentions],
        "knownMembersSample": [{"id": m["user_id"], "name": m["display_name"], "username": m["username"]} for m in db_members[:60]],
    }

    planner_system = "\n".join([
        "You are Capri's conversational Discord command planner. The user is an authorized controller chatting naturally (often with typos or slang). Return ONLY valid JSON.",
        'If purely casual chat with NO Discord server operation: {"actions":[],"chat":true}',
        'If action(s) are requested: {"actions":[{"action":"...","args":{...}}]}',
        f"Supported action schemas (use EXACT argument keys!): {json.dumps(ACTION_SCHEMA_SUMMARY)}",
        "EXAMPLES:",
        f'- "rename this channel to saitama" -> {{"actions":[{{"action":"channel_edit","args":{{"channel":"{message.channel.id}","name":"saitama"}}}}]}}',
        '- "cpuld you add role coke to everyone" -> {"actions":[{"action":"role_add_all","args":{"role":"coke","targetGroup":"everyone"}}]}',
        '- "give everyone the vip role except bots" -> {"actions":[{"action":"role_add_all","args":{"role":"vip","targetGroup":"humans"}}]}',
        '- "capri hop in vc" -> {"actions":[{"action":"voice_join","args":{}}]}',
        '- "leave vc" -> {"actions":[{"action":"voice_leave","args":{}}]}',
        '- "say yo whats up in vc" -> {"actions":[{"action":"voice_say","args":{"text":"yo whats up"}}]}',
        "Rules:",
        "- channel_edit MUST include at least one changed field like name, topic, slowmode, nsfw, or parent. role_add / role_remove / role_add_all / role_remove_all MUST use key 'role'.",
        "- Up to 100 actions per plan. Non-delete actions run IMMEDIATELY with NO button. Only delete/purge/prune operations use Confirm deletion / Cancel buttons.",
        "- NEVER tell the user to click 'Run these actions'. Never invent IDs.",
    ])

    raw = await complete_ai(planner_system, json.dumps({"message": message.content, "context": context}), temperature=0.0, response_mime_type="application/json")
    parsed = extract_json(raw)
    if not parsed or not parsed.get("actions"):
        if parsed and parsed.get("clarification"):
            await message.reply(str(parsed["clarification"])[:1800], allowed_mentions=discord.AllowedMentions.none())
            return True
        return False

    try:
        plan = validate_plan(normalize_plan({"actions": parsed["actions"]}, str(message.channel.id), message.content))
    except Exception as exc:
        await message.reply(f"Ran into a wall validating that op: {exc}", allowed_mentions=discord.AllowedMentions.none())
        return True

    if not requires_delete_confirmation(plan):
        results = await execute_plan(message, plan, trust_level=TRUST_LEVEL, db_members=db_members, bot_client=client, voice_handler=handle_voice_action)
        outcome = format_action_outcome(results)
        await sync_guild_directory(db, message.guild)

        if outcome["all_succeeded"]:
            voiced = await complete_ai(
                f"{PERSONALITY[:1200]}\n\nReport ONLY the verified Discord execution results below in Capri's sharp voice. Never contradict the verified channel names/IDs and never mention buttons.",
                f'User said: "{message.content}"\n\nVerified results:\n{outcome["report"]}',
                temperature=0.4,
            )
            reply_text = (voiced or outcome["report"])[:1900]
        else:
            reply_text = f"Hit a snag on that op:\n{outcome['report']}"[:1900]

        await message.reply(reply_text, allowed_mentions=discord.AllowedMentions.none())
        log_message(db, channel_id=str(message.channel.id), author_id=str(client.user.id), author_name=client.user.name, username=client.user.name, content=reply_text, created_at_ms=int(discord.utils.utcnow().timestamp() * 1000), guild_id=str(message.guild.id), is_bot=True)
        return True

    summary_lines = "\n".join(f"{i}. **{s['action']}** — `{json.dumps(s['args'])}`" for i, s in enumerate(plan["actions"], 1))
    view = ConfirmDeleteView(message.author.id)
    sent = await message.reply(
        f"⚠️ **Deletion gate triggered** — nothing wiped yet. Click **Confirm deletion** within 2 minutes or **Cancel**.\n\n{summary_lines[:1500]}",
        view=view,
        allowed_mentions=discord.AllowedMentions.none(),
    )
    await view.wait()
    if view.confirmed is None:
        await sent.edit(content="Deletion timed out — nothing touched.", view=view)
        return True
    if not view.confirmed:
        await sent.edit(content="Standing down. Nothing deleted.", view=view)
        return True

    results = await execute_plan(message, plan, trust_level=TRUST_LEVEL, db_members=db_members, bot_client=client, voice_handler=handle_voice_action)
    await sync_guild_directory(db, message.guild)
    report = "\n".join(results)[:1900]
    await sent.edit(content=f"Done.\n{report}", view=view)
    return True


@client.event
async def on_message(message: discord.Message) -> None:
    if message.author.bot:
        return

    if message.guild and isinstance(message.author, discord.Member):
        upsert_guild_member(db, message.guild.id, message.author)

    log_message(
        db,
        channel_id=str(message.channel.id),
        author_id=str(message.author.id),
        author_name=message.author.display_name,
        username=message.author.name,
        content=message.content or "[media]",
        created_at_ms=int(message.created_at.timestamp() * 1000),
        guild_id=str(message.guild.id) if message.guild else "",
        discord_id=str(message.id),
    )

    if await try_handle_actions(message):
        return

    mentioned = client.user in message.mentions
    in_dm = isinstance(message.channel, discord.DMChannel)
    named = "capri" in message.content.lower() or mentioned
    recent_chat = (discord.utils.utcnow().timestamp() - last_bot_spoke_by_channel.get(message.channel.id, 0)) < 180
    addressed = mentioned or in_dm or named or (recent_chat and len(message.content.strip()) >= 4)

    if not addressed:
        if len(message.content.strip()) >= 8 and random.random() < 0.12:
            try:
                await message.add_reaction(random.choice(["👀", "⚡", "🔥", "💀"]))
            except discord.HTTPException:
                pass
        return

    async with message.channel.typing():
        media_parts: list[tuple[bytes, str]] = []
        for att in message.attachments[:3]:
            if att.size <= 8 * 1024 * 1024 and att.content_type and any(att.content_type.startswith(p) for p in ("image/", "audio/", "video/")):
                try:
                    media_parts.append((await att.read(), att.content_type))
                except Exception:
                    pass

        sys_prompt = build_prompt_context(db, message, client.user.id, PERSONALITY)
        reply = await complete_ai(sys_prompt, message.content or "(check attached media)", temperature=0.85, attachments=media_parts)
        reply = (reply or "Signal glitched — say that again?")[:1900]

    await message.reply(reply, allowed_mentions=discord.AllowedMentions.none())
    last_bot_spoke_by_channel[message.channel.id] = discord.utils.utcnow().timestamp()
    update_affinity(db, message.author.id)
    log_message(
        db,
        channel_id=str(message.channel.id),
        author_id=str(client.user.id),
        author_name=client.user.name,
        username=client.user.name,
        content=reply,
        created_at_ms=int(discord.utils.utcnow().timestamp() * 1000),
        guild_id=str(message.guild.id) if message.guild else "",
        is_bot=True,
    )


if __name__ == "__main__":
    if not DISCORD_TOKEN:
        raise RuntimeError("Missing DISCORD_TOKEN in .env")
    client.run(DISCORD_TOKEN)
