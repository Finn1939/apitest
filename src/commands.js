export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseCommand(content, prefix) {
  if (!prefix) return null;
  const trimmed = content.trim();
  const prefixPattern = new RegExp(`^${escapeRegExp(prefix)}(?:\\s+|$)`);
  const match = trimmed.match(prefixPattern);
  if (!match) return null;
  return trimmed.slice(match[0].length).trim();
}
