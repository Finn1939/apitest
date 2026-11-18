import asyncio
import ctypes.util
import io
import re
from contextlib import aclosing
from voice_streams import stream_sentences
from types import SimpleNamespace
from functools import partial
from concurrent.futures import ThreadPoolExecutor

from capri_replies import DENIED, CONFIRM, CANCEL, acknowledgment, load_acknowledgments, failure, receipt, SourceProblem
from reviewer import wants_reviewer, send_reviewer
import json
import logging
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
    is_action_request,
    normalize_plan,
    requires_delete_confirmation,
    validate_plan,
)
from memory_store import (
    build_prompt_context,
    build_server_knowledge,
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

USERID = os.getenv("USERID", "").strip()
COMMAND_USER_IDS = {USERID} if USERID else {x.strip() for x in os.getenv("COMMAND_USER_IDS", "").split(",") if x.strip()}
ALLOW_GUILD_ADMINS = not USERID and os.getenv("ALLOW_GUILD_ADMINS", "true").lower() != "false"
TRUST_LEVEL = "mirror_actor" if os.getenv("COMMAND_TRUST_LEVEL", "full").lower() == "mirror_actor" else "full"
BOT_PREFIX = os.getenv("BOT_PREFIX", "t").strip() or "t"
DB_PATH = str((ROOT_DIR / os.getenv("DB_PATH", "memory.db")).resolve()) if not os.path.isabs(os.getenv("DB_PATH", "memory.db")) else os.getenv("DB_PATH", "memory.db")
PERSONALITY_PATH = Path(os.getenv("PERSONALITY_PATH") or (ROOT_DIR / "personality.txt"))
PERSONALITY = PERSONALITY_PATH.read_text(encoding="utf-8").strip()
if not PERSONALITY:
    raise RuntimeError("Empty personality file")
load_acknowledgments(PERSONALITY)

FISH_AUDIO_API_KEY = os.getenv("FISH_AUDIO_API_KEY", "").strip()
FISH_AUDIO_REFERENCE_ID = os.getenv(
    "FISH_AUDIO_REFERENCE_ID",
    "fdef76c9b2e741119d817754bd8b5dd0",
).strip()
GEMINI_ASR_MODEL = os.getenv("GEMINI_ASR_MODEL", "gemini-3.5-transcribe-live").strip()
FISH_TTS_MODEL = os.getenv("FISH_TTS_MODEL", "s2.1-pro-free").strip()
VOICE_VAD_THRESHOLD = float(os.getenv("VOICE_VAD_THRESHOLD", "110"))

gemini_client = genai.Client(api_key=GEMINI_KEY) if CHAT_PROVIDER == "gemini" and GEMINI_KEY else None
gemini_asr_client = (
    genai.Client(api_key=GEMINI_KEY, http_options={"api_version": "v1beta"})
    if GEMINI_KEY
    else None
)
openai_client = AsyncOpenAI(api_key=OPENAI_KEY, base_url=AI_API_URL.replace("/chat/completions", "")) if CHAT_PROVIDER == "openai" and OPENAI_KEY else None

db = open_memory_db(DB_PATH)
voice_mgr = VoiceSessionManager()
ACTION_SCHEMA_SUMMARY = {k: v[1] for k, v in ACTIONS.items()}
DENIED_MSG = DENIED
memory_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="capri-memory")


async def memory(fn, *args, **kwargs):
    return await asyncio.get_running_loop().run_in_executor(memory_worker, partial(fn, db, *args, **kwargs))

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


class _VoiceHandshakeFrameFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno != logging.DEBUG:
            return True

        message = record.msg
        if message in {
            "Set MLS external sender",
            "MLS proposals processed",
            "MLS welcome processed for transition id %d",
            "MLS commit processed for transition id %d",
            "Preparing for DAVE epoch %d",
            "Preparing for DAVE transition id %d for protocol version %d",
            "Executing DAVE transition id %d",
            "Voice RESUME succeeded.",
        }:
            return True

        if isinstance(message, str) and message.startswith(
            ("Voice websocket binary frame received:", "Sending voice websocket binary frame:")
        ):
            return True

        if message in ("Voice websocket frame received: %s", "Sending voice websocket frame: %s."):
            arguments = record.args
            if isinstance(arguments, tuple):
                frame = arguments[0] if arguments else None
            elif isinstance(arguments, dict):
                frame = arguments
            else:
                frame = None
            opcode = frame.get("op") if isinstance(frame, dict) else None
            if opcode in {21, 22, 23, 24, 31}:
                record.msg = "DAVE voice websocket frame: op=%s"
                record.args = (opcode,)
                return True
        return False


async def complete_ai(*args, **kwargs):
    return await asyncio.wait_for(_generate(*args, **kwargs), timeout=60)


async def _generate(system_prompt: str, user_prompt: str, temperature: float = 0.7, attachments: list[tuple[bytes, str]] | None = None, response_mime_type: str | None = None, max_tokens: int = 1200) -> str:
    if gemini_client is not None:
        contents: list[Any] = [user_prompt]
        for data, mime in attachments or []:
            contents.append(genai.types.Part.from_bytes(data=data, mime_type=mime))
        cfg_kw: dict[str, Any] = {
            "system_instruction": system_prompt,
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        }
        if response_mime_type:
            cfg_kw["response_mime_type"] = response_mime_type
        resp = await gemini_client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=genai.types.GenerateContentConfig(**cfg_kw),
        )
        if max_tokens == 4000 and resp.candidates and str(getattr(resp.candidates[0].finish_reason, "value", "")) == "MAX_TOKENS":
            raise SourceProblem("Ran out of space halfway through the sheet. Give me a smaller topic.")
        return (resp.text or "").strip()

    if openai_client is not None:
        resp = await openai_client.chat.completions.create(
            model=AI_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        if max_tokens == 4000 and resp.choices[0].finish_reason == "length":
            raise SourceProblem("Ran out of space halfway through the sheet. Give me a smaller topic.")
        return (resp.choices[0].message.content or "").strip()

    raise RuntimeError("No AI provider key configured (set GEMINI_API_KEY or NVIDIA_API_KEY).")


intents = discord.Intents.all()
client = discord.Client(intents=intents, allowed_mentions=discord.AllowedMentions.none())
tree = app_commands.CommandTree(client)
last_bot_spoke_by_channel: dict[int, float] = {}


@client.event
async def on_ready() -> None:
    print(f"[discord.py] Logged in as {client.user} | AI: {'Gemini ' + GEMINI_MODEL if gemini_client else AI_MODEL}")
    for guild in client.guilds:
        try:
            stats = await sync_guild_directory(db, guild, worker=memory_worker)
            print(f"[Capri sync] {guild.name}: {stats['member_count']} members, {stats['channel_count']} channels, {stats['role_count']} roles")
            tree.clear_commands(guild=guild)
            await tree.sync(guild=guild)
        except Exception as exc:
            print(f"[Capri sync] Failed for {guild.name}: {exc}")
    commands = await tree.sync()
    print(f"[Capri commands] Synced {len(commands)} global slash commands")


@client.event
async def on_guild_channel_create(channel: discord.abc.GuildChannel) -> None:
    await sync_guild_directory(db, channel.guild, worker=memory_worker)


@client.event
async def on_guild_channel_update(_before: discord.abc.GuildChannel, after: discord.abc.GuildChannel) -> None:
    await sync_guild_directory(db, after.guild, worker=memory_worker)


@client.event
async def on_guild_channel_delete(channel: discord.abc.GuildChannel) -> None:
    await sync_guild_directory(db, channel.guild, worker=memory_worker)


@client.event
async def on_guild_role_create(role: discord.Role) -> None:
    await sync_guild_directory(db, role.guild, worker=memory_worker)


@client.event
async def on_guild_role_update(_before: discord.Role, after: discord.Role) -> None:
    await sync_guild_directory(db, after.guild, worker=memory_worker)


@client.event
async def on_guild_role_delete(role: discord.Role) -> None:
    await sync_guild_directory(db, role.guild, worker=memory_worker)


@client.event
async def on_member_join(member: discord.Member) -> None:
    await memory(upsert_guild_member, member.guild.id, member)


@client.event
async def on_member_update(_before: discord.Member, after: discord.Member) -> None:
    await memory(upsert_guild_member, after.guild.id, after)


@client.event
async def on_voice_state_update(member: discord.Member, _before: discord.VoiceState, after: discord.VoiceState) -> None:
    await memory(upsert_guild_member, member.guild.id, member)
    if client.user and member.id == client.user.id and after.channel is None:
        if voice_mgr.get(member.guild.id):
            await voice_mgr.leave(member.guild.id)


async def build_voice_system_instruction(guild: discord.Guild, text_channel: Any = None) -> str:
    knowledge = await memory(build_server_knowledge, guild, text_channel)
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
    enable_asr: bool = True,
) -> str:
    if op == "leave":
        had_session = await voice_mgr.leave(guild.id)
        if not had_session and guild.voice_client and guild.voice_client.is_connected():
            await guild.voice_client.disconnect(force=True)
            had_session = True
        return "I’m out of voice. Catch me here." if had_session else "I’m already out of voice."

    if op == "join":
        if voice_channel is None:
            raise ValueError("Specify a voice channel or join one first.")
        ensure_opus_loaded()

        destination = text_channel or voice_channel
        voice_system_instruction = await build_voice_system_instruction(guild, destination)
        voice_history: list[str] = []

        async def _on_vc_transcript(speaker_id, speaker_name, spoken_text, is_bot):
            await memory(log_message,
                channel_id=str(voice_channel.id),
                author_id=str(client.user.id if is_bot and client.user else speaker_id),
                author_name=client.user.name if is_bot and client.user else speaker_name,
                username=client.user.name if is_bot and client.user else speaker_name,
                content=f"[VC] {spoken_text}",
                created_at_ms=int(discord.utils.utcnow().timestamp() * 1000),
                guild_id=str(guild.id), is_bot=is_bot,
            )

        async def _dispatch_command(session, speaker_id, speaker_name, spoken_text):
            named = bool(re.search(r"\bcapri\b", spoken_text, re.I))
            study = named and wants_reviewer(spoken_text)
            if not (study or (named and is_action_request(spoken_text, BOT_PREFIX, is_named=True))):
                return False
            member = guild.get_member(speaker_id)
            if not member or not can_run_commands(member, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
                await session.say_text(DENIED)
                return True
            # A command can disconnect its own session or wait for a confirmation.
            # Let the transaction finish independently while the room keeps talking.
            task = asyncio.create_task(_run_spoken_vc_command(
                guild, member, destination, spoken_text, session, study))
            active_voice_commands.add(task)
            task.add_done_callback(active_voice_commands.discard)
            return True

        async def _on_vc_user_turn(speaker_id, speaker_name, spoken_text):
            session = voice_mgr.get(guild.id)
            if not session:
                return ""
            voice_history.append(f"{speaker_name}: {spoken_text}")
            del voice_history[:-10]
            prompt = "Recent voice conversation:\n" + "\n".join(voice_history)
            answer = await asyncio.wait_for(
                stream_sentences(voice_deltas(voice_system_instruction, prompt), session.say_text), timeout=60)
            if answer:
                voice_history.append(f"Capri: {answer}")
                del voice_history[:-10]
                return ""
            return "Missed a beat there. Say that last part again?"

        _sess, listen_ok = await voice_mgr.join(
            guild=guild,
            voice_channel=voice_channel,
            fish_api_key=FISH_AUDIO_API_KEY,
            reference_id=FISH_AUDIO_REFERENCE_ID,
            gemini_client=gemini_asr_client,
            enable_asr=enable_asr,
            asr_model=GEMINI_ASR_MODEL,
            tts_model=FISH_TTS_MODEL,
            vad_threshold=VOICE_VAD_THRESHOLD,
            text_channel=destination,
            on_command=_dispatch_command,
            on_transcript=_on_vc_transcript,
            on_user_turn=_on_vc_user_turn,
        )
        mode_note = (
            "I’ve got my ears on."
            if listen_ok
            else "I can speak, but you’ll have to type to me."
        )
        return f"I’m in #{voice_channel.name}. {mode_note}"

    if op == "say":
        session = voice_mgr.get(guild.id)
        if session is None:
            if voice_channel is None:
                populated = [vc for vc in guild.voice_channels if len(vc.members) > 0]
                voice_channel = populated[0] if populated else (guild.voice_channels[0] if guild.voice_channels else None)
            if voice_channel is None:
                raise ValueError("Not in a voice channel and no voice channel found to join.")
            await handle_voice_action(
                "join",
                guild=guild,
                voice_channel=voice_channel,
                text_channel=text_channel,
                enable_asr=False,
            )
        ok = await voice_mgr.say(guild.id, text)
        if not ok:
            raise RuntimeError("Failed to queue speech for the Fish voice session.")
        return f'Got this lined up for voice: "{text[:140]}"'

    raise ValueError(f"Unknown voice operation: {op}")


active_voice_commands: set[asyncio.Task] = set()


async def voice_deltas(system, prompt):
    if gemini_client is not None:
        stream = await gemini_client.aio.models.generate_content_stream(
            model=GEMINI_MODEL, contents=prompt,
            config=genai.types.GenerateContentConfig(system_instruction=system, temperature=0.7, max_output_tokens=380))
        async with aclosing(stream):
            async for chunk in stream:
                if chunk.text:
                    yield chunk.text
    elif openai_client is not None:
        stream = await openai_client.chat.completions.create(
            model=AI_MODEL, messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            temperature=0.7, max_tokens=380, stream=True)
        async with stream:
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
    else:
        raise RuntimeError("Missing chat provider")


async def _run_spoken_vc_command(guild, member, channel, text, session, study):
    async def reply(line, **kwargs):
        # Queue acknowledgments before the planner or file generator. For an upload
        # announce completion only after Discord accepts the file.
        attachment = "file" in kwargs and "view" not in kwargs
        readout = line
        if "view" in kwargs:
            readout = "Check the deletion list in chat. That last click is yours."
        elif len(line) > 300:
            readout = "I’ve put the full result in chat so you can check each part."
        if not attachment and session.is_connected:
            await session.say_text(readout)
        sent = await channel.send(line, **kwargs)
        if attachment and session.is_connected:
            await session.say_text(readout)
        return sent

    message = SimpleNamespace(id=discord.utils.time_snowflake(discord.utils.utcnow()), content=text,
                              author=member, channel=channel, guild=guild, attachments=[], mentions=[], reply=reply)
    try:
        async with channel.typing():
            if study:
                await send_reviewer(message, PERSONALITY, complete_ai, discord.File)
            elif not await try_handle_actions(message, speak_decision=session.say_text):
                await reply("Caught the words, lost the move. Which bit of the server are we changing?")
    except Exception as exc:
        logging.exception("Spoken command")
        try:
            await reply(failure(exc))
        except discord.HTTPException:
            logging.exception("Voice command text fallback")


@tree.error
async def slash_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    exc = getattr(error, "original", error)
    logging.error("Slash command", exc_info=exc)
    send = interaction.followup.send if interaction.response.is_done() else interaction.response.send_message
    await send(failure(exc), ephemeral=True)


@tree.command(name="vc_join", description="Bring Capri into a voice channel with Gemini ASR, chat, and Fish TTS")
@app_commands.describe(channel="Voice channel to join (optional if you are already in one)")
async def slash_vc_join(interaction: discord.Interaction, channel: discord.VoiceChannel | discord.StageChannel | None = None) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Catch me in the server for that one.", ephemeral=True)
        return
    if not can_run_commands(interaction.user, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
        await interaction.response.send_message(DENIED_MSG, ephemeral=True)
        return
    await interaction.response.send_message(acknowledgment())
    target_vc = channel or (interaction.user.voice.channel if isinstance(interaction.user, discord.Member) and interaction.user.voice else None)
    if target_vc is None:
        populated = [vc for vc in interaction.guild.voice_channels if len(vc.members) > 0]
        target_vc = populated[0] if populated else (interaction.guild.voice_channels[0] if interaction.guild.voice_channels else None)
    if target_vc is None:
        await interaction.followup.send("Can’t spot a voice room here. Which one’s yours?")
        return
    try:
        res = await handle_voice_action("join", guild=interaction.guild, voice_channel=target_vc, text_channel=interaction.channel)
        await interaction.followup.send(f"🎙️ {res}")
    except Exception as exc:
        detail = str(exc).strip() or repr(exc)
        print(f"[Capri /vc_join error] {type(exc).__name__}: {detail}")
        await interaction.followup.send(
            failure(exc)
        )


@tree.command(name="vc_leave", description="Disconnect Capri from the current voice channel")
async def slash_vc_leave(interaction: discord.Interaction) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Catch me in the server for that one.", ephemeral=True)
        return
    if not can_run_commands(interaction.user, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
        await interaction.response.send_message(DENIED_MSG, ephemeral=True)
        return
    await interaction.response.send_message("I’m heading out of voice.")
    res = await handle_voice_action("leave", guild=interaction.guild, text_channel=interaction.channel)
    await interaction.followup.send(res)


@tree.command(name="vc_say", description="Have Capri speak something aloud in the voice channel")
@app_commands.describe(prompt="What Capri should say in voice")
async def slash_vc_say(interaction: discord.Interaction, prompt: str) -> None:
    if not interaction.guild:
        await interaction.response.send_message("Catch me in the server for that one.", ephemeral=True)
        return
    if not can_run_commands(interaction.user, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
        await interaction.response.send_message(DENIED_MSG, ephemeral=True)
        return
    await interaction.response.send_message(acknowledgment())
    target_vc = interaction.user.voice.channel if isinstance(interaction.user, discord.Member) and interaction.user.voice else None
    try:
        res = await handle_voice_action("say", guild=interaction.guild, voice_channel=target_vc, text=prompt, text_channel=interaction.channel)
        print(f"[Capri /vc_say] {res}")
        await interaction.followup.send(f"🎙️ {res}")
    except Exception as exc:
        detail = str(exc).strip() or repr(exc)
        print(f"[Capri /vc_say error] {type(exc).__name__}: {detail}")
        await interaction.followup.send(
            failure(exc)
        )


async def try_handle_actions(message: discord.Message, *, speak_decision=None) -> bool:
    authorized = can_run_commands(message.author, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS)
    if not authorized:
        await message.reply(DENIED)
        return True

    await message.reply(acknowledgment())
    await message.channel.typing()
    channels = message.guild.channels
    roles = [r for r in message.guild.roles if r.id != message.guild.id]
    db_members = await memory(lambda conn: [dict(r) for r in conn.execute(
        "SELECT user_id, username, global_name, display_name, nickname FROM guild_members WHERE guild_id = ?",
        (str(message.guild.id),),
    )])

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
        PERSONALITY,
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
    if not isinstance(parsed, dict):
        raise ValueError("Malformed planner output")
    if not parsed.get("actions") and not (parsed.get("chat") is True or parsed.get("clarification")):
        raise ValueError("Planner gave no decision")
    if not parsed.get("actions"):
        if parsed.get("clarification"):
            await message.reply("Which target did you mean? Give me its name or ID and the change you want.", allowed_mentions=discord.AllowedMentions.none())
            return True
        return False

    try:
        plan = validate_plan(normalize_plan({"actions": parsed["actions"]}, str(message.channel.id), message.content))
    except Exception as exc:
        await message.reply(failure(exc), allowed_mentions=discord.AllowedMentions.none())
        return True

    if not requires_delete_confirmation(plan):
        results = await execute_plan(message, plan, trust_level=TRUST_LEVEL, db_members=db_members, bot_client=client, voice_handler=handle_voice_action)
        reply_text = receipt(results)
        await message.reply(reply_text)
        await memory(log_message, channel_id=str(message.channel.id), author_id=str(client.user.id), author_name=client.user.name, username=client.user.name, content=reply_text, created_at_ms=int(discord.utils.utcnow().timestamp() * 1000), guild_id=str(message.guild.id), is_bot=True)
        return True

    summary_lines = "\n".join(f"{i}. **{s['action']}** — `{json.dumps(s['args'])}`" for i, s in enumerate(plan["actions"], 1))
    view = ConfirmDeleteView(message.author.id)
    sent = await message.reply(
        f"This is what you’re asking me to wipe. Take a look, then hit **{CONFIRM}** or **{CANCEL}** within two minutes.\n\n{summary_lines[:1500]}",
        **({"file": discord.File(io.BytesIO(summary_lines.encode()), filename="deletion-plan.txt")} if len(summary_lines) > 1500 else {}),
        view=view,
        allowed_mentions=discord.AllowedMentions.none(),
    )
    timed_out = await view.wait()
    if timed_out or view.confirmed is None:
        if speak_decision:
            await speak_decision("Time’s up. I left it all in place.")
        await sent.edit(content="Time’s up. I left it all in place.", view=view)
        return True
    if not view.confirmed:
        if speak_decision:
            await speak_decision("Heard you. I left it alone.")
        await sent.edit(content="Heard you. I left it alone.", view=view)
        return True

    results = await execute_plan(message, plan, trust_level=TRUST_LEVEL, db_members=db_members, bot_client=client, voice_handler=handle_voice_action)
    if speak_decision:
        report = receipt(results)
        await speak_decision(report if len(report) < 300 else "The full result’s in chat.")
    try:
        await sent.edit(content=receipt(results), view=view, attachments=[])
    except discord.NotFound:
        await message.channel.send(receipt(results))
    return True


async def remember_message(message):
    if message.guild and isinstance(message.author, discord.Member):
        await memory(upsert_guild_member, message.guild.id, message.author)

    await memory(log_message,
        channel_id=str(message.channel.id),
        author_id=str(message.author.id),
        author_name=message.author.display_name,
        username=message.author.name,
        content=message.content or "[media]",
        created_at_ms=int(message.created_at.timestamp() * 1000),
        guild_id=str(message.guild.id) if message.guild else "",
        discord_id=str(message.id),
    )

@client.event
async def on_message(message: discord.Message) -> None:
    if message.author.bot:
        return
    mentioned = client.user in message.mentions
    in_dm = isinstance(message.channel, discord.DMChannel)
    named = "capri" in message.content.lower() or mentioned
    recent_chat = (discord.utils.utcnow().timestamp() - last_bot_spoke_by_channel.get(message.channel.id, 0)) < 180
    addressed = mentioned or in_dm or named or (recent_chat and len(message.content.strip()) >= 4)

    study = wants_reviewer(message.content)
    action = bool(message.guild) and is_action_request(
        message.content, BOT_PREFIX, allow_unaddressed=can_run_commands(message.author, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS), is_named=named)
    if not (addressed or study or action):
        await remember_message(message)
        if len(message.content.strip()) >= 8 and random.random() < 0.12:
            try:
                await message.add_reaction(random.choice(["👀", "⚡", "🔥", "💀"]))
            except discord.HTTPException:
                pass
        return

    try:
        async with message.channel.typing():
            if study:
                if can_run_commands(message.author, COMMAND_USER_IDS, ALLOW_GUILD_ADMINS):
                    await send_reviewer(message, PERSONALITY, complete_ai, discord.File)
                else:
                    await message.reply(DENIED)
                return
            if action and await try_handle_actions(message):
                return
            await remember_message(message)
            await chat(message)
    except Exception as exc:
        logging.exception("Capri message %s", message.id)
        try:
            await message.channel.send(failure(exc))
        except discord.HTTPException:
            logging.exception("Could not deliver fallback")


async def chat(message):
    media_parts: list[tuple[bytes, str]] = []
    for att in message.attachments[:3]:
        if att.size <= 8 * 1024 * 1024 and att.content_type and any(att.content_type.startswith(p) for p in ("image/", "audio/", "video/")):
            try:
                media_parts.append((await att.read(), att.content_type))
            except Exception:
                raise SourceProblem("Couldn’t pull that attachment through. Send it again?")

    sys_prompt = await memory(build_prompt_context, message, client.user.id, PERSONALITY)
    sys_prompt += "\nThis is a conversation turn. Do not claim to have performed a server action or made a file."
    reply = await complete_ai(sys_prompt, message.content or "(check attached media)", temperature=0.85, attachments=media_parts)
    reply = (reply or "Signal glitched — say that again?")[:1900]

    await message.reply(reply, allowed_mentions=discord.AllowedMentions.none())
    last_bot_spoke_by_channel[message.channel.id] = discord.utils.utcnow().timestamp()
    await memory(update_affinity, message.author.id)
    await memory(log_message,
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
    logging.getLogger("discord.voice_client").setLevel(logging.DEBUG)
    gateway_logger = logging.getLogger("discord.gateway")
    gateway_logger.setLevel(logging.DEBUG)
    gateway_logger.addFilter(_VoiceHandshakeFrameFilter())
    logging.getLogger("discord.voice_state").setLevel(logging.DEBUG)
    client.run(DISCORD_TOKEN)
