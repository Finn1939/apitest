import asyncio
import json
import sqlite3
import time
from typing import Any

import discord


def open_memory_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_name TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            importance REAL DEFAULT 0.5,
            guild_id TEXT NOT NULL DEFAULT '',
            is_bot INTEGER NOT NULL DEFAULT 0,
            discord_id TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_messages_channel_recent ON messages(channel_id, id);
        CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT NOT NULL,
            fact TEXT NOT NULL,
            confidence REAL DEFAULT 0.8,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            hits INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS relationships (
            user_id TEXT PRIMARY KEY,
            affinity REAL DEFAULT 0,
            last_interacted INTEGER DEFAULT 0,
            romance REAL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS journal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            entry TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS self_model (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            persona TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS guild_members (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            global_name TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT '',
            nickname TEXT NOT NULL DEFAULT '',
            roles_json TEXT NOT NULL DEFAULT '[]',
            joined_at INTEGER DEFAULT 0,
            is_bot INTEGER NOT NULL DEFAULT 0,
            in_voice_channel_id TEXT NOT NULL DEFAULT '',
            last_seen_at INTEGER DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS guild_state (
            guild_id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            owner_id TEXT NOT NULL DEFAULT '',
            member_count INTEGER DEFAULT 0,
            snapshot_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER DEFAULT 0
        );
        """
    )
    conn.commit()
    return conn


def log_message(
    db: sqlite3.Connection,
    *,
    channel_id: str,
    author_id: str,
    author_name: str,
    username: str,
    content: str,
    created_at_ms: int,
    guild_id: str = "",
    is_bot: bool = False,
    discord_id: str = "",
) -> None:
    db.execute(
        """
        INSERT INTO messages(channel_id, author_id, author_name, username, content, created_at, importance, guild_id, is_bot, discord_id)
        VALUES (?, ?, ?, ?, ?, ?, 0.5, ?, ?, ?)
        """,
        (
            str(channel_id),
            str(author_id),
            str(author_name),
            str(username or ""),
            str(content or "")[:2000],
            int(created_at_ms),
            str(guild_id or ""),
            1 if is_bot else 0,
            str(discord_id or ""),
        ),
    )
    db.commit()


def upsert_guild_member(db: sqlite3.Connection, guild_id: int | str, member: discord.Member, *, commit=True) -> None:
    roles = [r.name for r in member.roles if r.id != member.guild.id]
    joined_ts = int(member.joined_at.timestamp() * 1000) if member.joined_at else 0
    voice_id = str(member.voice.channel.id) if member.voice and member.voice.channel else ""
    now_ms = int(time.time() * 1000)
    db.execute(
        """
        INSERT INTO guild_members(
            guild_id, user_id, username, global_name, display_name, nickname,
            roles_json, joined_at, is_bot, in_voice_channel_id, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
            username = excluded.username,
            global_name = excluded.global_name,
            display_name = excluded.display_name,
            nickname = excluded.nickname,
            roles_json = excluded.roles_json,
            joined_at = COALESCE(NULLIF(excluded.joined_at, 0), guild_members.joined_at),
            is_bot = excluded.is_bot,
            in_voice_channel_id = excluded.in_voice_channel_id,
            last_seen_at = MAX(guild_members.last_seen_at, excluded.last_seen_at)
        """,
        (
            str(guild_id),
            str(member.id),
            member.name or "",
            member.global_name or "",
            member.display_name or member.name or str(member.id),
            member.nick or "",
            json.dumps(roles),
            joined_ts,
            1 if member.bot else 0,
            voice_id,
            now_ms,
        ),
    )
    if commit:
        db.commit()


async def fetch_guild_channels(guild: discord.Guild) -> list[Any]:
    try:
        return list(await guild.fetch_channels())
    except discord.InvalidData as exc:
        channels = list(guild.channels)
        print(
            f"[Capri sync] {guild.name}: Discord returned an unsupported channel type; "
            f"using {len(channels)} cached channels instead ({exc})"
        )
        return channels
    except discord.HTTPException:
        return list(guild.channels)


async def sync_guild_directory(db: sqlite3.Connection, guild: discord.Guild, *, worker=None) -> dict[str, int]:
    members = list(guild.members)
    if not members:
        try:
            members = [m async for m in guild.fetch_members(limit=None)]
        except discord.HTTPException:
            members = list(guild.members)

    channels = await fetch_guild_channels(guild)

    try:
        roles = [r for r in await guild.fetch_roles() if r.id != guild.id]
    except discord.HTTPException:
        roles = [r for r in guild.roles if r.id != guild.id]

    return await asyncio.get_running_loop().run_in_executor(worker, _save_directory, db, guild, members, channels, roles)


def _save_directory(db, guild, members, channels, roles):
    with db:
        for member in members:
            upsert_guild_member(db, guild.id, member, commit=False)

    snapshot = {
        "channels": [
            {"id": str(c.id), "name": c.name, "type": str(getattr(c.type, "name", c.type)), "parentId": str(c.category_id) if c.category_id else None}
            for c in channels[:60]
        ],
        "roles": [
            {"id": str(r.id), "name": r.name, "color": str(r.color)}
            for r in sorted(roles, key=lambda x: x.position, reverse=True)[:40]
        ],
    }
    now_ms = int(time.time() * 1000)
    db.execute(
        """
        INSERT INTO guild_state(guild_id, name, owner_id, member_count, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            name = excluded.name,
            owner_id = excluded.owner_id,
            member_count = excluded.member_count,
            snapshot_json = excluded.snapshot_json,
            updated_at = excluded.updated_at
        """,
        (str(guild.id), guild.name or "", str(guild.owner_id or ""), guild.member_count or len(members), json.dumps(snapshot), now_ms),
    )
    db.commit()
    return {"member_count": len(members), "channel_count": len(channels), "role_count": len(roles)}


def update_affinity(db: sqlite3.Connection, user_id: int | str, delta: float = 0.05) -> None:
    uid = str(user_id)
    now_ms = int(time.time() * 1000)
    row = db.execute("SELECT affinity FROM relationships WHERE user_id = ?", (uid,)).fetchone()
    if row:
        db.execute(
            "UPDATE relationships SET affinity = MIN(5, affinity + ?), last_interacted = ? WHERE user_id = ?",
            (delta, now_ms, uid),
        )
    else:
        db.execute(
            "INSERT INTO relationships(user_id, affinity, last_interacted, romance) VALUES (?, ?, ?, 0)",
            (uid, delta, now_ms),
        )
    db.commit()


def build_server_knowledge(db: sqlite3.Connection, guild: discord.Guild | None, channel: Any) -> str:
    if guild is None:
        return "Direct Message context (no server directory)."
    lines = [
        f"Server: {guild.name} ({guild.member_count or len(guild.members)} members, owner ID {guild.owner_id})",
    ]
    if channel is not None and hasattr(channel, "name"):
        topic = getattr(channel, "topic", None) or ""
        lines.append(f"Current live channel: #{channel.name} (ID: {channel.id}{f', topic: {topic}' if topic else ''})")

    live_channels = sorted(guild.channels, key=lambda c: getattr(c, "position", 0))
    if live_channels:
        lines.append("Live Channels: " + ", ".join(f"#{c.name}" for c in live_channels[:35]))

    live_roles = sorted([r for r in guild.roles if r.id != guild.id], key=lambda r: r.position, reverse=True)
    if live_roles:
        lines.append("Live Roles: " + ", ".join(r.name for r in live_roles[:25]))

    in_voice = [m for m in guild.members if m.voice and m.voice.channel]
    if in_voice:
        lines.append("In Voice Now: " + ", ".join(f"{m.display_name} (<#{m.voice.channel.id}>)" for m in in_voice[:25]))

    rows = db.execute(
        "SELECT user_id, username, display_name, roles_json, is_bot FROM guild_members WHERE guild_id = ? ORDER BY is_bot ASC, last_seen_at DESC LIMIT 35",
        (str(guild.id),),
    ).fetchall()
    if rows:
        lines.append(f"Known Members ({len(rows)}):")
        for r in rows:
            try:
                roles = json.loads(r["roles_json"] or "[]")
            except Exception:
                roles = []
            role_bit = f" [{', '.join(roles[:4])}]" if roles else ""
            bot_bit = " [bot]" if r["is_bot"] else ""
            lines.append(f"- {r['display_name']} (@{r['username']}, id:{r['user_id']}){role_bit}{bot_bit}")

    return "\n".join(lines)


def build_prompt_context(
    db: sqlite3.Connection,
    message: discord.Message,
    bot_user_id: int,
    personality: str,
) -> str:
    server_knowledge = build_server_knowledge(db, message.guild, message.channel)
    facts_rows = db.execute(
        "SELECT fact FROM facts WHERE subject = ? ORDER BY hits DESC, last_seen DESC",
        (f"user:{message.author.id}",),
    ).fetchall()
    facts_text = "\n".join(f"- {r['fact']}" for r in facts_rows) or "No stored personal facts yet."

    recent_rows = db.execute(
        "SELECT author_id, author_name, content, is_bot FROM messages WHERE channel_id = ? ORDER BY id DESC",
        (str(message.channel.id),),
    ).fetchall()
    recent_lines = []
    for row in reversed(recent_rows):
        if "/run these actions/i" in (row["content"] or "").lower() or "run these actions" in (row["content"] or "").lower():
            continue
        if int(row["author_id"]) == bot_user_id:
            recent_lines.append(f"You: {row['content']}")
        else:
            recent_lines.append(f"{row['author_name']}: {row['content']}")

    return "\n\n".join(
        [
            personality,
            "<server_knowledge>\n" + server_knowledge + "\n</server_knowledge>",
            f"<speaker>{message.author.display_name} (@{message.author.name}, ID: {message.author.id})</speaker>",
            "<things_you_know>\n" + facts_text + "\n</things_you_know>",
            "<recent_conversation>\n" + ("\n".join(recent_lines) or "(none)") + "\n</recent_conversation>",
            "GROUNDING: Current live channel above is real-time ground truth. Never repeat stale channel names from old messages. Never tell users to click 'Run these actions'.",
        ]
    )
