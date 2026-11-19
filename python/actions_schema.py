import re
from typing import Any

ID_RE = re.compile(r"^\d{17,20}$")
CHANNEL_MENTION_RE = re.compile(r"^<#(\d{17,20})>$")
ROLE_MENTION_RE = re.compile(r"^<@&(\d{17,20})>$")
HEX_COLOR_RE = re.compile(r"^#[\da-fA-F]{6}$")
RAW_HEX_RE = re.compile(r"^[\da-fA-F]{6}$")
SNOWFLAKE_READ_RE = re.compile(r"\b(?:read|check|show|open|fetch)\b[\s\S]*\b\d{17,20}\b", re.IGNORECASE)
RENAME_EXTRACT_RE = re.compile(
    r"\b(?:rename|renmae|change(?:\s+the)?\s+name(?:\s+of)?|call|set(?:\s+channel)?\s+name)\b[\s\S]{0,60}?\bto\s+[\"'`#]?([^\n\"'`]{1,100})",
    re.IGNORECASE,
)

VALID_PERMISSION_FLAGS = {
    "CreateInstantInvite", "KickMembers", "BanMembers", "Administrator",
    "ManageChannels", "ManageGuild", "AddReactions", "ViewAuditLog",
    "PrioritySpeaker", "Stream", "ViewChannel", "SendMessages",
    "SendTTSMessages", "ManageMessages", "EmbedLinks", "AttachFiles",
    "ReadMessageHistory", "MentionEveryone", "UseExternalEmojis",
    "ViewGuildInsights", "Connect", "Speak", "MuteMembers", "DeafenMembers",
    "MoveMembers", "UseVAD", "ChangeNickname", "ManageNicknames",
    "ManageRoles", "ManageWebhooks", "ManageGuildExpressions",
    "ManageEvents", "ManageThreads", "CreatePublicThreads",
    "CreatePrivateThreads", "SendMessagesInThreads", "ModerateMembers",
}

DELETE_ACTIONS = {
    "role_delete",
    "roles_bulk_delete",
    "channel_delete",
    "channels_bulk_delete",
    "channel_permissions_delete",
    "thread_delete",
    "message_delete",
    "message_purge",
    "message_reactions_clear",
    "members_prune",
    "webhook_delete",
    "emoji_delete",
    "sticker_delete",
    "event_delete",
    "automod_delete",
    "invite_delete",
}

ACTIONS: dict[str, tuple[str, dict[str, str]]] = {
    # READS
    "server_inspect": ("ViewChannel", {}),
    "members_list": ("ViewChannel", {"query": "?text100", "role": "?ref", "inVoiceOnly": "?boolean", "limit": "?listLimit"}),
    "member_inspect": ("ViewChannel", {"user": "member"}),
    "roles_list": ("ViewChannel", {}),
    "channels_list": ("ViewChannel", {"type": "?channelType"}),
    "channel_inspect": ("ViewChannel", {"channel": "ref"}),
    "channel_read": ("ReadMessageHistory", {"channel": "ref", "limit": "?readLimit"}),
    "bans_list": ("BanMembers", {"limit": "?listLimit"}),
    "invites_list": ("ManageGuild", {}),
    "webhooks_list": ("ManageWebhooks", {"channel": "?ref"}),
    "emojis_list": ("ViewChannel", {}),
    "events_list": ("ViewChannel", {}),
    "automod_list": ("ManageGuild", {}),
    "audit_logs_read": ("ViewAuditLog", {"limit": "?readLimit"}),
    "server_backup_snapshot": ("ViewChannel", {}),
    # SERVER & BOT
    "server_rename": ("ManageGuild", {"name": "text100"}),
    "server_description": ("ManageGuild", {"description": "text1000"}),
    "server_edit": (
        "ManageGuild",
        {
            "name": "?text100",
            "description": "?text1000",
            "verificationLevel": "?verificationLevel",
            "explicitContentFilter": "?contentFilter",
            "defaultNotifications": "?notificationLevel",
            "afkChannel": "?ref",
            "afkTimeout": "?afkTimeout",
            "systemChannel": "?ref",
            "rulesChannel": "?ref",
            "preferredLocale": "?text16",
            "iconUrl": "?url",
            "bannerUrl": "?url",
            "splashUrl": "?url",
            "premiumProgressBar": "?boolean",
        },
    ),
    "bot_presence_set": (
        "ViewChannel",
        {
            "status": "?presenceStatus",
            "activityType": "?activityType",
            "activityText": "?text128",
            "nickname": "?text32",
        },
    ),
    # ROLES & BULK ROLES
    "role_create": (
        "ManageRoles",
        {
            "name": "text100",
            "color": "?color",
            "hoist": "?boolean",
            "mentionable": "?boolean",
            "permissions": "?permissions",
            "position": "?position",
            "unicodeEmoji": "?text16",
        },
    ),
    "role_edit": (
        "ManageRoles",
        {
            "role": "ref",
            "name": "?text100",
            "color": "?color",
            "hoist": "?boolean",
            "mentionable": "?boolean",
            "permissions": "?permissions",
            "position": "?position",
        },
    ),
    "role_delete": ("ManageRoles", {"role": "ref"}),
    "roles_bulk_delete": ("ManageRoles", {"roles": "refList"}),
    "role_add": ("ManageRoles", {"role": "ref", "user": "member"}),
    "role_remove": ("ManageRoles", {"role": "ref", "user": "member"}),
    "role_add_all": ("ManageRoles", {"role": "ref", "targetGroup": "?targetGroup", "filterRole": "?ref"}),
    "role_remove_all": ("ManageRoles", {"role": "ref", "targetGroup": "?targetGroup", "filterRole": "?ref"}),
    "member_roles_set": ("ManageRoles", {"user": "member", "roles": "refList"}),
    # CHANNELS & PERMS
    "channel_create": (
        "ManageChannels",
        {
            "name": "text100",
            "type": "channelType",
            "parent": "?ref",
            "topic": "?text1000",
            "slowmode": "?seconds",
            "nsfw": "?boolean",
            "bitrate": "?bitrate",
            "userLimit": "?userLimit",
            "position": "?position",
        },
    ),
    "channel_rename": ("ManageChannels", {"channel": "?ref", "name": "text100"}),
    "channel_edit": (
        "ManageChannels",
        {
            "channel": "ref",
            "name": "?text100",
            "topic": "?text1000",
            "slowmode": "?seconds",
            "nsfw": "?boolean",
            "parent": "?ref",
            "clearParent": "?boolean",
            "position": "?position",
            "bitrate": "?bitrate",
            "userLimit": "?userLimit",
        },
    ),
    "channel_clone": ("ManageChannels", {"channel": "ref", "name": "?text100"}),
    "channel_permissions_set": (
        "ManageRoles",
        {
            "channel": "ref",
            "target": "text100",
            "targetType": "targetType",
            "allow": "?permissions",
            "deny": "?permissions",
        },
    ),
    "channel_permissions_delete": ("ManageRoles", {"channel": "ref", "target": "text100", "targetType": "targetType"}),
    "channel_sync_permissions": ("ManageChannels", {"channel": "ref"}),
    "channel_delete": ("ManageChannels", {"channel": "ref"}),
    "channels_bulk_delete": ("ManageChannels", {"channels": "refList"}),
    # MEMBERS & VOICE & MODERATION
    "member_ban": ("BanMembers", {"user": "member", "reason": "?text300", "deleteMessageDays": "?deleteDays"}),
    "member_unban": ("BanMembers", {"user": "id", "reason": "?text300"}),
    "member_kick": ("KickMembers", {"user": "member", "reason": "?text300"}),
    "member_timeout": ("ModerateMembers", {"user": "member", "minutes": "minutes", "reason": "?text300"}),
    "member_nickname": ("ManageNicknames", {"user": "member", "nickname": "text32"}),
    "members_nickname_all": ("ManageNicknames", {"nickname": "text32", "targetGroup": "?targetGroup"}),
    "members_prune": ("KickMembers", {"days": "pruneDays", "computeOnly": "?boolean"}),
    "member_dm": ("ViewChannel", {"user": "member", "content": "text1800"}),
    "member_move": ("MoveMembers", {"user": "member", "channel": "ref"}),
    "member_disconnect": ("MoveMembers", {"user": "member"}),
    "member_mute": ("MuteMembers", {"user": "member", "enabled": "boolean"}),
    "member_deafen": ("DeafenMembers", {"user": "member", "enabled": "boolean"}),
    "voice_move_all": ("MoveMembers", {"fromChannel": "?ref", "toChannel": "ref"}),
    "voice_disconnect_all": ("MoveMembers", {"channel": "?ref"}),
    "voice_mute_all": ("MuteMembers", {"channel": "?ref", "enabled": "boolean"}),
    "voice_deafen_all": ("DeafenMembers", {"channel": "?ref", "enabled": "boolean"}),
    "voice_status_set": ("ManageChannels", {"channel": "ref", "status": "text500"}),
    "voice_join": ("Connect", {"channel": "?ref"}),
    "voice_leave": ("Connect", {}),
    "voice_say": ("Speak", {"text": "text500", "channel": "?ref"}),
    "stage_start": ("ManageChannels", {"channel": "ref", "topic": "text120"}),
    "stage_edit": ("ManageChannels", {"channel": "ref", "topic": "text120"}),
    "stage_end": ("ManageChannels", {"channel": "ref"}),
    # MESSAGES & POLLS
    "message_send": (
        "SendMessages",
        {
            "channel": "ref",
            "content": "?text1800",
            "embedTitle": "?text256",
            "embedDescription": "?text1800",
            "embedColor": "?color",
            "replyTo": "?id",
            "allowMentions": "?boolean",
        },
    ),
    "poll_send": (
        "SendMessages",
        {
            "channel": "ref",
            "question": "text300",
            "answers": "textList",
            "hours": "?hours",
            "allowMultiselect": "?boolean",
        },
    ),
    "message_edit": ("SendMessages", {"channel": "ref", "message": "id", "content": "text1800"}),
    "message_react": ("AddReactions", {"channel": "ref", "message": "id", "emoji": "text64"}),
    "message_reactions_clear": ("ManageMessages", {"channel": "ref", "message": "id"}),
    "message_pin": ("ManageMessages", {"channel": "ref", "message": "id"}),
    "message_unpin": ("ManageMessages", {"channel": "ref", "message": "id"}),
    "message_delete": ("ManageMessages", {"channel": "ref", "message": "id"}),
    "message_purge": ("ManageMessages", {"channel": "ref", "count": "purgeCount", "user": "?member"}),
    # THREADS
    "thread_create": ("CreatePublicThreads", {"channel": "ref", "name": "text100", "private": "?boolean", "message": "?text1800"}),
    "thread_edit": ("ManageThreads", {"channel": "ref", "name": "?text100", "archived": "?boolean", "locked": "?boolean", "slowmode": "?seconds"}),
    "thread_member_add": ("ManageThreads", {"channel": "ref", "user": "member"}),
    "thread_member_remove": ("ManageThreads", {"channel": "ref", "user": "member"}),
    "thread_delete": ("ManageThreads", {"channel": "ref"}),
    # WEBHOOKS
    "webhook_create": ("ManageWebhooks", {"channel": "ref", "name": "text80", "avatarUrl": "?url"}),
    "webhook_edit": ("ManageWebhooks", {"webhook": "ref", "name": "?text80", "channel": "?ref"}),
    "webhook_send": ("ManageWebhooks", {"webhook": "ref", "content": "text1800", "username": "?text80", "avatarUrl": "?url"}),
    "webhook_delete": ("ManageWebhooks", {"webhook": "ref"}),
    # EMOJIS & STICKERS
    "emoji_create": ("ManageGuildExpressions", {"name": "text32", "imageUrl": "url"}),
    "emoji_edit": ("ManageGuildExpressions", {"emoji": "text64", "name": "text32"}),
    "emoji_delete": ("ManageGuildExpressions", {"emoji": "text64"}),
    "sticker_create": ("ManageGuildExpressions", {"name": "text30", "tags": "text100", "description": "?text100", "imageUrl": "url"}),
    "sticker_delete": ("ManageGuildExpressions", {"sticker": "text64"}),
    # EVENTS
    "event_create": (
        "ManageEvents",
        {
            "name": "text100",
            "startTimeIso": "text64",
            "endTimeIso": "?text64",
            "description": "?text1000",
            "entityType": "eventType",
            "channel": "?ref",
            "location": "?text100",
        },
    ),
    "event_edit": (
        "ManageEvents",
        {
            "event": "id",
            "name": "?text100",
            "description": "?text1000",
            "startTimeIso": "?text64",
            "endTimeIso": "?text64",
            "location": "?text100",
        },
    ),
    "event_delete": ("ManageEvents", {"event": "id"}),
    # AUTOMOD
    "automod_create": (
        "ManageGuild",
        {
            "name": "text100",
            "keywords": "?textList",
            "regexPatterns": "?textList",
            "mentionLimit": "?mentionLimit",
            "blockMessage": "?boolean",
            "timeoutSeconds": "?seconds",
            "alertChannel": "?ref",
            "enabled": "?boolean",
        },
    ),
    "automod_edit": (
        "ManageGuild",
        {
            "rule": "id",
            "name": "?text100",
            "keywords": "?textList",
            "regexPatterns": "?textList",
            "mentionLimit": "?mentionLimit",
            "enabled": "?boolean",
        },
    ),
    "automod_delete": ("ManageGuild", {"rule": "id"}),
    # INVITES
    "invite_create": ("CreateInstantInvite", {"channel": "ref", "maxAgeHours": "?hours", "maxUses": "?uses", "temporary": "?boolean"}),
    "invite_delete": ("ManageChannels", {"code": "text32"}),
}

LIMITS: dict[str, tuple[int, int]] = {
    "seconds": (0, 21600),
    "minutes": (0, 40320),
    "pruneDays": (1, 30),
    "count": (1, 100),
    "purgeCount": (1, 500),
    "readLimit": (1, 50),
    "listLimit": (1, 100),
    "hours": (1, 768),
    "uses": (0, 100),
    "deleteDays": (0, 7),
    "bitrate": (8000, 384000),
    "userLimit": (0, 99),
    "position": (0, 500),
    "afkTimeout": (60, 3600),
    "mentionLimit": (1, 50),
}

REF_TOKENS = {"$last_role", "$last_channel", "$last_category", "$last_thread", "$last_webhook"}
CURRENT_CHANNEL_ALIASES = {
    "this",
    "this channel",
    "dis channel",
    "this_channel",
    "here",
    "current",
    "current channel",
    "current_channel",
    "#this",
    "#current",
}

EVERYONE_TARGET_MAP = {
    "everyone": "everyone",
    "@everyone": "everyone",
    "everybody": "everyone",
    "all": "everyone",
    "all members": "everyone",
    "all users": "everyone",
    "server": "everyone",
    "anyone": "everyone",
    "humans": "humans",
    "all humans": "humans",
    "members": "humans",
    "bots": "bots",
    "all bots": "bots",
}

SLUG_CHANNEL_TYPES = {0, 5, 15, 16, "text", "news", "announcement", "forum", "media"}

GENERIC_VC_ALIASES = {"vc", "voice", "voice channel", "this vc", "my vc", "current vc", "call", "the call", "here"}

ACTION_INTENT_RE = re.compile(
    r"\b(?:create|make|build|setup|set up|add|assign|give|grant|remove|take|strip|rename|renmae|change|edit|update|modify|set|delete|del|nuke|destroy|wipe|purge|clear|clean|ban|unban|kick|timeout|time out|mute|unmute|deafen|undeafen|move|drag|disconnect|dc|kick from vc|join|hop in|hop into|come to|enter|leave|exit|speak|talk|say|voice|vc|send|post|announce|pin|unpin|react|clone|copy|archive|unarchive|lock|unlock|hide|unhide|show|slowmode|nsfw|topic|category|role|roles|channel|channels|thread|forum|webhook|emoji|sticker|event|automod|invite|audit|logs|inspect|list|who has|who's in|whos in|members|bans|server|poll|dm|status|presence|nickname|nick|prune|backup|snapshot|stage|sync)\b",
    re.IGNORECASE,
)

SMALL_TALK_ONLY_RE = re.compile(
    r"^(?:hi|hey|yo|sup|hello|ok|okay|k|kk|lol|lmao|lmfao|bruh|bro|fr|ty|thx|thanks|gm|gn|w|l|nice|cool|bet|real|true|same|mood|capri|wtf|what|why|how|yes|no|yeah|nah|yep|nope)[!?.]*$",
    re.IGNORECASE,
)


def _extract_rename_target(raw_message: str) -> str:
    m = RENAME_EXTRACT_RE.search(str(raw_message or ""))
    if not m:
        return ""
    return re.sub(r"[.!?]+$", "", m.group(1).strip()).strip()


def normalize_plan(plan: Any, fallback_channel_id: str = "", raw_message: str = "") -> Any:
    if not isinstance(plan, dict) or not isinstance(plan.get("actions"), list):
        return plan

    out_actions: list[Any] = []
    for raw_step in plan["actions"]:
        if not isinstance(raw_step, dict):
            out_actions.append(raw_step)
            continue

        action = str(raw_step.get("action") or "").strip()
        raw_args = dict(raw_step.get("args")) if isinstance(raw_step.get("args"), dict) else {}

        if action == "channel_rename":
            action = "channel_edit"

        for alias in ("channel_id", "channelId", "channel_ref", "targetChannel", "target_channel"):
            if "channel" not in raw_args and alias in raw_args:
                raw_args["channel"] = raw_args[alias]
            raw_args.pop(alias, None)

        if action == "channel_edit":
            for alias in ("newName", "new_name", "channelName", "channel_name", "renameTo", "rename_to", "to", "title", "value", "targetName", "target_name"):
                if "name" not in raw_args and alias in raw_args:
                    raw_args["name"] = raw_args[alias]
                raw_args.pop(alias, None)
            has_any_edit = any(raw_args.get(k) not in (None, "") for k in ("name", "topic", "slowmode", "nsfw", "parent", "clearParent", "position", "bitrate", "userLimit"))
            if not has_any_edit and raw_message:
                extracted = _extract_rename_target(raw_message)
                if extracted:
                    raw_args["name"] = extracted

        for alias in ("roleName", "role_name", "roleId", "role_id", "targetRole", "target_role"):
            if "role" not in raw_args and alias in raw_args:
                raw_args["role"] = raw_args[alias]
            raw_args.pop(alias, None)
        if action in ("role_add", "role_remove", "role_add_all", "role_remove_all", "role_delete"):
            if "role" not in raw_args and "name" in raw_args:
                raw_args["role"] = raw_args.pop("name")

        for alias in ("userId", "user_id", "member", "memberId", "member_id", "targetUser", "target_user", "username"):
            if "user" not in raw_args and alias in raw_args:
                raw_args["user"] = raw_args[alias]
            raw_args.pop(alias, None)
        if action in ("role_add", "role_remove", "member_ban", "member_kick", "member_timeout", "member_nickname", "member_dm"):
            if "user" not in raw_args and "target" in raw_args:
                raw_args["user"] = raw_args.pop("target")

        if action in ("role_add", "role_remove"):
            user_low = str(raw_args.get("user") or "").strip().lower()
            if user_low in EVERYONE_TARGET_MAP:
                action = "role_add_all" if action == "role_add" else "role_remove_all"
                raw_args.pop("user", None)
                if not raw_args.get("targetGroup"):
                    raw_args["targetGroup"] = EVERYONE_TARGET_MAP[user_low]

        if action == "member_nickname":
            user_low = str(raw_args.get("user") or "").strip().lower()
            if user_low in EVERYONE_TARGET_MAP:
                action = "members_nickname_all"
                raw_args.pop("user", None)
                if not raw_args.get("targetGroup"):
                    raw_args["targetGroup"] = EVERYONE_TARGET_MAP[user_low]

        if action in ("role_add_all", "role_remove_all", "members_nickname_all"):
            if "targetGroup" not in raw_args and "group" in raw_args:
                raw_args["targetGroup"] = raw_args["group"]
            if "targetGroup" not in raw_args and "target" in raw_args:
                raw_args["targetGroup"] = raw_args["target"]
            raw_args.pop("group", None)
            raw_args.pop("target", None)
            if isinstance(raw_args.get("targetGroup"), str):
                mapped = EVERYONE_TARGET_MAP.get(raw_args["targetGroup"].strip().lower())
                if mapped:
                    raw_args["targetGroup"] = mapped

        if action in ACTIONS:
            schema = ACTIONS[action][1]
            for k in list(raw_args.keys()):
                if raw_args[k] is None:
                    raw_args.pop(k)

            if action in ("voice_join", "voice_say"):
                if "text" not in raw_args and action == "voice_say":
                    for alias in ("message", "content", "say", "prompt"):
                        if alias in raw_args:
                            raw_args["text"] = raw_args.pop(alias)
                            break
                ch_raw = str(raw_args.get("channel") or "").strip().lower()
                if ch_raw in GENERIC_VC_ALIASES or (fallback_channel_id and ch_raw == fallback_channel_id.lower()):
                    raw_args.pop("channel", None)
            elif "channel" in schema:
                req = not schema["channel"].startswith("?")
                ch_val = str(raw_args.get("channel") or "").strip().lower() if isinstance(raw_args.get("channel"), str) or "channel" not in raw_args else ""
                if fallback_channel_id and ((req and (not ch_val or ch_val in CURRENT_CHANNEL_ALIASES)) or ch_val in CURRENT_CHANNEL_ALIASES):
                    raw_args["channel"] = fallback_channel_id

            if "toChannel" in schema and isinstance(raw_args.get("toChannel"), str):
                if fallback_channel_id and raw_args["toChannel"].strip().lower() in CURRENT_CHANNEL_ALIASES:
                    raw_args["toChannel"] = fallback_channel_id

            for key, raw_type in schema.items():
                if key not in raw_args:
                    continue
                val = raw_args[key]
                t = raw_type.lstrip("?")
                if t in LIMITS and isinstance(val, str) and re.fullmatch(r"-?\d+", val.strip()):
                    raw_args[key] = int(val.strip())
                elif t == "boolean" and isinstance(val, str):
                    low = val.strip().lower()
                    if low == "true":
                        raw_args[key] = True
                    elif low == "false":
                        raw_args[key] = False
                elif t == "color" and isinstance(val, str) and RAW_HEX_RE.fullmatch(val.strip()):
                    raw_args[key] = f"#{val.strip()}"

        out_actions.append({"action": action, "args": raw_args})

    return {**plan, "actions": out_actions}


def format_channel_name(name: str, channel_type: Any) -> str:
    trimmed = str(name or "").strip()
    if not trimmed:
        raise ValueError("Channel name cannot be empty.")
    type_val = getattr(channel_type, "value", channel_type)
    type_name = getattr(channel_type, "name", str(channel_type))
    if type_val in SLUG_CHANNEL_TYPES or type_name in SLUG_CHANNEL_TYPES:
        return re.sub(r"\s+", "-", trimmed.lower())[:100]
    return trimmed[:100]


def _strip_decorators(name: str) -> str:
    return re.sub(r"^[^\w]+", "", str(name or "").lower(), flags=re.UNICODE).strip()


def resolve_channel_from_list(channels: list[Any], value: str, refs: dict[str, str] | None = None) -> Any:
    refs = refs or {}
    raw = str(value or "").strip()
    items = [c for c in channels if c is not None]

    if raw in REF_TOKENS:
        target_id = refs.get(raw)
        if not target_id:
            raise ValueError(f"No earlier created resource for {raw}.")
        for ch in items:
            if str(ch.id) == str(target_id):
                return ch
        raise ValueError(f"Referenced channel {raw} ({target_id}) not found.")

    if (not raw or raw.lower() in CURRENT_CHANNEL_ALIASES) and refs.get("$current_channel"):
        cur = str(refs["$current_channel"])
        for ch in items:
            if str(ch.id) == cur:
                return ch

    mention = CHANNEL_MENTION_RE.match(raw)
    if ID_RE.match(raw) or mention:
        cid = raw if ID_RE.match(raw) else mention.group(1)
        for ch in items:
            if str(ch.id) == cid:
                return ch
        raise ValueError(f'Channel ID "{cid}" not found in this server.')

    clean_name = raw.lstrip("#").strip().lower()
    slug_name = re.sub(r"\s+", "-", clean_name)

    exact = [ch for ch in items if ch.name.lower() in (clean_name, slug_name)]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ValueError(f'Multiple channels named "{raw}" — mention the channel or specify its ID.')

    fuzzy = [ch for ch in items if _strip_decorators(ch.name) in (clean_name, slug_name)]
    if len(fuzzy) == 1:
        return fuzzy[0]
    if len(fuzzy) > 1:
        raise ValueError(f'Multiple channels match "{raw}" — mention the channel or specify its ID.')

    raise ValueError(f'Channel "{raw}" not found in this server.')


def resolve_role_from_list(roles: list[Any], value: str, refs: dict[str, str] | None = None) -> Any:
    refs = refs or {}
    raw = str(value or "").strip()
    items = [r for r in roles if r is not None]

    if raw in REF_TOKENS:
        target_id = refs.get(raw)
        if not target_id:
            raise ValueError(f"No earlier created role for {raw}.")
        for r in items:
            if str(r.id) == str(target_id):
                return r
        raise ValueError(f"Referenced role {raw} ({target_id}) not found.")

    mention = ROLE_MENTION_RE.match(raw)
    if ID_RE.match(raw) or mention:
        rid = raw if ID_RE.match(raw) else mention.group(1)
        for r in items:
            if str(r.id) == rid:
                return r
        raise ValueError(f'Role ID "{rid}" not found in this server.')

    clean_name = raw.lstrip("@").strip().lower()
    exact = [r for r in items if r.name.strip().lower() == clean_name]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ValueError(f'Multiple roles named "{raw}" — specify role ID.')

    fuzzy = [r for r in items if _strip_decorators(r.name) == clean_name]
    if len(fuzzy) == 1:
        return fuzzy[0]
    if len(fuzzy) > 1:
        raise ValueError(f'Multiple roles match "{raw}" — specify role ID.')

    if len(clean_name) >= 2:
        partial = [r for r in items if clean_name in r.name.lower()]
        if len(partial) == 1:
            return partial[0]

    raise ValueError(f'Role "{raw}" not found in this server.')


def requires_delete_confirmation(plan: dict[str, Any] | None) -> bool:
    if not isinstance(plan, dict):
        return False
    return any(step.get("action") in DELETE_ACTIONS for step in plan.get("actions") or [])


def validate_plan(plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict):
        raise ValueError("Invalid plan.")
    actions = plan.get("actions")
    if not isinstance(actions, list) or not (1 <= len(actions) <= 100):
        raise ValueError("Use 1–100 actions per plan.")

    for step in actions:
        if not isinstance(step, dict) or step.get("action") not in ACTIONS:
            raise ValueError(f"Unsupported Discord action: {step.get('action') if isinstance(step, dict) else 'unknown'}.")
        if any(k not in ("action", "args") for k in step.keys()):
            raise ValueError("Unexpected action field.")
        args = step.get("args")
        if not isinstance(args, dict):
            raise ValueError("Invalid action arguments.")
        schema = ACTIONS[step["action"]][1]
        if any(k not in schema for k in args.keys()):
            raise ValueError(f"Unknown action argument in {step['action']}.")

        for key, raw_type in schema.items():
            optional = raw_type.startswith("?")
            typ = raw_type.lstrip("?")
            value = args.get(key)
            if key not in args or value is None:
                if optional:
                    continue
                raise ValueError(f"Invalid {step['action']}.{key}.")

            valid = False
            if typ == "textList":
                valid = isinstance(value, list) and len(value) <= 50 and all(isinstance(v, str) and bool(v.strip()) and len(v) <= 100 for v in value)
            elif re.fullmatch(r"text\d+", typ):
                allow_empty = key in ("nickname", "topic", "description", "content", "status")
                max_len = int(typ[4:])
                valid = isinstance(value, str) and len(value) <= max_len and (bool(value.strip()) or allow_empty)
            elif typ == "id":
                valid = isinstance(value, str) and bool(ID_RE.match(value.strip()))
            elif typ == "member":
                valid = isinstance(value, str) and 1 <= len(value.strip()) <= 100
            elif typ == "ref":
                valid = isinstance(value, str) and (bool(ID_RE.match(value.strip())) or value.strip() in REF_TOKENS or 1 <= len(value.strip()) <= 100)
            elif typ == "refList":
                valid = isinstance(value, list) and len(value) <= 40 and all(isinstance(v, str) and bool(v.strip()) for v in value)
            elif typ == "boolean":
                valid = isinstance(value, bool)
            elif typ == "color":
                valid = isinstance(value, str) and bool(HEX_COLOR_RE.match(value.strip()))
            elif typ == "url":
                valid = isinstance(value, str) and bool(re.match(r"^https?://.+", value.strip(), re.IGNORECASE))
            elif typ == "channelType":
                valid = value in ("text", "voice", "category", "announcement", "forum", "stage")
            elif typ == "targetType":
                valid = value in ("role", "member")
            elif typ == "targetGroup":
                valid = value in ("everyone", "humans", "bots")
            elif typ == "presenceStatus":
                valid = value in ("online", "idle", "dnd", "invisible")
            elif typ == "activityType":
                valid = value in ("playing", "watching", "listening", "competing", "custom")
            elif typ == "eventType":
                valid = value in ("voice", "stage", "external")
            elif typ == "verificationLevel":
                valid = value in ("none", "low", "medium", "high", "very_high")
            elif typ == "contentFilter":
                valid = value in ("disabled", "members_without_roles", "all_members")
            elif typ == "notificationLevel":
                valid = value in ("all_messages", "only_mentions")
            elif typ == "permissions":
                valid = isinstance(value, list) and len(value) <= 50 and all(isinstance(p, str) and p in VALID_PERMISSION_FLAGS for p in value)
            elif typ in LIMITS:
                lo, hi = LIMITS[typ]
                valid = isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi

            if not valid:
                raise ValueError(f"Invalid {step['action']}.{key}.")

        if step["action"] == "message_send" and not args.get("content") and not args.get("embedTitle") and not args.get("embedDescription"):
            raise ValueError("message_send requires content or embed text.")
        if step["action"] == "channel_edit":
            if not any(k in args for k in ("name", "topic", "slowmode", "nsfw", "parent", "clearParent", "position", "bitrate", "userLimit")):
                raise ValueError("channel_edit needs at least one change (e.g. name, topic, slowmode, nsfw, or parent).")

    return plan


# Broad verbs like "make" and "talk" also occur in ordinary conversation.
# Keep the prefix as an explicit escape hatch for unusual operations.
CHAT_VERBS = {"make", "say", "talk", "give", "build", "create", "show", "list",
              "set", "send", "take", "change", "update", "add", "remove", "write"}


def is_action_request(text: str, prefix: str = "t", allow_unaddressed: bool = False, is_named: bool = False) -> bool:
    raw = str(text or "")
    if not raw.strip():
        return False
    if raw.lower().startswith(f"{prefix.lower()} do "):
        return True
    if is_named or allow_unaddressed:
        terms = {m[0].lower() for m in ACTION_INTENT_RE.finditer(raw)}
        if terms - CHAT_VERBS:
            return True
        if terms and (re.search(r"<[@#]|\b(?:everyone|slowmode|permissions?|display name|avatar|description)\b", raw, re.I)
                      or SNOWFLAKE_READ_RE.search(raw)):
            return True
    if allow_unaddressed and SNOWFLAKE_READ_RE.search(raw):
        return True
    return False


def should_check_authorized_action(text: str, prefix: str = "t", has_recent_context: bool = False, is_named: bool = False) -> bool:
    if is_action_request(text, prefix, allow_unaddressed=True, is_named=is_named):
        return True
    trimmed = str(text or "").strip()
    if not trimmed:
        return False
    if has_recent_context:
        return True
    words = [w for w in trimmed.split() if w]
    if len(words) >= 2 and not SMALL_TALK_ONLY_RE.match(trimmed):
        return True
    return False


def extract_failed_steps(results: list[str]) -> list[str]:
    return [line for line in results if re.match(r"^Step \d+ \([^)]+\) failed:", line)]


def format_action_outcome(results: list[str]) -> dict[str, Any]:
    lines = [str(x).strip() for x in results if str(x).strip()]
    failures = extract_failed_steps(lines)
    return {
        "all_succeeded": len(failures) == 0,
        "failures": failures,
        "report": "\n".join(lines),
    }
