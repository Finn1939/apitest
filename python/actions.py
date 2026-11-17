import asyncio
import datetime
import json
import re
from typing import Any

import aiohttp
import discord
from memory_store import fetch_guild_channels

from actions_schema import (
    ACTIONS,
    REF_TOKENS,
    extract_failed_steps,
    format_action_outcome,
    format_channel_name,
    is_action_request,
    normalize_plan,
    requires_delete_confirmation,
    resolve_channel_from_list,
    resolve_role_from_list,
    should_check_authorized_action,
    validate_plan,
)

ID_RE = re.compile(r"^\d{17,20}$")
MEMBER_MENTION_RE = re.compile(r"^<@!?(\d{17,20})>$")
ROLE_MENTION_RE = re.compile(r"^<@&(\d{17,20})>$")

PERM_MAP = {
    "CreateInstantInvite": "create_instant_invite",
    "KickMembers": "kick_members",
    "BanMembers": "ban_members",
    "Administrator": "administrator",
    "ManageChannels": "manage_channels",
    "ManageGuild": "manage_guild",
    "AddReactions": "add_reactions",
    "ViewAuditLog": "view_audit_log",
    "PrioritySpeaker": "priority_speaker",
    "Stream": "stream",
    "ViewChannel": "view_channel",
    "SendMessages": "send_messages",
    "SendTTSMessages": "send_tts_messages",
    "ManageMessages": "manage_messages",
    "EmbedLinks": "embed_links",
    "AttachFiles": "attach_files",
    "ReadMessageHistory": "read_message_history",
    "MentionEveryone": "mention_everyone",
    "UseExternalEmojis": "external_emojis",
    "ViewGuildInsights": "view_guild_insights",
    "Connect": "connect",
    "Speak": "speak",
    "MuteMembers": "mute_members",
    "DeafenMembers": "deafen_members",
    "MoveMembers": "move_members",
    "UseVAD": "use_voice_activation",
    "ChangeNickname": "change_nickname",
    "ManageNicknames": "manage_nicknames",
    "ManageRoles": "manage_roles",
    "ManageWebhooks": "manage_webhooks",
    "ManageGuildExpressions": "manage_expressions",
    "ManageEvents": "manage_events",
    "ManageThreads": "manage_threads",
    "CreatePublicThreads": "create_public_threads",
    "CreatePrivateThreads": "create_private_threads",
    "SendMessagesInThreads": "send_messages_in_threads",
    "ModerateMembers": "moderate_members",
    "PinMessages": "manage_messages",
}

CHANNEL_TYPE_METHODS = {
    "text": "create_text_channel",
    "voice": "create_voice_channel",
    "category": "create_category",
    "announcement": "create_text_channel",
    "forum": "create_forum",
    "stage": "create_stage_channel",
}

STATUS_MAP = {
    "online": discord.Status.online,
    "idle": discord.Status.idle,
    "dnd": discord.Status.dnd,
    "invisible": discord.Status.invisible,
}

ACTIVITY_MAP = {
    "playing": discord.ActivityType.playing,
    "watching": discord.ActivityType.watching,
    "listening": discord.ActivityType.listening,
    "competing": discord.ActivityType.competing,
    "custom": discord.ActivityType.custom,
}


def extract_json(raw: str) -> dict[str, Any] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else text
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(candidate[start : end + 1])
    except Exception:
        return None


def can_run_commands(member: discord.abc.User, allowed_ids: set[str], allow_guild_admins: bool = True) -> bool:
    if str(member.id) in allowed_ids:
        return True
    if allow_guild_admins and isinstance(member, discord.Member):
        if member.guild.owner_id == member.id:
            return True
        if member.guild_permissions.administrator:
            return True
    return False


def check_permission(member: discord.Member, permission_flag: str, channel: Any = None) -> None:
    attr = PERM_MAP.get(permission_flag)
    if not attr:
        return
    perms = channel.permissions_for(member) if channel is not None and hasattr(channel, "permissions_for") else member.guild_permissions
    if not getattr(perms, attr, False):
        raise PermissionError(f"Missing {permission_flag} permission for {member.display_name}.")


def check_hierarchy(guild: discord.Guild, actor: discord.Member, bot_member: discord.Member, target: discord.Member, *, allow_self: bool = False, check_actor: bool = False) -> None:
    if target.id == guild.owner_id:
        raise ValueError("Target is the server owner — Discord blocks modifications above owner.")
    if target.id == bot_member.id:
        raise ValueError("Capri cannot moderate herself.")
    if target.id == actor.id and not allow_self:
        raise ValueError("That action cannot target yourself.")
    if check_actor and actor.id != guild.owner_id and target.id != actor.id and actor.top_role <= target.top_role:
        raise ValueError("Target is at or above your highest role.")
    if bot_member.top_role <= target.top_role:
        raise ValueError("Target is at or above Capri's highest role.")


def check_role(guild: discord.Guild, actor: discord.Member, bot_member: discord.Member, role: discord.Role, *, check_actor: bool = False, allow_everyone: bool = False) -> None:
    if role.id == guild.id:
        if not allow_everyone:
            raise ValueError("Cannot assign or delete @everyone.")
        return
    if role.managed or not role.is_assignable():
        raise ValueError("That role cannot be managed by Capri.")
    if check_actor and actor.id != guild.owner_id and actor.top_role <= role:
        raise ValueError("Role is at or above your highest role.")
    if bot_member.top_role <= role:
        raise ValueError("Role is at or above Capri's highest role.")


def resolve_member_id(guild: discord.Guild, value: str, db_members: list[dict[str, Any]] | None = None) -> int:
    text = str(value or "").strip()
    if ID_RE.match(text):
        return int(text)
    m = MEMBER_MENTION_RE.match(text)
    if m:
        return int(m.group(1))

    clean = text.lstrip("@").strip().lower()
    matches: dict[int, int] = {}
    for member in guild.members:
        names = [member.display_name, member.nick, member.global_name, member.name]
        if any(n and n.strip().lower() == clean for n in names):
            matches[member.id] = member.id
    if len(matches) == 1:
        return next(iter(matches))
    if len(matches) > 1:
        raise ValueError(f'More than one member matches "{text}". Mention them or give their ID.')

    for row in db_members or []:
        names = [row.get("display_name"), row.get("nickname"), row.get("global_name"), row.get("username")]
        if any(n and str(n).strip().lower() == clean for n in names):
            matches[int(row["user_id"])] = int(row["user_id"])
    if len(matches) == 1:
        return next(iter(matches))

    raise ValueError(f'Couldn\'t find member "{text}". Mention them or provide their Discord user ID.')


async def resolve_channel_ref(guild: discord.Guild, value: str, refs: dict[str, str]) -> Any:
    raw = str(value or "").strip()
    if raw in REF_TOKENS:
        if raw not in refs:
            raise ValueError(f"No earlier created resource for {raw}.")
        cid = int(refs[raw])
        return guild.get_channel_or_thread(cid) or await guild.fetch_channel(cid)

    m = re.match(r"^<#(\d{17,20})>$", raw)
    if ID_RE.match(raw) or m:
        cid = int(raw if ID_RE.match(raw) else m.group(1))
        ch = guild.get_channel_or_thread(cid)
        if ch is not None:
            return ch
        return await guild.fetch_channel(cid)

    if not raw and refs.get("$current_channel"):
        cid = int(refs["$current_channel"])
        return guild.get_channel_or_thread(cid) or await guild.fetch_channel(cid)

    fetched = await fetch_guild_channels(guild)
    return resolve_channel_from_list(fetched, raw, refs)


async def resolve_role_ref(guild: discord.Guild, value: str, refs: dict[str, str]) -> discord.Role:
    raw = str(value or "").strip()
    if raw in ("@everyone", "everyone"):
        return guild.default_role
    if raw in REF_TOKENS:
        if raw not in refs:
            raise ValueError(f"No earlier created role for {raw}.")
        role = guild.get_role(int(refs[raw]))
        if role:
            return role
    m = ROLE_MENTION_RE.match(raw)
    if ID_RE.match(raw) or m:
        rid = int(raw if ID_RE.match(raw) else m.group(1))
        role = guild.get_role(rid)
        if role:
            return role
    roles = await guild.fetch_roles()
    return resolve_role_from_list(list(roles), raw, refs)


def _filter_members_by_group(members: list[discord.Member], target_group: str = "everyone") -> list[discord.Member]:
    group = target_group or "everyone"
    if group == "humans":
        return [m for m in members if not m.bot]
    if group == "bots":
        return [m for m in members if m.bot]
    return list(members)


async def _fetch_bytes(url: str) -> bytes:
    async with aiohttp.ClientSession() as session:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status >= 400:
                raise ValueError(f"Failed to download asset ({resp.status}).")
            return await resp.read()


async def execute_step(
    message: discord.Message,
    step: dict[str, Any],
    refs: dict[str, str],
    *,
    trust_level: str = "full",
    db_members: list[dict[str, Any]] | None = None,
    bot_client: discord.Client | None = None,
    actor_member: discord.Member | None = None,
    bot_member_obj: discord.Member | None = None,
    voice_handler: Any = None,
) -> str:
    validate_plan({"actions": [step]})
    guild = message.guild
    if guild is None:
        raise ValueError("Server actions must be run inside a server.")

    actor = actor_member or (message.author if isinstance(message.author, discord.Member) else await guild.fetch_member(message.author.id))
    bot_member = bot_member_obj or guild.me or await guild.fetch_member(guild._state.self_id)
    check_actor = trust_level == "mirror_actor"

    action = step["action"]
    a = dict(step["args"])
    reason = f"Capri request {message.id} by {actor.id}" + (f": {a['reason']}" if a.get("reason") else "")
    perm_flag = ACTIONS[action][0]

    if "channel" not in a or not a.get("channel"):
        if check_actor:
            check_permission(actor, perm_flag, None)
        check_permission(bot_member, perm_flag, None)

    channel = None
    if a.get("channel"):
        channel = await resolve_channel_ref(guild, str(a["channel"]), refs)
        eff_perm = "ManageThreads" if action == "channel_edit" and isinstance(channel, discord.Thread) else perm_flag
        if check_actor:
            check_permission(actor, eff_perm, channel)
            check_permission(actor, "ViewChannel", channel)
        check_permission(bot_member, eff_perm, channel)
        check_permission(bot_member, "ViewChannel", channel)

    role = None
    if a.get("role"):
        role = await resolve_role_ref(guild, str(a["role"]), refs)
        check_role(guild, actor, bot_member, role, check_actor=check_actor, allow_everyone=(action == "role_edit"))

    target = None
    if a.get("user") and action != "member_unban":
        uid = resolve_member_id(guild, str(a["user"]), db_members)
        target = guild.get_member(uid) or await guild.fetch_member(uid)
        allow_self = action in ("role_add", "role_remove", "member_roles_set", "member_nickname", "member_dm", "thread_member_add", "thread_member_remove")
        if action not in ("thread_member_add", "thread_member_remove", "member_dm"):
            check_hierarchy(guild, actor, bot_member, target, allow_self=allow_self, check_actor=check_actor)

    # === READS ===
    if action == "server_inspect":
        in_voice = [f"{m.display_name} in <#{m.voice.channel.id}>" for m in guild.members if m.voice and m.voice.channel]
        return f'Server "{guild.name}" ({guild.id}) | Owner: <@{guild.owner_id}> | Members: {guild.member_count} | Channels: {len(guild.channels)} | Roles: {max(0, len(guild.roles) - 1)} | In Voice: {", ".join(in_voice) or "nobody"}'

    if action == "members_list":
        items = list(guild.members)
        if a.get("inVoiceOnly"):
            items = [m for m in items if m.voice and m.voice.channel]
        if a.get("role"):
            f_role = await resolve_role_ref(guild, str(a["role"]), refs)
            items = [m for m in items if f_role in m.roles]
        if a.get("query"):
            q = str(a["query"]).lower()
            items = [m for m in items if any(q in str(n).lower() for n in (m.display_name, m.name, m.global_name or "", m.nick or "", m.id))]
        cap = int(a.get("limit") or 30)
        shown = [f"{m.display_name} (@{m.name}, {m.id}){' [bot]' if m.bot else ''}" for m in items[:cap]]
        return f"Found {len(items)} member(s):\n" + ("\n".join(shown) or "None.")

    if action == "member_inspect":
        roles_str = ", ".join(r.name for r in sorted(target.roles, key=lambda x: x.position, reverse=True) if r.id != guild.id) or "none"
        return f"Member {target.display_name} (@{target.name}, ID {target.id}) | Roles: {roles_str} | Voice: {f'#{target.voice.channel.name}' if target.voice and target.voice.channel else 'not in voice'}"

    if action == "roles_list":
        roles_out = [f"{r.name} ({r.id}, {r.color}, {len(r.members)} members)" for r in sorted(guild.roles, key=lambda x: x.position, reverse=True) if r.id != guild.id][:40]
        return f"Roles ({max(0, len(guild.roles) - 1)}):\n" + ("\n".join(roles_out) or "None.")

    if action == "channels_list":
        chans = await fetch_guild_channels(guild)
        if a.get("type"):
            chans = [c for c in chans if str(getattr(c.type, "name", "")).startswith(str(a["type"]))]
        lines = [f"#{c.name} ({c.id}) [type:{getattr(c.type, 'name', c.type)}]" for c in sorted(chans, key=lambda x: getattr(x, "position", 0))[:50]]
        return f"Channels ({len(chans)}):\n" + ("\n".join(lines) or "None.")

    if action == "channel_inspect":
        fresh = await guild.fetch_channel(channel.id)
        topic = getattr(fresh, "topic", None) or "(none)"
        slow = getattr(fresh, "slowmode_delay", 0)
        return f"Live channel <#{fresh.id}>: name=#{fresh.name} | ID={fresh.id} | type={getattr(fresh.type, 'name', fresh.type)} | slowmode={slow}s | topic={topic}"

    if action == "channel_read":
        fresh = await guild.fetch_channel(channel.id)
        msgs = [m async for m in fresh.history(limit=int(a.get("limit") or 15))]
        lines = [f"[{m.id}] {m.author.display_name}: {m.content or '[media/embed]'}" for m in reversed(msgs)]
        return f"Live channel <#{fresh.id}> (#{fresh.name})\nLast {len(lines)} message(s) in #{fresh.name}:\n" + ("\n".join(lines) or "(empty)")

    if action == "bans_list":
        bans = [b async for b in guild.bans(limit=int(a.get("limit") or 50))]
        return f"Bans ({len(bans)}):\n" + ("\n".join(f"{b.user.name} ({b.user.id}) — {b.reason or 'no reason'}" for b in bans) or "None.")

    if action == "invites_list":
        invs = await guild.invites()
        return f"Active invites ({len(invs)}):\n" + ("\n".join(f"{i.code} -> #{getattr(i.channel, 'name', '?')} ({i.uses}/{i.max_uses or '∞'})" for i in invs[:30]) or "None.")

    if action == "webhooks_list":
        hooks = await (channel.webhooks() if channel else guild.webhooks())
        return f"Webhooks ({len(hooks)}):\n" + ("\n".join(f"{w.name} ({w.id}) in <#{w.channel_id}>" for w in hooks) or "None.")

    if action == "emojis_list":
        return f"Emojis ({len(guild.emojis)}): " + (", ".join(f"{e.name} ({e.id})" for e in guild.emojis[:40]) or "none")

    if action == "events_list":
        evs = await guild.fetch_scheduled_events()
        return f"Scheduled events ({len(evs)}):\n" + ("\n".join(f"{e.name} ({e.id})" for e in evs) or "None.")

    if action == "automod_list":
        rules = await guild.fetch_automod_rules()
        return f"AutoMod rules ({len(rules)}):\n" + ("\n".join(f"{r.name} ({r.id}) [{'enabled' if r.enabled else 'disabled'}]" for r in rules) or "None.")

    if action == "audit_logs_read":
        entries = [e async for e in guild.audit_logs(limit=int(a.get("limit") or 15))]
        return "Recent audit log entries:\n" + ("\n".join(f"{e.action.name} by {getattr(e.user, 'name', '?')} on {e.target}" for e in entries) or "None.")

    if action == "server_backup_snapshot":
        chans = await fetch_guild_channels(guild)
        roles_summary = [f"{r.name}({r.color})" for r in sorted(guild.roles, key=lambda x: x.position, reverse=True) if r.id != guild.id][:15]
        chans_summary = [f"#{c.name}[{getattr(c.type, 'name', c.type)}]" for c in sorted(chans, key=lambda x: getattr(x, "position", 0))][:40]
        return f'Backup snapshot of "{guild.name}" ({guild.id}): {max(0, len(guild.roles) - 1)} roles [{", ".join(roles_summary)}], {len(chans)} channels [{", ".join(chans_summary)}]'

    # === SERVER MUTATIONS & BOT PRESENCE ===
    if action == "server_rename":
        await guild.edit(name=a["name"], reason=reason)
        return f'Server renamed to "{a["name"]}".'
    if action == "server_description":
        await guild.edit(description=a["description"] or None, reason=reason)
        return "Server description updated."
    if action == "server_edit":
        kw: dict[str, Any] = {"reason": reason}
        if "name" in a:
            kw["name"] = a["name"]
        if "description" in a:
            kw["description"] = a["description"] or None
        if "afkTimeout" in a:
            kw["afk_timeout"] = a["afkTimeout"]
        if "afkChannel" in a:
            kw["afk_channel"] = await resolve_channel_ref(guild, str(a["afkChannel"]), refs)
        if "systemChannel" in a:
            kw["system_channel"] = await resolve_channel_ref(guild, str(a["systemChannel"]), refs)
        if "rulesChannel" in a:
            kw["rules_channel"] = await resolve_channel_ref(guild, str(a["rulesChannel"]), refs)
        if "preferredLocale" in a:
            kw["preferred_locale"] = a["preferredLocale"]
        await guild.edit(**kw)
        return f'Updated server settings for "{guild.name}".'
    if action == "bot_presence_set":
        updates = []
        client_obj = bot_client or getattr(guild._state, "_get_client", lambda: None)()
        if client_obj and ("status" in a or "activityText" in a or "activityType" in a):
            st = STATUS_MAP.get(a.get("status", "online"), discord.Status.online)
            act = None
            if a.get("activityText"):
                act_type = ACTIVITY_MAP.get(a.get("activityType", "playing"), discord.ActivityType.playing)
                act = discord.Activity(type=act_type, name=a["activityText"])
            await client_obj.change_presence(status=st, activity=act)
            updates.append(f"presence={a.get('status', 'online')}")
        if "nickname" in a:
            await bot_member.edit(nick=a["nickname"] or None, reason=reason)
            updates.append(f'nickname="{a["nickname"] or "(reset)"}"')
        return f"Updated Capri: {', '.join(updates) or 'presence refreshed'}."

    # === ROLES & BULK ROLES ===
    if action == "role_create":
        perms = discord.Permissions()
        for p in a.get("permissions") or []:
            if p in PERM_MAP:
                setattr(perms, PERM_MAP[p], True)
        color = discord.Color.from_str(a["color"]) if a.get("color") else discord.Color.default()
        created = await guild.create_role(
            name=a["name"],
            permissions=perms,
            color=color,
            hoist=bool(a.get("hoist", False)),
            mentionable=bool(a.get("mentionable", False)),
            reason=reason,
        )
        refs["$last_role"] = str(created.id)
        return f"Created role {created.name} ({created.id})."

    if action == "role_edit":
        kw = {"reason": reason}
        if role.id != guild.id:
            if "name" in a:
                kw["name"] = a["name"]
            if "color" in a:
                kw["color"] = discord.Color.from_str(a["color"])
            if "hoist" in a:
                kw["hoist"] = a["hoist"]
            if "mentionable" in a:
                kw["mentionable"] = a["mentionable"]
            if "position" in a:
                kw["position"] = a["position"]
        if "permissions" in a:
            perms = discord.Permissions()
            for p in a["permissions"]:
                if p in PERM_MAP:
                    setattr(perms, PERM_MAP[p], True)
            kw["permissions"] = perms
        await role.edit(**kw)
        return f"Updated role {role.name} ({role.id})."

    if action == "role_delete":
        await role.delete(reason=reason)
        return f"Deleted role {role.name}."

    if action == "roles_bulk_delete":
        resolved_roles = []
        for r_ref in a["roles"]:
            r_obj = await resolve_role_ref(guild, str(r_ref), refs)
            check_role(guild, actor, bot_member, r_obj, check_actor=check_actor)
            resolved_roles.append(r_obj)
        deleted_names = []
        for r_obj in resolved_roles:
            deleted_names.append(r_obj.name)
            await r_obj.delete(reason=reason)
        return f"Deleted {len(deleted_names)} role(s): {', '.join(deleted_names)}."

    if action == "role_add":
        await target.add_roles(role, reason=reason)
        return f'Added role "{role.name}" to <@{target.id}>.'

    if action == "role_remove":
        await target.remove_roles(role, reason=reason)
        return f'Removed role "{role.name}" from <@{target.id}>.'

    if action in ("role_add_all", "role_remove_all"):
        pool = _filter_members_by_group(list(guild.members), a.get("targetGroup", "everyone"))
        if a.get("filterRole"):
            f_role = await resolve_role_ref(guild, str(a["filterRole"]), refs)
            pool = [m for m in pool if f_role in m.roles]
        changed = 0
        skipped = 0
        failed = 0
        for m in pool:
            has_role = role in m.roles
            if (action == "role_add_all" and has_role) or (action == "role_remove_all" and not has_role):
                skipped += 1
                continue
            try:
                if action == "role_add_all":
                    await m.add_roles(role, reason=reason)
                else:
                    await m.remove_roles(role, reason=reason)
                changed += 1
            except Exception:
                failed += 1
        verb = "Added" if action == "role_add_all" else "Removed"
        prep = "to" if action == "role_add_all" else "from"
        return f'{verb} role "{role.name}" {prep} {changed} member(s) ({a.get("targetGroup", "everyone")}; {skipped} skipped{f", {failed} failed" if failed else ""}).'

    if action == "member_roles_set":
        roles_to_set = [await resolve_role_ref(guild, str(r), refs) for r in a["roles"]]
        for r_obj in roles_to_set:
            check_role(guild, actor, bot_member, r_obj, check_actor=check_actor)
        await target.edit(roles=roles_to_set, reason=reason)
        return f"Updated roles for <@{target.id}> ({len(roles_to_set)} role(s))."

    # === CHANNELS ===
    if action == "channel_create":
        method_name = CHANNEL_TYPE_METHODS.get(a["type"], "create_text_channel")
        creator = getattr(guild, method_name)
        kw = {"name": a["name"], "reason": reason}
        if a.get("parent"):
            parent = await resolve_channel_ref(guild, str(a["parent"]), refs)
            kw["category"] = parent
        if "topic" in a and a["type"] in ("text", "announcement", "forum"):
            kw["topic"] = a["topic"]
        if "slowmode" in a and a["type"] in ("text", "announcement", "forum"):
            kw["slowmode_delay"] = a["slowmode"]
        if "nsfw" in a and a["type"] != "category":
            kw["nsfw"] = a["nsfw"]
        if "position" in a:
            kw["position"] = a["position"]
        if a["type"] == "announcement":
            kw["news"] = True
        created = await creator(**kw)
        if a["type"] == "category":
            refs["$last_category"] = str(created.id)
        refs["$last_channel"] = str(created.id)
        return f"Created {a['type']} channel {created.name} ({created.id})."

    if action in ("channel_rename", "channel_edit"):
        live_before = await guild.fetch_channel(channel.id)
        before_name = live_before.name
        kw = {"reason": reason}
        requested_rename = None
        if "name" in a and a["name"] is not None:
            formatted = format_channel_name(a["name"], live_before.type)
            if formatted != before_name:
                kw["name"] = formatted
                requested_rename = formatted
        if "topic" in a:
            kw["topic"] = a["topic"] or None
        if "slowmode" in a:
            kw["slowmode_delay"] = a["slowmode"]
        if "nsfw" in a:
            kw["nsfw"] = a["nsfw"]
        if "position" in a:
            kw["position"] = a["position"]
        if "bitrate" in a:
            kw["bitrate"] = a["bitrate"]
        if "userLimit" in a:
            kw["user_limit"] = a["userLimit"]
        if a.get("clearParent"):
            kw["category"] = None
        elif a.get("parent"):
            kw["category"] = await resolve_channel_ref(guild, str(a["parent"]), refs)

        if len(kw) == 1 and "name" in a:
            return f"Channel <#{live_before.id}> is already named #{before_name} (no edit needed)."
        if len(kw) <= 1:
            raise ValueError("Specify what to change on the channel (name, topic, slowmode, nsfw, or parent).")

        try:
            await asyncio.wait_for(live_before.edit(**kw), timeout=10.0)
        except asyncio.TimeoutError:
            raise ValueError(f"Discord rate-limited channel edits on #{before_name} (2 renames per 10 minutes per channel cap). Wait a few minutes and try again.")
        except discord.RateLimited as rl:
            raise ValueError(f"Discord rate-limited channel edits on #{before_name}. Retry in ~{int(rl.retry_after) + 1}s.")
        except discord.HTTPException as exc:
            if exc.status == 429:
                raise ValueError(f"Discord rate-limited channel edits on #{before_name} (HTTP 429). Wait a few minutes and try again.")
            raise ValueError(f"Discord API error editing channel: {exc}")

        verified = await guild.fetch_channel(live_before.id)
        if requested_rename is not None and verified.name != requested_rename:
            raise ValueError(f"Discord did not apply rename on <#{verified.id}> (still #{verified.name} instead of #{requested_rename}).")

        if requested_rename is not None:
            return f"Updated <#{verified.id}>: renamed #{before_name} -> #{verified.name}."
        return f"Updated <#{verified.id}> (#{verified.name})."

    if action == "channel_clone":
        cloned = await channel.clone(name=a.get("name") or f"{channel.name}-copy", reason=reason)
        refs["$last_channel"] = str(cloned.id)
        return f"Cloned #{channel.name} to #{cloned.name} ({cloned.id})."

    if action == "channel_permissions_set":
        target_obj = guild.default_role if a["target"] in ("@everyone", "everyone") else (
            await resolve_role_ref(guild, str(a["target"]), refs) if a["targetType"] == "role" else (
                guild.get_member(resolve_member_id(guild, str(a["target"]), db_members))
                or await guild.fetch_member(resolve_member_id(guild, str(a["target"]), db_members))
            )
        )
        overwrite = channel.overwrites_for(target_obj)
        for p in a.get("allow") or []:
            if p in PERM_MAP:
                setattr(overwrite, PERM_MAP[p], True)
        for p in a.get("deny") or []:
            if p in PERM_MAP:
                setattr(overwrite, PERM_MAP[p], False)
        await channel.set_permissions(target_obj, overwrite=overwrite, reason=reason)
        return f"Updated permission overwrites on #{channel.name} for {a['target']}."

    if action == "channel_permissions_delete":
        target_obj = guild.default_role if a["target"] in ("@everyone", "everyone") else (
            await resolve_role_ref(guild, str(a["target"]), refs) if a["targetType"] == "role" else await guild.fetch_member(resolve_member_id(guild, str(a["target"]), db_members))
        )
        await channel.set_permissions(target_obj, overwrite=None, reason=reason)
        return f"Cleared permission overwrites on #{channel.name} for {a['target']}."

    if action == "channel_sync_permissions":
        await channel.edit(sync_permissions=True, reason=reason)
        return f"Synced #{channel.name} permissions with its parent category."

    if action == "channel_delete":
        name = channel.name
        cid = channel.id
        await channel.delete(reason=reason)
        return f"Deleted channel #{name} ({cid})."

    if action == "channels_bulk_delete":
        targets = []
        for ch_ref in a["channels"]:
            ch = await resolve_channel_ref(guild, str(ch_ref), refs)
            if check_actor:
                check_permission(actor, "ManageChannels", ch)
            check_permission(bot_member, "ManageChannels", ch)
            targets.append(ch)
        deleted = []
        for ch in targets:
            deleted.append(f"#{ch.name}")
            await ch.delete(reason=reason)
        return f"Deleted {len(deleted)} channel(s): {', '.join(deleted)}."

    # === MEMBERS & VOICE ===
    if action == "member_ban":
        await target.ban(reason=reason, delete_message_seconds=int(a.get("deleteMessageDays") or 0) * 86400)
        return f"Banned <@{target.id}>."
    if action == "member_unban":
        await guild.unban(discord.Object(id=int(a["user"])), reason=reason)
        return f"Unbanned user {a['user']}."
    if action == "member_kick":
        await target.kick(reason=reason)
        return f"Kicked <@{target.id}>."
    if action == "member_timeout":
        mins = int(a["minutes"])
        until = discord.utils.utcnow() + datetime.timedelta(minutes=mins) if mins > 0 else None
        await target.timeout(until, reason=reason)
        return f"Timed out <@{target.id}> for {mins} minutes." if mins > 0 else f"Removed timeout from <@{target.id}>."
    if action == "member_nickname":
        await target.edit(nick=a["nickname"] or None, reason=reason)
        return f'Changed <@{target.id}>\'s nickname to "{a["nickname"]}".' if a["nickname"] else f"Cleared <@{target.id}>'s nickname."
    if action == "members_nickname_all":
        pool = _filter_members_by_group(list(guild.members), a.get("targetGroup", "everyone"))
        updated_cnt = 0
        skipped_cnt = 0
        for m in pool:
            if m.id == guild.owner_id or bot_member.top_role <= m.top_role:
                skipped_cnt += 1
                continue
            try:
                await m.edit(nick=a["nickname"] or None, reason=reason)
                updated_cnt += 1
            except Exception:
                skipped_cnt += 1
        return f"Updated nicknames for {updated_cnt} member(s) ({skipped_cnt} skipped)."
    if action == "members_prune":
        if a.get("computeOnly"):
            est = await guild.estimate_pruned_members(days=int(a["days"]))
            return f"Dry-run prune estimate ({a['days']}d inactive): {est} member(s) would be pruned."
        pruned = await guild.prune_members(days=int(a["days"]), compute_prune_count=True, reason=reason)
        return f"Pruned {pruned} inactive member(s) ({a['days']}d threshold)."
    if action == "member_dm":
        await target.send(a["content"], allowed_mentions=discord.AllowedMentions.none())
        return f"Sent DM to <@{target.id}>."
    if action == "member_move":
        dest = await resolve_channel_ref(guild, str(a["channel"]), refs)
        await target.move_to(dest, reason=reason)
        return f"Moved <@{target.id}> to #{dest.name}."
    if action == "member_disconnect":
        await target.move_to(None, reason=reason)
        return f"Disconnected <@{target.id}> from voice."
    if action == "member_mute":
        await target.edit(mute=bool(a["enabled"]), reason=reason)
        return f"{'Server-muted' if a['enabled'] else 'Unmuted'} <@{target.id}> in voice."
    if action == "member_deafen":
        await target.edit(deafen=bool(a["enabled"]), reason=reason)
        return f"{'Server-deafened' if a['enabled'] else 'Undeafened'} <@{target.id}> in voice."
    if action == "voice_move_all":
        dest = await resolve_channel_ref(guild, str(a["toChannel"]), refs)
        from_ch = await resolve_channel_ref(guild, str(a["fromChannel"]), refs) if a.get("fromChannel") else None
        moved = 0
        for m in guild.members:
            if m.voice and m.voice.channel and (not from_ch or m.voice.channel.id == from_ch.id) and m.voice.channel.id != dest.id:
                try:
                    await m.move_to(dest, reason=reason)
                    moved += 1
                except Exception:
                    pass
        return f"Moved {moved} member(s) to #{dest.name}."
    if action == "voice_disconnect_all":
        cnt = 0
        for m in guild.members:
            if m.voice and m.voice.channel and (not channel or m.voice.channel.id == channel.id):
                try:
                    await m.move_to(None, reason=reason)
                    cnt += 1
                except Exception:
                    pass
        return f"Disconnected {cnt} member(s) from voice."
    if action == "voice_mute_all":
        cnt = 0
        for m in guild.members:
            if m.voice and m.voice.channel and (not channel or m.voice.channel.id == channel.id):
                try:
                    await m.edit(mute=bool(a["enabled"]), reason=reason)
                    cnt += 1
                except Exception:
                    pass
        return f"{'Muted' if a['enabled'] else 'Unmuted'} {cnt} member(s) in voice."
    if action == "voice_deafen_all":
        cnt = 0
        for m in guild.members:
            if m.voice and m.voice.channel and (not channel or m.voice.channel.id == channel.id):
                try:
                    await m.edit(deafen=bool(a["enabled"]), reason=reason)
                    cnt += 1
                except Exception:
                    pass
        return f"{'Deafened' if a['enabled'] else 'Undeafened'} {cnt} member(s) in voice."
    if action == "voice_status_set":
        await guild._state.http.request(
            discord.http.Route("PUT", "/channels/{channel_id}/voice-status", channel_id=channel.id),
            json={"status": a["status"]},
        )
        return f'Set voice status on #{channel.name} to "{a["status"] or "(cleared)"}".'
    if action in ("voice_join", "voice_say"):
        if voice_handler is None:
            raise RuntimeError("Live voice engine is not initialized.")
        target_vc = None
        if channel is not None and isinstance(channel, (discord.VoiceChannel, discord.StageChannel)):
            target_vc = channel
        elif actor.voice and actor.voice.channel:
            target_vc = actor.voice.channel
        elif action == "voice_join":
            populated = [vc for vc in guild.voice_channels if len(vc.members) > 0]
            target_vc = (populated[0] if populated else (guild.voice_channels[0] if guild.voice_channels else None))

        if action == "voice_join":
            if target_vc is None:
                raise ValueError("Join a voice channel first or name which voice channel to hop into.")
            return await voice_handler("join", guild=guild, voice_channel=target_vc, text_channel=message.channel)

        return await voice_handler("say", guild=guild, text=a["text"], voice_channel=target_vc, text_channel=message.channel)
    if action == "voice_leave":
        if voice_handler is None:
            raise RuntimeError("Live voice engine is not initialized.")
        return await voice_handler("leave", guild=guild, text_channel=message.channel)
    if action == "stage_start":
        stage = await channel.create_instance(topic=a["topic"], privacy_level=discord.StagePrivacyLevel.guild_only, reason=reason)
        return f'Started stage in #{channel.name}: "{stage.topic}".'
    if action == "stage_edit":
        stage = channel.instance
        if not stage:
            raise ValueError("No active stage instance in this channel.")
        await stage.edit(topic=a["topic"], reason=reason)
        return f'Updated stage topic in #{channel.name} to "{a["topic"]}".'
    if action == "stage_end":
        stage = channel.instance
        if not stage:
            raise ValueError("No active stage instance in this channel.")
        await stage.delete(reason=reason)
        return f"Ended stage in #{channel.name}."

    # === MESSAGES & POLLS ===
    if action == "message_send":
        embed = None
        if a.get("embedTitle") or a.get("embedDescription"):
            col = discord.Color.from_str(a["embedColor"]) if a.get("embedColor") else discord.Color.amber()
            embed = discord.Embed(title=a.get("embedTitle"), description=a.get("embedDescription"), color=col)
        mentions = discord.AllowedMentions(users=True, roles=True) if a.get("allowMentions") else discord.AllowedMentions.none()
        ref = discord.MessageReference(message_id=int(a["replyTo"]), channel_id=channel.id) if a.get("replyTo") else None
        sent = await channel.send(content=a.get("content"), embed=embed, allowed_mentions=mentions, reference=ref)
        return f"Sent message {sent.id} in <#{channel.id}>."
    if action == "poll_send":
        poll = discord.Poll(
            question=a["question"],
            duration=datetime.timedelta(hours=int(a.get("hours", 24))),
            multiple=bool(a.get("allowMultiselect", False)),
        )
        for ans in a["answers"][:10]:
            poll.add_answer(text=ans)
        sent = await channel.send(poll=poll)
        return f'Created poll "{a["question"]}" ({sent.id}) in <#{channel.id}>.'
    if action == "message_edit":
        msg = await channel.fetch_message(int(a["message"]))
        await msg.edit(content=a["content"], allowed_mentions=discord.AllowedMentions.none())
        return f"Edited message {msg.id}."
    if action == "message_react":
        msg = await channel.fetch_message(int(a["message"]))
        await msg.add_reaction(a["emoji"])
        return f"Reacted {a['emoji']} to message {msg.id}."
    if action == "message_reactions_clear":
        msg = await channel.fetch_message(int(a["message"]))
        await msg.clear_reactions()
        return f"Cleared all reactions on message {msg.id}."
    if action == "message_pin":
        msg = await channel.fetch_message(int(a["message"]))
        await msg.pin(reason=reason)
        return f"Pinned message {msg.id} in #{channel.name}."
    if action == "message_unpin":
        msg = await channel.fetch_message(int(a["message"]))
        await msg.unpin(reason=reason)
        return f"Unpinned message {msg.id} in #{channel.name}."
    if action == "message_delete":
        msg = await channel.fetch_message(int(a["message"]))
        await msg.delete()
        return f"Deleted message {msg.id} in #{channel.name}."
    if action == "message_purge":
        filter_uid = resolve_member_id(guild, str(a["user"]), db_members) if a.get("user") else None
        deleted = await channel.purge(limit=int(a["count"]), check=(lambda m: m.author.id == filter_uid) if filter_uid else None, reason=reason)
        return f"Purged {len(deleted)} message(s) in #{channel.name}."

    # === THREADS ===
    if action == "thread_create":
        if isinstance(channel, discord.ForumChannel):
            created = await channel.create_thread(name=a["name"], content=a.get("message") or a["name"], reason=reason)
            thread = created.thread
        else:
            t_type = discord.ChannelType.private_thread if a.get("private") else discord.ChannelType.public_thread
            thread = await channel.create_thread(name=a["name"], type=t_type, auto_archive_duration=1440, reason=reason)
            if a.get("message"):
                await thread.send(a["message"], allowed_mentions=discord.AllowedMentions.none())
        refs["$last_thread"] = str(thread.id)
        refs["$last_channel"] = str(thread.id)
        return f'Created thread "{thread.name}" ({thread.id}).'
    if action == "thread_edit":
        kw = {"reason": reason}
        if "name" in a:
            kw["name"] = a["name"]
        if "archived" in a:
            kw["archived"] = a["archived"]
        if "locked" in a:
            kw["locked"] = a["locked"]
        if "slowmode" in a:
            kw["slowmode_delay"] = a["slowmode"]
        await channel.edit(**kw)
        return f'Updated thread "{channel.name}".'
    if action == "thread_member_add":
        await channel.add_user(target)
        return f"Added <@{target.id}> to thread #{channel.name}."
    if action == "thread_member_remove":
        await channel.remove_user(target)
        return f"Removed <@{target.id}> from thread #{channel.name}."
    if action == "thread_delete":
        t_name = channel.name
        await channel.delete()
        return f'Deleted thread "{t_name}".'

    # === WEBHOOKS ===
    if action == "webhook_create":
        avatar = await _fetch_bytes(a["avatarUrl"]) if a.get("avatarUrl") else None
        hook = await channel.create_webhook(name=a["name"], avatar=avatar, reason=reason)
        refs["$last_webhook"] = str(hook.id)
        return f'Created webhook "{hook.name}" ({hook.id}) in #{channel.name}.'
    if action in ("webhook_edit", "webhook_send", "webhook_delete"):
        wid = refs.get(a["webhook"], a["webhook"])
        hooks = await guild.webhooks()
        hook = next((h for h in hooks if str(h.id) == str(wid) or h.name.lower() == str(wid).lower()), None)
        if not hook:
            raise ValueError("Webhook not found.")
        if action == "webhook_edit":
            dest = await resolve_channel_ref(guild, str(a["channel"]), refs) if a.get("channel") else discord.utils.MISSING
            await hook.edit(name=a.get("name") or discord.utils.MISSING, channel=dest, reason=reason)
            return f'Updated webhook "{hook.name}".'
        if action == "webhook_send":
            await hook.send(content=a["content"], username=a.get("username"), avatar_url=a.get("avatarUrl"), allowed_mentions=discord.AllowedMentions.none())
            return f'Sent webhook message via "{hook.name}".'
        await hook.delete(reason=reason)
        return f'Deleted webhook "{hook.name}".'

    # === EMOJIS & STICKERS ===
    if action == "emoji_create":
        img = await _fetch_bytes(a["imageUrl"])
        emoji = await guild.create_custom_emoji(name=a["name"], image=img, reason=reason)
        return f"Created emoji :{emoji.name}: ({emoji.id})."
    if action in ("emoji_edit", "emoji_delete"):
        emojis = await guild.fetch_emojis()
        target_e = next((e for e in emojis if str(e.id) == str(a["emoji"]) or e.name.lower() == str(a["emoji"]).strip(":").lower()), None)
        if not target_e:
            raise ValueError(f'Emoji "{a["emoji"]}" not found.')
        if action == "emoji_edit":
            await target_e.edit(name=a["name"], reason=reason)
            return f"Renamed emoji to :{a['name']}:."
        await target_e.delete(reason=reason)
        return f"Deleted emoji :{target_e.name}:."
    if action == "sticker_create":
        img = await _fetch_bytes(a["imageUrl"])
        from io import BytesIO
        sticker = await guild.create_sticker(name=a["name"], description=a.get("description") or "", emoji=a["tags"], file=discord.File(BytesIO(img), filename="sticker.png"), reason=reason)
        return f'Created sticker "{sticker.name}" ({sticker.id}).'
    if action == "sticker_delete":
        stickers = await guild.fetch_stickers()
        target_s = next((s for s in stickers if str(s.id) == str(a["sticker"]) or s.name.lower() == str(a["sticker"]).lower()), None)
        if not target_s:
            raise ValueError(f'Sticker "{a["sticker"]}" not found.')
        await target_s.delete(reason=reason)
        return f'Deleted sticker "{target_s.name}".'

    # === EVENTS ===
    if action == "event_create":
        etype = {"voice": discord.EntityType.voice, "stage": discord.EntityType.stage_instance, "external": discord.EntityType.external}[a["entityType"]]
        ch_obj = await resolve_channel_ref(guild, str(a["channel"]), refs) if a.get("channel") else discord.utils.MISSING
        start_dt = datetime.datetime.fromisoformat(a["startTimeIso"].replace("Z", "+00:00"))
        end_dt = datetime.datetime.fromisoformat(a["endTimeIso"].replace("Z", "+00:00")) if a.get("endTimeIso") else discord.utils.MISSING
        ev = await guild.create_scheduled_event(
            name=a["name"],
            start_time=start_dt,
            end_time=end_dt,
            privacy_level=discord.PrivacyLevel.guild_only,
            entity_type=etype,
            channel=ch_obj,
            location=a.get("location") or discord.utils.MISSING,
            description=a.get("description") or discord.utils.MISSING,
            reason=reason,
        )
        return f'Created event "{ev.name}" ({ev.id}).'
    if action in ("event_edit", "event_delete"):
        ev = await guild.fetch_scheduled_event(int(a["event"]))
        if action == "event_delete":
            await ev.delete()
            return f'Deleted scheduled event "{ev.name}".'
        await ev.edit(
            name=a.get("name") or discord.utils.MISSING,
            description=a.get("description") if "description" in a else discord.utils.MISSING,
            location=a.get("location") or discord.utils.MISSING,
            reason=reason,
        )
        return f'Updated scheduled event "{ev.name}".'

    # === AUTOMOD ===
    if action == "automod_create":
        trigger = discord.AutoModTrigger(
            type=discord.AutoModRuleTriggerType.mention_spam if a.get("mentionLimit") else discord.AutoModRuleTriggerType.keyword,
            mention_total_limit=a.get("mentionLimit"),
            keyword_filter=a.get("keywords") or [],
            regex_patterns=a.get("regexPatterns") or [],
        )
        am_actions = []
        if a.get("blockMessage", True):
            am_actions.append(discord.AutoModRuleAction(type=discord.AutoModAction.block_message))
        if a.get("timeoutSeconds"):
            am_actions.append(discord.AutoModRuleAction(type=discord.AutoModAction.timeout, duration=datetime.timedelta(seconds=int(a["timeoutSeconds"]))))
        if a.get("alertChannel"):
            ac = await resolve_channel_ref(guild, str(a["alertChannel"]), refs)
            am_actions.append(discord.AutoModRuleAction(type=discord.AutoModAction.send_alert_message, channel_id=ac.id))
        rule = await guild.create_automod_rule(
            name=a["name"],
            event_type=discord.AutoModRuleEventType.message_send,
            trigger=trigger,
            actions=am_actions,
            enabled=a.get("enabled", True),
            reason=reason,
        )
        return f'Created AutoMod rule "{rule.name}" ({rule.id}).'
    if action in ("automod_edit", "automod_delete"):
        rule = await guild.fetch_automod_rule(int(a["rule"]))
        if action == "automod_delete":
            await rule.delete(reason=reason)
            return f'Deleted AutoMod rule "{rule.name}".'
        await rule.edit(name=a.get("name") or discord.utils.MISSING, enabled=a.get("enabled", discord.utils.MISSING), reason=reason)
        return f'Updated AutoMod rule "{rule.name}".'

    # === INVITES ===
    if action == "invite_create":
        inv = await channel.create_invite(
            max_age=int(a.get("maxAgeHours", 24)) * 3600,
            max_uses=int(a.get("maxUses", 0)),
            temporary=bool(a.get("temporary", False)),
            unique=True,
            reason=reason,
        )
        return f"Created invite: {inv.url}"
    if action == "invite_delete":
        invs = await guild.invites()
        inv = next((i for i in invs if i.code == a["code"]), None)
        if not inv:
            raise ValueError(f'Invite "{a["code"]}" not found.')
        await inv.delete(reason=reason)
        return f"Deleted invite {a['code']}."

    raise ValueError(f"Unsupported action: {action}")


async def execute_plan(
    message: discord.Message,
    plan: dict[str, Any],
    *,
    trust_level: str = "full",
    db_members: list[dict[str, Any]] | None = None,
    bot_client: discord.Client | None = None,
    voice_handler: Any = None,
) -> list[str]:
    normalized = normalize_plan(plan, str(message.channel.id), message.content or "")
    validate_plan(normalized)
    guild = message.guild
    actor = None
    bot_member = None
    if guild is not None:
        actor = message.author if isinstance(message.author, discord.Member) else await guild.fetch_member(message.author.id)
        bot_member = guild.me or await guild.fetch_member(guild._state.self_id)

    results: list[str] = []
    refs: dict[str, str] = {"$current_channel": str(message.channel.id)}
    for idx, step in enumerate(normalized["actions"], start=1):
        try:
            res = await execute_step(
                message,
                step,
                refs,
                trust_level=trust_level,
                db_members=db_members,
                bot_client=bot_client,
                actor_member=actor,
                bot_member_obj=bot_member,
                voice_handler=voice_handler,
            )
            results.append(res)
        except Exception as exc:
            results.append(f"Step {idx} ({step['action']}) failed: {exc}")
            break
    return results


class ConfirmDeleteView(discord.ui.View):
    def __init__(self, author_id: int):
        super().__init__(timeout=120)
        self.author_id = author_id
        self.confirmed: bool | None = None

    @discord.ui.button(label="Confirm deletion", style=discord.ButtonStyle.danger)
    async def confirm_btn(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("Only the requester can confirm this.", ephemeral=True)
            return
        self.confirmed = True
        for child in self.children:
            child.disabled = True  # type: ignore[attr-defined]
        await interaction.response.defer()
        self.stop()

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel_btn(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("Only the requester can cancel this.", ephemeral=True)
            return
        self.confirmed = False
        for child in self.children:
            child.disabled = True  # type: ignore[attr-defined]
        await interaction.response.defer()
        self.stop()
