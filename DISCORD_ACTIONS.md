# Discord actions

## Capability and permission map

| Area | Supported operations | Requester and bot permissions |
| --- | --- | --- |
| Server | Rename, change description | Manage Server |
| Roles | Create, edit name/color/permissions, delete, assign, remove | Manage Roles; role must be below both parties; no permission escalation |
| Channels | Create text/voice/category, edit name/topic/slowmode/NSFW, delete | Manage Channels; category checks for parent placement |
| Members | Ban, unban, kick | Ban Members / Kick Members |
| Timeouts | Apply, remove with zero minutes | Moderate Members |
| Nicknames | Set, clear with empty nickname | Manage Nicknames |
| Voice | Move, disconnect, server mute/unmute, deafen/undeafen | Move / Mute / Deafen Members; Connect for move destination |
| Messages | Send, edit Capri's own messages | Send Messages; requester also needs Manage Messages to edit Capri's posts |
| Message management | Delete, purge 1–100 recent messages | Manage Messages + Read Message History |
| Pins | Pin, unpin by message ID | Pin Messages + Read Message History |
| Threads | Create public thread in a text channel, archive/unarchive | Create Public Threads / Manage Threads |
| Invites | Create expiring, limited-use invite | Create Instant Invite |

View Channel is required for operations targeting an existing channel. Threads additionally require Send Messages in Threads to send there. Discord can reject actions due to server features, permissions or resource limits; failures are reported. Server descriptions can depend on server features.

## Examples

- `Capri create a role named Crew with color #00CCFF and give it to @Alex`
- `Capri rename the Crew role to Night Crew`
- `Capri remove the Night Crew role from @Alex`
- `Capri unban user 123456789012345678`
- `Capri remove the timeout from @Alex`
- `Capri change @Alex's nickname to V`
- `Capri move @Alex to #Lounge`
- `Capri unmute @Alex in voice`
- `Capri set slowmode in #general to 10 seconds`
- `Capri purge 20 messages in #general`
- `Capri pin message 123456789012345678 in #general`
- `Capri create a public thread named Weekend Plans in #general`
- `Capri create an invite for #general that expires in 24 hours and permits 5 uses`

Replace examples with real mentions and IDs. Enable Discord Developer Mode to copy IDs. Member targets require mentions or IDs, not fuzzy username guesses. For a message operation, supply its ID and channel. Multi-step role creation uses the ID returned by Discord, not a guessed name. Maximum 8 steps per plan.

## Execution design

COMMAND_USER_IDS is the command allowlist: unlisted users may chat, but cannot run natural-language actions, slash commands, prefix commands, or explicit remember/clear commands. Blank means nobody can run commands. ADMIN_USER_IDS defaults to the command allowlist when blank and can further restrict maintenance access, but never widens command access.

The AI receives only the current request and a server reference list (roles, channels visible to the requester, explicitly mentioned users). Chat history and images cannot directly invoke actions. The model emits structured data validated against src/actions.js; it cannot run JavaScript, arbitrary API endpoints or shell commands.

Only role/channel/message deletion and message purges require approval of the exact frozen plan. Other actions execute immediately for allowed users. Any mixed plan containing deletion waits as a whole; cancellation/expiry causes no changes. Memory deletion commands also require confirmation. Removing a role assignment, banning, kicking and editing do not require confirmation. Current member permissions, role definitions, guild ownership and target-channel permissions are refreshed during execution. Neither administrator permissions nor ADMIN_USER_IDS bypass the target role hierarchy. Roles with permissions beyond the requester or bot are rejected. Audit reasons include requester and request IDs where Discord supports them; the console records outcome summaries.

Completed steps remain applied if a later step fails. Review the result before retrying. Network timeouts can leave an operation's outcome uncertain; inspect the server before repeating it. Only one plan executes per server at a time. Pending deletion confirmations expire after two minutes and are lost on restart. Ordinary chat has no action execution privileges.

Message sends suppress @everyone/user/role notifications. Ban does not delete past messages. Purge skips messages older than 14 days and returns the actual deletion count. Invites expire in 1–168 hours and allow 1–100 uses. Timeouts support 0–40320 minutes. No unattended moderation is added.

Set `DISCORD_ACTIONS_ENABLED=false` in .env to disable the action planner.

## Extending capabilities

Add an explicit typed operation to ACTIONS, implement its permission/target checks and executor branch, and add authorization tests. The planner reads this registry automatically. Do not add unrestricted eval, shell or REST-proxy operations to satisfy “anything”: new capabilities need real integrations and permission rules.

Official API reference: https://discord.js.org/docs/packages/discord.js/14.28.0
