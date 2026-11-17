const idPattern = /^\d{17,20}$/;

export const VALID_PERMISSION_FLAGS = new Set([
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
]);

export const DELETE_ACTIONS = new Set([
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
]);

export const ACTIONS = {
  // === READ / INSPECT (Immediate) ===
  server_inspect: ["ViewChannel", {}],
  members_list: ["ViewChannel", { query: "?text100", role: "?ref", inVoiceOnly: "?boolean", limit: "?listLimit" }],
  member_inspect: ["ViewChannel", { user: "member" }],
  roles_list: ["ViewChannel", {}],
  channels_list: ["ViewChannel", { type: "?channelType" }],
  channel_inspect: ["ViewChannel", { channel: "ref" }],
  channel_read: ["ReadMessageHistory", { channel: "ref", limit: "?readLimit" }],
  bans_list: ["BanMembers", { limit: "?listLimit" }],
  invites_list: ["ManageGuild", {}],
  webhooks_list: ["ManageWebhooks", { channel: "?ref" }],
  emojis_list: ["ViewChannel", {}],
  events_list: ["ViewChannel", {}],
  automod_list: ["ManageGuild", {}],
  audit_logs_read: ["ViewAuditLog", { limit: "?readLimit" }],
  server_backup_snapshot: ["ViewChannel", {}],

  // === SERVER & BOT ===
  server_rename: ["ManageGuild", { name: "text100" }],
  server_description: ["ManageGuild", { description: "text1000" }],
  server_edit: [
    "ManageGuild",
    {
      name: "?text100",
      description: "?text1000",
      verificationLevel: "?verificationLevel",
      explicitContentFilter: "?contentFilter",
      defaultNotifications: "?notificationLevel",
      afkChannel: "?ref",
      afkTimeout: "?afkTimeout",
      systemChannel: "?ref",
      rulesChannel: "?ref",
      preferredLocale: "?text16",
      iconUrl: "?url",
      bannerUrl: "?url",
      splashUrl: "?url",
      premiumProgressBar: "?boolean",
    },
  ],
  bot_presence_set: [
    "ViewChannel",
    {
      status: "?presenceStatus",
      activityType: "?activityType",
      activityText: "?text128",
      nickname: "?text32",
    },
  ],

  // === ROLES & BULK ROLES ===
  role_create: [
    "ManageRoles",
    {
      name: "text100",
      color: "?color",
      hoist: "?boolean",
      mentionable: "?boolean",
      permissions: "?permissions",
      position: "?position",
      unicodeEmoji: "?text16",
    },
  ],
  role_edit: [
    "ManageRoles",
    {
      role: "ref",
      name: "?text100",
      color: "?color",
      hoist: "?boolean",
      mentionable: "?boolean",
      permissions: "?permissions",
      position: "?position",
    },
  ],
  role_delete: ["ManageRoles", { role: "ref" }],
  roles_bulk_delete: ["ManageRoles", { roles: "refList" }],
  role_add: ["ManageRoles", { role: "ref", user: "member" }],
  role_remove: ["ManageRoles", { role: "ref", user: "member" }],
  role_add_all: ["ManageRoles", { role: "ref", targetGroup: "?targetGroup", filterRole: "?ref" }],
  role_remove_all: ["ManageRoles", { role: "ref", targetGroup: "?targetGroup", filterRole: "?ref" }],
  member_roles_set: ["ManageRoles", { user: "member", roles: "refList" }],

  // === CHANNELS & PERMISSIONS ===
  channel_create: [
    "ManageChannels",
    {
      name: "text100",
      type: "channelType",
      parent: "?ref",
      topic: "?text1000",
      slowmode: "?seconds",
      nsfw: "?boolean",
      bitrate: "?bitrate",
      userLimit: "?userLimit",
      position: "?position",
    },
  ],
  channel_rename: ["ManageChannels", { channel: "?ref", name: "text100" }],
  channel_edit: [
    "ManageChannels",
    {
      channel: "ref",
      name: "?text100",
      topic: "?text1000",
      slowmode: "?seconds",
      nsfw: "?boolean",
      parent: "?ref",
      clearParent: "?boolean",
      position: "?position",
      bitrate: "?bitrate",
      userLimit: "?userLimit",
    },
  ],
  channel_clone: ["ManageChannels", { channel: "ref", name: "?text100" }],
  channel_permissions_set: [
    "ManageRoles",
    {
      channel: "ref",
      target: "text100",
      targetType: "targetType",
      allow: "?permissions",
      deny: "?permissions",
    },
  ],
  channel_permissions_delete: ["ManageRoles", { channel: "ref", target: "text100", targetType: "targetType" }],
  channel_sync_permissions: ["ManageChannels", { channel: "ref" }],
  channel_delete: ["ManageChannels", { channel: "ref" }],
  channels_bulk_delete: ["ManageChannels", { channels: "refList" }],

  // === MEMBERS & VOICE & MODERATION ===
  member_ban: ["BanMembers", { user: "member", reason: "?text300", deleteMessageDays: "?deleteDays" }],
  member_unban: ["BanMembers", { user: "id", reason: "?text300" }],
  member_kick: ["KickMembers", { user: "member", reason: "?text300" }],
  member_timeout: ["ModerateMembers", { user: "member", minutes: "minutes", reason: "?text300" }],
  member_nickname: ["ManageNicknames", { user: "member", nickname: "text32" }],
  members_nickname_all: ["ManageNicknames", { nickname: "text32", targetGroup: "?targetGroup" }],
  members_prune: ["KickMembers", { days: "pruneDays", computeOnly: "?boolean" }],
  member_dm: ["ViewChannel", { user: "member", content: "text1800" }],
  member_move: ["MoveMembers", { user: "member", channel: "ref" }],
  member_disconnect: ["MoveMembers", { user: "member" }],
  member_mute: ["MuteMembers", { user: "member", enabled: "boolean" }],
  member_deafen: ["DeafenMembers", { user: "member", enabled: "boolean" }],
  voice_move_all: ["MoveMembers", { fromChannel: "?ref", toChannel: "ref" }],
  voice_disconnect_all: ["MoveMembers", { channel: "?ref" }],
  voice_mute_all: ["MuteMembers", { channel: "?ref", enabled: "boolean" }],
  voice_deafen_all: ["DeafenMembers", { channel: "?ref", enabled: "boolean" }],
  voice_status_set: ["ManageChannels", { channel: "ref", status: "text500" }],
  voice_join: ["Connect", { channel: "?ref" }],
  voice_leave: ["Connect", {}],
  voice_say: ["Speak", { text: "text500", channel: "?ref" }],
  stage_start: ["ManageChannels", { channel: "ref", topic: "text120" }],
  stage_edit: ["ManageChannels", { channel: "ref", topic: "text120" }],
  stage_end: ["ManageChannels", { channel: "ref" }],

  // === MESSAGES, POLLS & PINS ===
  message_send: [
    "SendMessages",
    {
      channel: "ref",
      content: "?text1800",
      embedTitle: "?text256",
      embedDescription: "?text1800",
      embedColor: "?color",
      replyTo: "?id",
      allowMentions: "?boolean",
    },
  ],
  poll_send: [
    "SendMessages",
    {
      channel: "ref",
      question: "text300",
      answers: "textList",
      hours: "?hours",
      allowMultiselect: "?boolean",
    },
  ],
  message_edit: ["SendMessages", { channel: "ref", message: "id", content: "text1800" }],
  message_react: ["AddReactions", { channel: "ref", message: "id", emoji: "text64" }],
  message_reactions_clear: ["ManageMessages", { channel: "ref", message: "id" }],
  message_pin: ["PinMessages", { channel: "ref", message: "id" }],
  message_unpin: ["PinMessages", { channel: "ref", message: "id" }],
  message_delete: ["ManageMessages", { channel: "ref", message: "id" }],
  message_purge: ["ManageMessages", { channel: "ref", count: "purgeCount", user: "?member" }],

  // === THREADS ===
  thread_create: ["CreatePublicThreads", { channel: "ref", name: "text100", private: "?boolean", message: "?text1800" }],
  thread_edit: ["ManageThreads", { channel: "ref", name: "?text100", archived: "?boolean", locked: "?boolean", slowmode: "?seconds" }],
  thread_member_add: ["ManageThreads", { channel: "ref", user: "member" }],
  thread_member_remove: ["ManageThreads", { channel: "ref", user: "member" }],
  thread_delete: ["ManageThreads", { channel: "ref" }],

  // === WEBHOOKS ===
  webhook_create: ["ManageWebhooks", { channel: "ref", name: "text80", avatarUrl: "?url" }],
  webhook_edit: ["ManageWebhooks", { webhook: "ref", name: "?text80", channel: "?ref" }],
  webhook_send: ["ManageWebhooks", { webhook: "ref", content: "text1800", username: "?text80", avatarUrl: "?url" }],
  webhook_delete: ["ManageWebhooks", { webhook: "ref" }],

  // === EMOJIS & STICKERS ===
  emoji_create: ["ManageGuildExpressions", { name: "text32", imageUrl: "url" }],
  emoji_edit: ["ManageGuildExpressions", { emoji: "text64", name: "text32" }],
  emoji_delete: ["ManageGuildExpressions", { emoji: "text64" }],
  sticker_create: ["ManageGuildExpressions", { name: "text30", tags: "text100", description: "?text100", imageUrl: "url" }],
  sticker_delete: ["ManageGuildExpressions", { sticker: "text64" }],

  // === SCHEDULED EVENTS ===
  event_create: [
    "ManageEvents",
    {
      name: "text100",
      startTimeIso: "text64",
      endTimeIso: "?text64",
      description: "?text1000",
      entityType: "eventType",
      channel: "?ref",
      location: "?text100",
    },
  ],
  event_edit: [
    "ManageEvents",
    {
      event: "id",
      name: "?text100",
      description: "?text1000",
      startTimeIso: "?text64",
      endTimeIso: "?text64",
      location: "?text100",
    },
  ],
  event_delete: ["ManageEvents", { event: "id" }],

  // === AUTOMOD ===
  automod_create: [
    "ManageGuild",
    {
      name: "text100",
      keywords: "?textList",
      regexPatterns: "?textList",
      mentionLimit: "?mentionLimit",
      blockMessage: "?boolean",
      timeoutSeconds: "?seconds",
      alertChannel: "?ref",
      enabled: "?boolean",
    },
  ],
  automod_edit: [
    "ManageGuild",
    {
      rule: "id",
      name: "?text100",
      keywords: "?textList",
      regexPatterns: "?textList",
      mentionLimit: "?mentionLimit",
      enabled: "?boolean",
    },
  ],
  automod_delete: ["ManageGuild", { rule: "id" }],

  // === INVITES ===
  invite_create: ["CreateInstantInvite", { channel: "ref", maxAgeHours: "?hours", maxUses: "?uses", temporary: "?boolean" }],
  invite_delete: ["ManageChannels", { code: "text32" }],
};

export const limits = {
  seconds: [0, 21600],
  minutes: [0, 40320],
  pruneDays: [1, 30],
  count: [1, 100],
  purgeCount: [1, 500],
  readLimit: [1, 50],
  listLimit: [1, 100],
  hours: [1, 768],
  uses: [0, 100],
  deleteDays: [0, 7],
  bitrate: [8000, 384000],
  userLimit: [0, 99],
  position: [0, 500],
  afkTimeout: [60, 3600],
  mentionLimit: [1, 50],
};

export const REF_TOKENS = new Set(["$last_role", "$last_channel", "$last_category", "$last_thread", "$last_webhook"]);

const CURRENT_CHANNEL_ALIASES = new Set([
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
]);

const EVERYONE_TARGET_MAP = new Map([
  ["everyone", "everyone"],
  ["@everyone", "everyone"],
  ["everybody", "everyone"],
  ["all", "everyone"],
  ["all members", "everyone"],
  ["all users", "everyone"],
  ["server", "everyone"],
  ["anyone", "everyone"],
  ["humans", "humans"],
  ["all humans", "humans"],
  ["members", "humans"],
  ["bots", "bots"],
  ["all bots", "bots"],
]);

function extractRenameTargetFromText(rawMessage = "") {
  const match = String(rawMessage || "").match(
    /\b(?:rename|renmae|change(?:\s+the)?\s+name(?:\s+of)?|call|set(?:\s+channel)?\s+name)\b[\s\S]{0,60}?\bto\s+["'`#]?([^\n"'`]{1,100})/i,
  );
  if (!match) return "";
  return match[1].trim().replace(/[.!?]+$/, "").trim();
}

export function normalizePlan(plan, fallbackChannelId = "", rawMessage = "") {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  if (!Array.isArray(plan.actions)) return plan;

  const normalized = plan.actions.map((rawStep) => {
    if (!rawStep || typeof rawStep !== "object") return rawStep;
    let action = String(rawStep.action || "").trim();
    const rawArgs = rawStep.args && typeof rawStep.args === "object" && !Array.isArray(rawStep.args)
      ? { ...rawStep.args }
      : {};

    if (action === "channel_rename") {
      action = "channel_edit";
    }

    // Channel field aliases
    for (const alias of ["channel_id", "channelId", "channel_ref", "targetChannel", "target_channel"]) {
      if (rawArgs.channel === undefined && rawArgs[alias] !== undefined) rawArgs.channel = rawArgs[alias];
      delete rawArgs[alias];
    }

    // Rename / channel_edit aliases + safety net
    if (action === "channel_edit") {
      for (const alias of ["newName", "new_name", "channelName", "channel_name", "renameTo", "rename_to", "to", "title", "value", "targetName", "target_name"]) {
        if (rawArgs.name === undefined && rawArgs[alias] !== undefined) rawArgs.name = rawArgs[alias];
        delete rawArgs[alias];
      }
      const hasAnyEditKey = ["name", "topic", "slowmode", "nsfw", "parent", "clearParent", "position", "bitrate", "userLimit"]
        .some((k) => rawArgs[k] !== undefined && rawArgs[k] !== "");
      if (!hasAnyEditKey && rawMessage) {
        const extracted = extractRenameTargetFromText(rawMessage);
        if (extracted) rawArgs.name = extracted;
      }
    }

    // Role field aliases
    for (const alias of ["roleName", "role_name", "roleId", "role_id", "targetRole", "target_role"]) {
      if (rawArgs.role === undefined && rawArgs[alias] !== undefined) rawArgs.role = rawArgs[alias];
      delete rawArgs[alias];
    }
    if (["role_add", "role_remove", "role_add_all", "role_remove_all", "role_delete"].includes(action)) {
      if (rawArgs.role === undefined && rawArgs.name !== undefined) {
        rawArgs.role = rawArgs.name;
        delete rawArgs.name;
      }
    }

    // Member / user aliases
    for (const alias of ["userId", "user_id", "member", "memberId", "member_id", "targetUser", "target_user", "username"]) {
      if (rawArgs.user === undefined && rawArgs[alias] !== undefined) rawArgs.user = rawArgs[alias];
      delete rawArgs[alias];
    }
    if (["role_add", "role_remove", "member_ban", "member_kick", "member_timeout", "member_nickname", "member_dm"].includes(action)) {
      if (rawArgs.user === undefined && rawArgs.target !== undefined) {
        rawArgs.user = rawArgs.target;
        delete rawArgs.target;
      }
    }

    // Auto-route role_add / role_remove targeting "everyone" / "all" / "humans" / "bots"
    if (action === "role_add" || action === "role_remove") {
      const userLower = String(rawArgs.user || "").trim().toLowerCase();
      const group = EVERYONE_TARGET_MAP.get(userLower);
      if (group) {
        action = action === "role_add" ? "role_add_all" : "role_remove_all";
        delete rawArgs.user;
        if (!rawArgs.targetGroup) rawArgs.targetGroup = group;
      }
    }

    // Auto-route member_nickname targeting "everyone"
    if (action === "member_nickname") {
      const userLower = String(rawArgs.user || "").trim().toLowerCase();
      const group = EVERYONE_TARGET_MAP.get(userLower);
      if (group) {
        action = "members_nickname_all";
        delete rawArgs.user;
        if (!rawArgs.targetGroup) rawArgs.targetGroup = group;
      }
    }

    // Bulk group aliases
    if (["role_add_all", "role_remove_all", "members_nickname_all"].includes(action)) {
      if (rawArgs.targetGroup === undefined && rawArgs.group !== undefined) {
        rawArgs.targetGroup = rawArgs.group;
      }
      if (rawArgs.targetGroup === undefined && rawArgs.target !== undefined) {
        rawArgs.targetGroup = rawArgs.target;
      }
      delete rawArgs.group;
      delete rawArgs.target;
      if (typeof rawArgs.targetGroup === "string") {
        const mapped = EVERYONE_TARGET_MAP.get(rawArgs.targetGroup.trim().toLowerCase());
        if (mapped) rawArgs.targetGroup = mapped;
      }
    }

    const schema = Object.hasOwn(ACTIONS, action) ? ACTIONS[action][1] : null;
    if (schema) {
      // Strip null/undefined values and stray keys not in schema when safe
      for (const [k, v] of Object.entries(rawArgs)) {
        if (v === undefined || v === null) {
          delete rawArgs[k];
        }
      }
      if (action === "voice_join" || action === "voice_say") {
        if (action === "voice_say" && rawArgs.text === undefined) {
          for (const alias of ["message", "content", "say", "prompt"]) {
            if (rawArgs[alias] !== undefined) {
              rawArgs.text = rawArgs[alias];
              delete rawArgs[alias];
              break;
            }
          }
        }
        const chRaw = typeof rawArgs.channel === "string" ? rawArgs.channel.trim().toLowerCase() : "";
        if (
          ["vc", "voice", "voice channel", "this vc", "my vc", "current vc", "call", "the call", "here"].includes(chRaw) ||
          (fallbackChannelId && chRaw === fallbackChannelId.toLowerCase())
        ) {
          delete rawArgs.channel;
        }
      } else if (Object.hasOwn(schema, "channel") && !schema.channel.startsWith("?")) {
        const ch = typeof rawArgs.channel === "string" ? rawArgs.channel.trim().toLowerCase() : "";
        if ((!ch || CURRENT_CHANNEL_ALIASES.has(ch)) && fallbackChannelId) {
          rawArgs.channel = fallbackChannelId;
        }
      } else if (Object.hasOwn(schema, "channel") && typeof rawArgs.channel === "string") {
        if (CURRENT_CHANNEL_ALIASES.has(rawArgs.channel.trim().toLowerCase()) && fallbackChannelId) {
          rawArgs.channel = fallbackChannelId;
        }
      }

      if (Object.hasOwn(schema, "toChannel") && typeof rawArgs.toChannel === "string") {
        if (CURRENT_CHANNEL_ALIASES.has(rawArgs.toChannel.trim().toLowerCase()) && fallbackChannelId) {
          rawArgs.toChannel = fallbackChannelId;
        }
      }

      for (const [key, rawType] of Object.entries(schema)) {
        const type = rawType.replace(/^\?/, "");
        const val = rawArgs[key];
        if (val === undefined) continue;
        if (limits[type] && typeof val === "string" && /^-?\d+$/.test(val.trim())) {
          rawArgs[key] = Number.parseInt(val.trim(), 10);
        } else if (type === "boolean" && typeof val === "string") {
          if (val.trim().toLowerCase() === "true") rawArgs[key] = true;
          else if (val.trim().toLowerCase() === "false") rawArgs[key] = false;
        } else if (type === "color" && typeof val === "string" && /^[\da-f]{6}$/i.test(val.trim())) {
          rawArgs[key] = `#${val.trim()}`;
        }
      }
    }

    return { action, args: rawArgs };
  });

  return { ...plan, actions: normalized };
}

const SLUG_CHANNEL_TYPES = new Set([0, 5, 15, 16, "GuildText", "GuildAnnouncement", "GuildForum", "GuildMedia", "text", "announcement", "forum"]);

export function formatChannelName(name, channelType) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Channel name cannot be empty.");
  if (SLUG_CHANNEL_TYPES.has(channelType)) {
    return trimmed.toLowerCase().replace(/\s+/g, "-").slice(0, 100);
  }
  return trimmed.slice(0, 100);
}

function stripDecorators(name) {
  return String(name || "")
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

export function resolveChannelFromList(channels, value, refs = {}) {
  const raw = String(value || "").trim();
  const list = [...(channels || [])].filter(Boolean);

  if (REF_TOKENS.has(raw)) {
    if (!refs[raw]) throw new Error(`No earlier created resource for ${raw}.`);
    const found = list.find((c) => c.id === refs[raw]);
    if (found) return found;
    throw new Error(`Referenced channel ${raw} (${refs[raw]}) not found.`);
  }
  if ((!raw || CURRENT_CHANNEL_ALIASES.has(raw.toLowerCase())) && refs.$current_channel) {
    const found = list.find((c) => c.id === refs.$current_channel);
    if (found) return found;
  }
  const mention = raw.match(/^<#(\d{17,20})>$/);
  if (idPattern.test(raw) || mention) {
    const id = idPattern.test(raw) ? raw : mention[1];
    const found = list.find((c) => c.id === id);
    if (found) return found;
    throw new Error(`Channel ID "${id}" not found in this server.`);
  }

  const cleanName = raw.replace(/^#/, "").trim().toLocaleLowerCase();
  const slugName = cleanName.replace(/\s+/g, "-");

  const exact = list.filter((c) => c.name.toLocaleLowerCase() === cleanName || c.name.toLocaleLowerCase() === slugName);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Multiple channels named "${raw}" — mention the channel or specify its ID.`);

  const fuzzy = list.filter((c) => {
    const stripped = stripDecorators(c.name);
    return stripped === cleanName || stripped === slugName;
  });
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) throw new Error(`Multiple channels match "${raw}" — mention the channel or specify its ID.`);

  throw new Error(`Channel "${raw}" not found in this server.`);
}

export function resolveRoleFromList(roles, value, refs = {}) {
  const raw = String(value || "").trim();
  const list = [...(roles || [])].filter(Boolean);

  if (REF_TOKENS.has(raw)) {
    if (!refs[raw]) throw new Error(`No earlier created role for ${raw}.`);
    const found = list.find((r) => r.id === refs[raw]);
    if (found) return found;
    throw new Error(`Referenced role ${raw} (${refs[raw]}) not found.`);
  }

  const mention = raw.match(/^<@&(\d{17,20})>$/);
  if (idPattern.test(raw) || mention) {
    const id = idPattern.test(raw) ? raw : mention[1];
    const found = list.find((r) => r.id === id);
    if (found) return found;
    throw new Error(`Role ID "${id}" not found in this server.`);
  }

  const cleanName = raw.replace(/^@/, "").trim().toLocaleLowerCase();
  const exact = list.filter((r) => r.name.trim().toLocaleLowerCase() === cleanName);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Multiple roles named "${raw}" — specify role ID.`);

  const fuzzy = list.filter((r) => stripDecorators(r.name) === cleanName);
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) throw new Error(`Multiple roles match "${raw}" — specify role ID.`);

  const partial = cleanName.length >= 2
    ? list.filter((r) => r.name.toLocaleLowerCase().includes(cleanName))
    : [];
  if (partial.length === 1) return partial[0];

  throw new Error(`Role "${raw}" not found in this server.`);
}

export function requiresDeleteConfirmation(plan) {
  return Boolean(plan?.actions?.some((step) => DELETE_ACTIONS.has(step.action)));
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Invalid plan.");
  if (!Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > 100) {
    throw new Error("Use 1–100 actions per plan.");
  }

  for (const step of plan.actions) {
    if (!step || !Object.hasOwn(ACTIONS, step.action)) {
      throw new Error(`Unsupported Discord action: ${step?.action || "unknown"}.`);
    }
    if (Object.keys(step).some((k) => !["action", "args"].includes(k))) {
      throw new Error("Unexpected action field.");
    }
    const args = step.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Invalid action arguments.");
    }
    const schema = ACTIONS[step.action][1];
    if (Object.keys(args).some((k) => !Object.hasOwn(schema, k))) {
      throw new Error(`Unknown action argument in ${step.action}.`);
    }

    for (const [key, rawType] of Object.entries(schema)) {
      const optional = rawType.startsWith("?");
      const type = rawType.replace(/^\?/, "");
      const value = args[key];
      if ((value === undefined || value === null) && optional) continue;

      let valid = false;
      if (type === "textList") {
        valid = Array.isArray(value) && value.length <= 50 && value.every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 100);
      } else if (/^text\d+$/.test(type)) {
        const allowEmpty = ["nickname", "topic", "description", "content", "status"].includes(key);
        valid = typeof value === "string" && value.length <= Number(type.slice(4)) && (value.trim().length > 0 || allowEmpty);
      } else if (type === "id") {
        valid = typeof value === "string" && idPattern.test(value.trim());
      } else if (type === "member") {
        valid = typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100;
      } else if (type === "ref") {
        valid = typeof value === "string" && (idPattern.test(value.trim()) || REF_TOKENS.has(value.trim()) || value.trim().length > 0 && value.trim().length <= 100);
      } else if (type === "refList") {
        valid = Array.isArray(value) && value.length <= 40 && value.every((v) => typeof v === "string" && v.trim().length > 0);
      } else if (type === "boolean") {
        valid = typeof value === "boolean";
      } else if (type === "color") {
        valid = typeof value === "string" && /^#[\da-f]{6}$/i.test(value.trim());
      } else if (type === "url") {
        valid = typeof value === "string" && /^https?:\/\/.+/i.test(value.trim());
      } else if (type === "channelType") {
        valid = ["text", "voice", "category", "announcement", "forum", "stage"].includes(value);
      } else if (type === "targetType") {
        valid = ["role", "member"].includes(value);
      } else if (type === "targetGroup") {
        valid = ["everyone", "humans", "bots"].includes(value);
      } else if (type === "presenceStatus") {
        valid = ["online", "idle", "dnd", "invisible"].includes(value);
      } else if (type === "activityType") {
        valid = ["playing", "watching", "listening", "competing", "custom"].includes(value);
      } else if (type === "eventType") {
        valid = ["voice", "stage", "external"].includes(value);
      } else if (type === "verificationLevel") {
        valid = ["none", "low", "medium", "high", "very_high"].includes(value);
      } else if (type === "contentFilter") {
        valid = ["disabled", "members_without_roles", "all_members"].includes(value);
      } else if (type === "notificationLevel") {
        valid = ["all_messages", "only_mentions"].includes(value);
      } else if (type === "permissions") {
        valid = Array.isArray(value) && value.length <= 50 && value.every((p) => typeof p === "string" && VALID_PERMISSION_FLAGS.has(p));
      } else if (limits[type]) {
        valid = Number.isInteger(value) && value >= limits[type][0] && value <= limits[type][1];
      }

      if (!valid && type === "id" && key === "user") {
        throw new Error(step.action === "member_unban"
          ? "Provide a Discord user ID to unban."
          : "Use a Discord user ID for this target.");
      }
      if (!valid) throw new Error(`Invalid ${step.action}.${key}.`);
    }

    if (step.action === "message_send" && !args.content && !args.embedTitle && !args.embedDescription) {
      throw new Error("message_send requires content or embed text.");
    }
    if (step.action === "channel_edit") {
      const hasAnyEdit = ["name", "topic", "slowmode", "nsfw", "parent", "clearParent", "position", "bitrate", "userLimit"]
        .some((k) => args[k] !== undefined);
      if (!hasAnyEdit) {
        throw new Error("channel_edit needs at least one change (e.g. name, topic, slowmode, nsfw, or parent).");
      }
    }
  }
  return plan;
}

export const ACTION_INTENT_RE = /\b(?:create|make|build|setup|set up|add|assign|give|grant|remove|take|strip|rename|renmae|change|edit|update|modify|set|delete|del|nuke|destroy|wipe|purge|clear|clean|ban|unban|kick|timeout|time out|mute|unmute|deafen|undeafen|move|drag|disconnect|dc|kick from vc|join|hop in|hop into|come to|enter|leave|exit|speak|talk|say|voice|vc|send|post|announce|pin|unpin|react|clone|copy|archive|unarchive|lock|unlock|hide|unhide|show|slowmode|nsfw|topic|category|role|roles|channel|channels|thread|forum|webhook|emoji|sticker|event|automod|invite|audit|logs|inspect|list|who has|who's in|whos in|members|bans|server|poll|dm|status|presence|nickname|nick|prune|backup|snapshot|stage|sync)\b/i;

const SMALL_TALK_ONLY_RE = /^(?:hi|hey|yo|sup|hello|ok|okay|k|kk|lol|lmao|lmfao|bruh|bro|fr|ty|thx|thanks|gm|gn|w|l|nice|cool|bet|real|true|same|mood|capri|wtf|what|why|how|yes|no|yeah|nah|yep|nope)[!?.]*$/i;

export function actionRequestText(message, prefix = "t") {
  const text = String(message?.content || "");
  const commandPrefix = `${prefix.toLowerCase()} do `;
  const command = text.toLowerCase().startsWith(commandPrefix);
  const named = /\bcapri\b/i.test(text) || Boolean(message?.client?.user && message?.mentions?.users?.has?.(message.client.user.id));
  const request = command ? text.slice(commandPrefix.length) : text;
  return { text, command, named, request: request.trim() };
}

export function isActionRequest(message, prefix = "t", allowUnaddressed = false) {
  const { text, command, named } = actionRequestText(message, prefix);
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (command) return true;
  if (ACTION_INTENT_RE.test(trimmed) && (named || allowUnaddressed)) return true;
  if (allowUnaddressed && /\b(?:read|check|show|open|fetch)\b[\s\S]*\b\d{17,20}\b/i.test(trimmed)) return true;
  return false;
}

export function shouldCheckAuthorizedAction(message, prefix = "t", hasRecentContext = false) {
  if (isActionRequest(message, prefix, true)) return true;
  const trimmed = String(message?.content || "").trim();
  if (!trimmed) return false;
  if (hasRecentContext) return true;
  // Let the AI planner handle multi-word casual requests even with typos/slang
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && !SMALL_TALK_ONLY_RE.test(trimmed)) return true;
  return false;
}

export function extractFailedSteps(results = []) {
  return (results || []).filter((line) => /^Step \d+ \([^)]+\) failed:/i.test(String(line || "")));
}

export function formatActionOutcome(results = []) {
  const lines = (results || []).map((line) => String(line || "").trim()).filter(Boolean);
  const failures = extractFailedSteps(lines);
  return {
    allSucceeded: failures.length === 0,
    failures,
    report: lines.join("\n"),
  };
}
