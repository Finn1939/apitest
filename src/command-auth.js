export function parseCommandUserIds(value = '') {
  const ids = String(value).split(',').map(x => x.trim()).filter(Boolean);
  if (ids.some(id => !/^\d{17,20}$/.test(id))) throw new Error('COMMAND_USER_IDS must contain comma-separated Discord user IDs (17–20 digits).');
  return new Set(ids);
}
export function canRunCommands(userId, allowedIds) {
  return allowedIds instanceof Set && allowedIds.has(String(userId));
}
export const COMMAND_DENIED = 'Chat with me anytime. Commands are reserved for the user IDs in COMMAND_USER_IDS.';
