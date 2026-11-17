export function parseCommandUserIds(value = "") {
  const ids = String(value).split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d{17,20}$/.test(id))) {
    throw new Error("COMMAND_USER_IDS must contain comma-separated Discord user IDs (17–20 digits).");
  }
  return new Set(ids);
}

export function canRunCommands(memberOrUserId, allowedIds, { allowGuildAdmins = false } = {}) {
  const userId = typeof memberOrUserId === "string"
    ? memberOrUserId
    : String(memberOrUserId?.id || memberOrUserId?.user?.id || "");
  if (allowedIds instanceof Set && allowedIds.has(userId)) {
    return true;
  }
  if (allowGuildAdmins && memberOrUserId && typeof memberOrUserId === "object") {
    const guild = memberOrUserId.guild;
    if (guild && guild.ownerId === userId) return true;
    if (memberOrUserId.permissions?.has?.("Administrator")) return true;
  }
  return false;
}

export const COMMAND_DENIED = "Nice try, netrunner — you can chat with me anytime, but server takeover commands are locked to authorized controllers.";
