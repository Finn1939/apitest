# Capri Discord Bot — Direct Commands Edition

Capri now translates natural-language requests into real Discord operations. Her existing chat, memory, image context, research and spontaneous conversation remain available.

## Setup
1. Install Node.js 22 and extract this ZIP.
2. Copy `.env.example` to `.env`. Set your Discord bot token, AI provider key/model, and COMMAND_USER_IDS to your numeric Discord user ID. See ENV_SETUP.md or copy .env.minimal.example as a starting point. Do not overwrite your existing .env or memory files when upgrading.
3. Enable Message Content Intent in the Discord Developer Portal. The code also requests GuildVoiceStates for voice operations (not a privileged intent).
4. Invite Capri to your server and give her View Channels, Send Messages, Read Message History, and Attach Files so she can display plans. Grant the additional permissions for actions you want to use; see DISCORD_ACTIONS.md. Put her highest role above members and roles she needs to manage.
5. Run `npm ci`, then `npm test`, then `npm start`.
6. Set the bot display name to Capri. Keep the process running. Back up your memory database and memory files before upgrades.

## Try it
- Hey Capri, create a role named Night Crew and add it to @Alex.
- Hey Capri, change the server name to Night City.
- Hey Capri, ban @Alex for spam.
- Hey Capri, timeout @Alex for 10 minutes.
- Hey Capri, create a text channel named music-chat.
- Hey Capri, send “Welcome to the crew!” in #general.

Use actual Discord mentions for members and channels, or exact IDs. Existing role/channel names must resolve unambiguously. You can also use `t do` followed by the request (or your configured prefix).

Non-delete commands execute as soon as the request is understood and checked, without buttons or a five-second cooldown. Delete/purge plans attach the exact targets and values: review capri-action-plan.txt and click **Confirm deletion** within two minutes, or Cancel. A mixed plan containing any deletion waits as a whole. Removing a role from a member, banning, kicking, renaming and editing are immediate; deleting the role itself needs confirmation. Memory deletion commands also ask for confirmation. Both the requester and Capri must have the relevant permissions; the command allowlist does not bypass Discord's hierarchy. ADMIN_USER_IDS does not bypass these checks. A failed step stops subsequent steps; completed steps are not rolled back.

## Scope
28 supported operations, with up to 8 steps per request. See DISCORD_ACTIONS.md for the exact list and limits. This is not literal unlimited capability: arbitrary code execution, account access, external app automation, payments, and unimplemented Discord API features are not included. Unsupported requests are explained or clarified rather than represented as completed actions.

The package retains the streaming fix and revises Capri’s voice toward restless curiosity, mischief and directness. Old cat-girl identity replies are removed, and current personality instructions take precedence over older self-model speech. Existing memories are kept. personality-original.txt preserves the old persona. This is an original interpretation, not a verified canon reproduction.

## Validation
See VALIDATION.md. Automated tests use mocked Discord requests; no live server actions or provider planning calls were performed with your credentials.

Base repository revision: c43544667b5f9d84439c7f2b0d928185ab3efcaf
