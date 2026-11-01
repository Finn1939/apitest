// Turns raw Discord mention markup into readable text for the AI and her memory.
// <@123> → @Display name, <@&456> → @Role, <#789> → #channel.
// Unresolvable IDs are left untouched. The bot's own mention is handled in index.js.
export function renderDiscordMentions(content, { users, roles, channels } = {}) {
  const userMap = users ?? new Map();
  const roleMap = roles ?? new Map();
  const channelMap = channels ?? new Map();
  return String(content ?? "")
    .replace(/<@!?(\d+)>/g, (original, id) => {
      const user = userMap.get(id);
      if (!user) return original;
      const name = String(user.displayName || user.globalName || user.username || id).replace(/^@+/, "");
      return `@${name}`;
    })
    .replace(/<@&(\d+)>/g, (original, id) => {
      const role = roleMap.get(id);
      return role ? `@${String(role.name).replace(/^@+/, "")}` : original;
    })
    .replace(/<#(\d+)>/g, (original, id) => {
      const channel = channelMap.get(id);
      return channel ? `#${String(channel.name).replace(/^#+/, "")}` : original;
    });
}
