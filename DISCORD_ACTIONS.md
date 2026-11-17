# Capri Discord Takeover Actions (Max-Capability Full CRUD Reference)

Capri understands **natural, casual conversation** — typos, slang, and mid-sentence requests work with zero fixed command syntax (e.g. *"rename this channel to saitama"*, *"cpuld you add role coke to everyone"*, *"nuke the last 20 messages in here"*).

## Execution Policy
- **Create / Read / Update / Bulk Roles / Voice / Stage / Presence / Polls / Moderation / Webhooks / Events / AutoMod**: Executed **immediately** after validation (up to 100 chained steps per plan).
- **Delete / Purge / Prune Operations**: Always pause and post an interactive Discord prompt with **Confirm deletion** and **Cancel** buttons. Nothing is deleted until the authorized requester clicks **Confirm deletion** within 2 minutes.

## Full Action Matrix (80+ Operations)

| Area | Read (Immediate) | Create / Update / Bulk (Immediate) | Delete (Confirm Button) |
| --- | --- | --- | --- |
| **Server & Bot** | `server_inspect`, `server_backup_snapshot`, `audit_logs_read` | `server_rename`, `server_description`, `server_edit`, `bot_presence_set` (status, activity, nickname) | — |
| **Members & DMs** | `members_list`, `member_inspect`, `bans_list` | `member_ban`, `member_unban`, `member_kick`, `member_timeout`, `member_nickname`, `members_nickname_all`, `member_dm`, `member_roles_set` | `members_prune` |
| **Voice & Stage** | `members_list` (`inVoiceOnly`), `server_inspect` | `voice_join`, `voice_leave`, `voice_say` (2-way Gemini Live AI on `discord.py`), `member_move`, `member_disconnect`, `member_mute`, `member_deafen`, `voice_move_all`, `voice_disconnect_all`, `voice_mute_all`, `voice_deafen_all`, `voice_status_set`, `stage_start`, `stage_edit`, `stage_end` | — |
| **Roles** | `roles_list` | `role_create`, `role_edit` (incl. `@everyone`), `role_add`, `role_remove`, `role_add_all`, `role_remove_all` | `role_delete`, `roles_bulk_delete` |
| **Channels & Perms** | `channels_list`, `channel_inspect`, `channel_read` | `channel_create` (text/voice/category/announcement/forum/stage), `channel_edit`, `channel_clone`, `channel_permissions_set`, `channel_sync_permissions` | `channel_delete`, `channels_bulk_delete`, `channel_permissions_delete` |
| **Messages & Polls** | `channel_read` | `message_send` (text + rich embeds), `poll_send`, `message_edit`, `message_react`, `message_pin`, `message_unpin` | `message_delete`, `message_purge` (1–500), `message_reactions_clear` |
| **Threads & Forums** | `channels_list` | `thread_create` (public/private/forum), `thread_edit`, `thread_member_add`, `thread_member_remove` | `thread_delete` |
| **Webhooks** | `webhooks_list` | `webhook_create`, `webhook_edit`, `webhook_send` | `webhook_delete` |
| **Emojis & Stickers** | `emojis_list` | `emoji_create`, `emoji_edit`, `sticker_create` | `emoji_delete`, `sticker_delete` |
| **Events** | `events_list` | `event_create`, `event_edit` | `event_delete` |
| **AutoMod** | `automod_list` | `automod_create`, `automod_edit` | `automod_delete` |
| **Invites** | `invites_list` | `invite_create` | `invite_delete` |
