import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ActivityType,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildVerificationLevel,
  OverwriteType,
  PermissionFlagsBits as P,
  PollLayoutType,
  StageInstancePrivacyLevel,
} from "discord.js";
import { canRunCommands, COMMAND_DENIED } from "./command-auth.js";
import { extractJson } from "./analysis.js";
import { renderDiscordMentions } from "./render.js";

import {
  ACTIONS,
  ACTION_INTENT_RE,
  actionRequestText,
  DELETE_ACTIONS,
  formatActionOutcome,
  formatChannelName,
  isActionRequest,
  normalizePlan,
  REF_TOKENS,
  requiresDeleteConfirmation,
  resolveChannelFromList,
  resolveRoleFromList,
  shouldCheckAuthorizedAction,
  validatePlan,
} from "./actions-schema.js";

export {
  ACTIONS,
  ACTION_INTENT_RE,
  actionRequestText,
  DELETE_ACTIONS,
  formatChannelName,
  isActionRequest,
  normalizePlan,
  requiresDeleteConfirmation,
  resolveChannelFromList,
  resolveRoleFromList,
  shouldCheckAuthorizedAction,
  validatePlan,
};

const idPattern = /^\d{17,20}$/;

export function checkPermission(member, permission, channel) {
  if (!permission || !P[permission]) return;
  const perms = channel ? channel.permissionsFor?.(member) : member.permissions;
  if (!perms?.has?.(P[permission])) {
    throw new Error(`Missing ${permission} permission for ${member.user?.username || member.id}.`);
  }
}

export function checkHierarchy(guild, actor, bot, target, allowSelf = false, { checkActor = true } = {}) {
  if (target.id === guild.ownerId) throw new Error("Target is the server owner — Discord blocks modifications above owner.");
  if (target.id === bot.id) throw new Error("Capri cannot moderate herself.");
  if (target.id === actor.id && !allowSelf) throw new Error("That action cannot target yourself.");
  if (checkActor && actor.id !== guild.ownerId && target.id !== actor.id && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    throw new Error("Target is at or above your highest role.");
  }
  if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    throw new Error("Target is at or above Capri's highest role.");
  }
}

function checkRole(guild, actor, bot, role, { checkActor = true, allowEveryone = false } = {}) {
  if (!role) throw new Error("Role not found.");
  if (role.id === guild.id) {
    if (!allowEveryone) throw new Error("Cannot assign or delete @everyone.");
    return;
  }
  if (role.managed || !role.editable) {
    throw new Error("That role cannot be managed by Capri.");
  }
  if (checkActor && actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error("Role is at or above your highest role.");
  }
  if (bot.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error("Role is at or above Capri's highest role.");
  }
  if (!bot.permissions.has(role.permissions)) {
    throw new Error("Role grants permissions beyond Capri's own role permissions.");
  }
}

export function resolveMemberId(message, value, { dbMembers = [] } = {}) {
  const text = String(value || "").trim();
  const mention = text.match(/^<@!?(\d{17,20})>$/);
  if (idPattern.test(text)) return text;
  if (mention) return mention[1];

  const requestedName = text.replace(/^@/, "").trim().toLocaleLowerCase();
  const cachedMembers = [
    ...(message.guild?.members?.cache?.values() || []),
    ...(message.mentions?.members?.values() || []),
  ];

  const matches = new Map();
  for (const member of cachedMembers) {
    const user = member.user || {};
    const names = [member.displayName, member.nickname, user.globalName, user.username]
      .filter(Boolean)
      .map((name) => String(name).trim().toLocaleLowerCase());
    if (names.includes(requestedName)) matches.set(member.id, member.id);
  }
  if (matches.size === 1) return matches.keys().next().value;
  if (matches.size > 1) throw new Error(`More than one server member matches "${text}". Mention them or give their ID.`);

  for (const row of dbMembers || []) {
    const names = [row.display_name, row.nickname, row.global_name, row.username]
      .filter(Boolean)
      .map((name) => String(name).trim().toLocaleLowerCase());
    if (names.includes(requestedName)) matches.set(row.user_id, row.user_id);
  }
  if (matches.size === 1) return matches.keys().next().value;
  if (matches.size > 1) throw new Error(`More than one synced member matches "${text}". Mention them or give their ID.`);

  throw new Error(`Couldn't find member "${text}". Mention them or provide their Discord user ID.`);
}

async function resolveChannelRef(guild, value, refs = {}) {
  const raw = String(value || "").trim();
  if (REF_TOKENS.has(raw)) {
    if (!refs[raw]) throw new Error(`No earlier created resource for ${raw}.`);
    return guild.channels.fetch(refs[raw], { force: true });
  }
  const mention = raw.match(/^<#(\d{17,20})>$/);
  if (idPattern.test(raw) || mention) {
    const id = idPattern.test(raw) ? raw : mention[1];
    const direct = await guild.channels.fetch(id, { force: true }).catch(() => null);
    if (direct) return direct;
  }
  if (!raw && refs.$current_channel) {
    const direct = await guild.channels.fetch(refs.$current_channel, { force: true }).catch(() => null);
    if (direct) return direct;
  }
  const all = await guild.channels.fetch();
  return resolveChannelFromList([...all.values()], raw, refs);
}

async function resolveRoleRef(guild, value, refs = {}) {
  const raw = String(value || "").trim();
  if (raw === "@everyone" || raw === "everyone") {
    return guild.roles.everyone || guild.roles.fetch(guild.id, { force: true });
  }
  if (REF_TOKENS.has(raw)) {
    if (!refs[raw]) throw new Error(`No earlier created role for ${raw}.`);
    return guild.roles.fetch(refs[raw], { force: true });
  }
  const mention = raw.match(/^<@&(\d{17,20})>$/);
  if (idPattern.test(raw) || mention) {
    const id = idPattern.test(raw) ? raw : mention[1];
    return guild.roles.fetch(id, { force: true });
  }
  const all = await guild.roles.fetch();
  return resolveRoleFromList([...all.values()], raw, refs);
}

function filterMembersByGroup(members, targetGroup = "everyone") {
  const group = targetGroup || "everyone";
  return members.filter((m) => {
    if (!m || !m.user) return false;
    if (group === "humans") return !m.user.bot;
    if (group === "bots") return Boolean(m.user.bot);
    return true;
  });
}

const CHANNEL_TYPE_MAP = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};

const ACTIVITY_TYPE_MAP = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

export async function executeStep(message, step, refs = {}, options = {}) {
  validatePlan({ actions: [step] });
  const guild = options.guild || message.guild;
  if (!guild) throw new Error("Server actions must be run inside a server.");

  if (!options.prefetched) {
    await guild.fetch();
    await guild.roles.fetch();
  }
  const actor = options.actor || await guild.members.fetch({ user: message.author.id, force: true });
  const bot = options.bot || await guild.members.fetchMe({ force: true });
  const checkActorPerms = options.trustLevel === "mirror_actor";
  const dbMembers = options.dbMembers || [];

  const a = { ...step.args };
  const reason = `Capri request ${message.id} by ${actor.id}${a.reason ? `: ${a.reason}` : ""}`;
  const permission = ACTIONS[step.action][0];

  if (!a.channel) {
    if (checkActorPerms) checkPermission(actor, permission, null);
    checkPermission(bot, permission, null);
  }

  let channel = null;
  if (a.channel) {
    channel = await resolveChannelRef(guild, a.channel, refs);
    if (!channel || channel.guildId !== guild.id) throw new Error("Channel not found in this server.");
    const effectivePerm = step.action === "channel_edit" && channel.isThread?.() ? "ManageThreads" : permission;
    if (checkActorPerms) {
      checkPermission(actor, effectivePerm, channel);
      checkPermission(actor, "ViewChannel", channel);
    }
    checkPermission(bot, effectivePerm, channel);
    checkPermission(bot, "ViewChannel", channel);
  }

  let role = null;
  if (a.role) {
    role = await resolveRoleRef(guild, a.role, refs);
    checkRole(guild, actor, bot, role, {
      checkActor: checkActorPerms,
      allowEveryone: step.action === "role_edit",
    });
  }

  if (a.permissions) {
    for (const p of a.permissions) {
      if (checkActorPerms) checkPermission(actor, p);
      checkPermission(bot, p);
    }
  }

  let target = null;
  if (a.user && step.action !== "member_unban") {
    a.user = resolveMemberId(message, a.user, { dbMembers });
    target = await guild.members.fetch({ user: a.user, force: true });
    const allowSelf = ["role_add", "role_remove", "member_roles_set", "member_nickname", "member_dm", "thread_member_add", "thread_member_remove"].includes(step.action);
    if (!["thread_member_add", "thread_member_remove", "member_dm"].includes(step.action)) {
      checkHierarchy(guild, actor, bot, target, allowSelf, { checkActor: checkActorPerms });
    }
  }

  const getMessage = async () => {
    if (!channel?.messages) throw new Error("Channel has no messages.");
    checkPermission(bot, "ReadMessageHistory", channel);
    return channel.messages.fetch(a.message);
  };

  switch (step.action) {
    // === READS ===
    case "server_inspect": {
      const members = await guild.members.fetch().catch(() => guild.members.cache);
      const chans = await guild.channels.fetch().catch(() => guild.channels.cache);
      const roles = guild.roles.cache.filter((r) => r.id !== guild.id);
      const inVoice = [...members.values()].filter((m) => m.voice?.channelId).map((m) => `${m.displayName} in <#${m.voice.channelId}>`);
      return `Server "${guild.name}" (${guild.id}) | Owner: <@${guild.ownerId}> | Members: ${guild.memberCount} | Boost Tier: ${guild.premiumTier} (${guild.premiumSubscriptionCount || 0} boosts) | Roles: ${roles.size} | Channels: ${chans.size} | In Voice: ${inVoice.length ? inVoice.join(", ") : "nobody"} | Description: ${guild.description || "(none)"}`;
    }
    case "members_list": {
      const fetched = await guild.members.fetch().catch(() => guild.members.cache);
      let list = [...fetched.values()];
      if (a.inVoiceOnly) list = list.filter((m) => Boolean(m.voice?.channelId));
      if (a.role) {
        const filterRole = await resolveRoleRef(guild, a.role, refs);
        list = list.filter((m) => m.roles.cache.has(filterRole.id));
      }
      if (a.query) {
        const q = a.query.toLowerCase();
        list = list.filter((m) =>
          [m.displayName, m.user.username, m.user.globalName, m.nickname, m.id]
            .filter(Boolean)
            .some((n) => n.toLowerCase().includes(q)),
        );
      }
      const cap = a.limit || 30;
      const shown = list.slice(0, cap).map((m) =>
        `${m.displayName} (@${m.user.username}, ${m.id})${m.user.bot ? " [bot]" : ""}${m.voice?.channelId ? ` [in voice: #${m.voice.channel?.name || m.voice.channelId}]` : ""}`,
      );
      return `Found ${list.length} member(s)${list.length > cap ? ` (showing ${cap})` : ""}:\n${shown.join("\n") || "None."}`;
    }
    case "member_inspect": {
      const rolesList = [...target.roles.cache.values()].filter((r) => r.id !== guild.id).sort((x, y) => y.position - x.position).map((r) => r.name);
      return `Member ${target.displayName} (@${target.user.username}, ID ${target.id}) | Joined: ${target.joinedAt?.toISOString().slice(0, 10) || "unknown"} | Roles: ${rolesList.join(", ") || "none"} | Timeout: ${target.communicationDisabledUntil ? target.communicationDisabledUntil.toISOString() : "none"} | Voice: ${target.voice?.channel ? `#${target.voice.channel.name}` : "not in voice"}`;
    }
    case "roles_list": {
      const list = [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id)
        .sort((x, y) => y.position - x.position)
        .slice(0, 40)
        .map((r) => `${r.name} (${r.id}, ${r.hexColor}, ${r.members.size} members)`);
      return `Roles (${guild.roles.cache.size - 1}):\n${list.join("\n") || "None."}`;
    }
    case "channels_list": {
      const fetched = await guild.channels.fetch();
      let list = [...fetched.values()].filter(Boolean);
      if (a.type) list = list.filter((c) => c.type === CHANNEL_TYPE_MAP[a.type]);
      const shown = list.sort((x, y) => (x.rawPosition ?? 0) - (y.rawPosition ?? 0)).slice(0, 50)
        .map((c) => `#${c.name} (${c.id}) [type:${ChannelType[c.type] || c.type}${c.parent ? `, in ${c.parent.name}` : ""}]`);
      return `Channels (${list.length}):\n${shown.join("\n") || "None."}`;
    }
    case "channel_inspect": {
      const fresh = await channel.fetch(true).catch(() => channel);
      return `Live channel <#${fresh.id}>: name=#${fresh.name} | ID=${fresh.id} | type=${ChannelType[fresh.type] || fresh.type} | category=${fresh.parent?.name || "none"} | slowmode=${fresh.rateLimitPerUser || 0}s | nsfw=${Boolean(fresh.nsfw)} | topic=${fresh.topic || "(none)"}`;
    }
    case "channel_read": {
      const fresh = await channel.fetch(true).catch(() => channel);
      const msgs = await fresh.messages.fetch({ limit: a.limit || 15 });
      const lines = [...msgs.values()].reverse().map((m) =>
        `[${m.id}] ${m.member?.displayName || m.author?.username || "unknown"}: ${m.content || (m.embeds?.length ? "[embed]" : "[media]")}`,
      );
      return `Live channel <#${fresh.id}> (#${fresh.name}, type=${ChannelType[fresh.type] || fresh.type}${fresh.topic ? `, topic="${fresh.topic}"` : ""})\nLast ${lines.length} message(s) in #${fresh.name}:\n${lines.join("\n") || "(empty)"}`;
    }
    case "bans_list": {
      const bans = await guild.bans.fetch({ limit: a.limit || 50 });
      const lines = [...bans.values()].map((b) => `${b.user.username} (${b.user.id}) — ${b.reason || "no reason"}`);
      return `Bans (${bans.size}):\n${lines.join("\n") || "None."}`;
    }
    case "invites_list": {
      const invites = await guild.invites.fetch();
      const lines = [...invites.values()].slice(0, 30).map((inv) =>
        `${inv.code} -> #${inv.channel?.name || "?"} (${inv.uses}/${inv.maxUses || "∞"} uses, by ${inv.inviter?.username || "?"})`,
      );
      return `Active invites (${invites.size}):\n${lines.join("\n") || "None."}`;
    }
    case "webhooks_list": {
      const hooks = channel ? await channel.fetchWebhooks() : await guild.fetchWebhooks();
      const lines = [...hooks.values()].map((w) => `${w.name} (${w.id}) in <#${w.channelId}>`);
      return `Webhooks (${hooks.size}):\n${lines.join("\n") || "None."}`;
    }
    case "emojis_list": {
      const emojis = await guild.emojis.fetch();
      const stickers = await guild.stickers.fetch();
      return `Emojis (${emojis.size}): ${[...emojis.values()].slice(0, 40).map((e) => `${e.name} (${e.id})`).join(", ") || "none"}\nStickers (${stickers.size}): ${[...stickers.values()].slice(0, 20).map((s) => `${s.name} (${s.id})`).join(", ") || "none"}`;
    }
    case "events_list": {
      const events = await guild.scheduledEvents.fetch();
      const lines = [...events.values()].map((e) => `${e.name} (${e.id}) at ${e.scheduledStartAt?.toISOString() || "?"}`);
      return `Scheduled events (${events.size}):\n${lines.join("\n") || "None."}`;
    }
    case "automod_list": {
      const rules = await guild.autoModerationRules.fetch();
      const lines = [...rules.values()].map((r) => `${r.name} (${r.id}) [${r.enabled ? "enabled" : "disabled"}]`);
      return `AutoMod rules (${rules.size}):\n${lines.join("\n") || "None."}`;
    }
    case "audit_logs_read": {
      const logs = await guild.fetchAuditLogs({ limit: a.limit || 15 });
      const lines = [...logs.entries.values()].map((e) =>
        `${e.actionType || e.action} by ${e.executor?.username || e.executorId || "?"} on target ${e.targetId || "?"}${e.reason ? ` (${e.reason})` : ""}`,
      );
      return `Recent audit log entries:\n${lines.join("\n") || "None."}`;
    }
    case "server_backup_snapshot": {
      const chans = await guild.channels.fetch().catch(() => guild.channels.cache);
      const roles = [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id)
        .sort((x, y) => y.position - x.position)
        .map((r) => `${r.name}(${r.hexColor},pos:${r.position})`);
      const cats = [...chans.values()]
        .filter((c) => c && c.type === ChannelType.GuildCategory)
        .map((c) => c.name);
      const chanList = [...chans.values()]
        .filter(Boolean)
        .sort((x, y) => (x.rawPosition ?? 0) - (y.rawPosition ?? 0))
        .slice(0, 40)
        .map((c) => `#${c.name}[${ChannelType[c.type] || c.type}${c.parent ? `/${c.parent.name}` : ""}]`);
      return `Backup snapshot of "${guild.name}" (${guild.id}): ${roles.length} roles [${roles.slice(0, 15).join(", ")}], ${cats.length} categories [${cats.join(", ")}], ${chans.size} channels [${chanList.join(", ")}]`;
    }

    // === SERVER MUTATIONS & BOT PRESENCE ===
    case "server_rename":
      await guild.setName(a.name, reason);
      return `Server renamed to "${a.name}".`;
    case "server_description":
      await guild.edit({ description: a.description || null, reason });
      return "Server description updated.";
    case "server_edit": {
      const editData = { reason };
      if (a.name !== undefined) editData.name = a.name;
      if (a.description !== undefined) editData.description = a.description || null;
      if (a.preferredLocale !== undefined) editData.preferredLocale = a.preferredLocale;
      if (a.afkTimeout !== undefined) editData.afkTimeout = a.afkTimeout;
      if (a.iconUrl !== undefined) editData.icon = a.iconUrl;
      if (a.bannerUrl !== undefined) editData.banner = a.bannerUrl;
      if (a.splashUrl !== undefined) editData.splash = a.splashUrl;
      if (a.premiumProgressBar !== undefined) editData.premiumProgressBarEnabled = a.premiumProgressBar;
      if (a.verificationLevel) {
        editData.verificationLevel = {
          none: GuildVerificationLevel.None,
          low: GuildVerificationLevel.Low,
          medium: GuildVerificationLevel.Medium,
          high: GuildVerificationLevel.High,
          very_high: GuildVerificationLevel.VeryHigh,
        }[a.verificationLevel];
      }
      if (a.explicitContentFilter) {
        editData.explicitContentFilter = {
          disabled: GuildExplicitContentFilter.Disabled,
          members_without_roles: GuildExplicitContentFilter.MembersWithoutRoles,
          all_members: GuildExplicitContentFilter.AllMembers,
        }[a.explicitContentFilter];
      }
      if (a.defaultNotifications) {
        editData.defaultMessageNotifications = {
          all_messages: GuildDefaultMessageNotifications.AllMessages,
          only_mentions: GuildDefaultMessageNotifications.OnlyMentions,
        }[a.defaultNotifications];
      }
      if (a.afkChannel) editData.afkChannel = (await resolveChannelRef(guild, a.afkChannel, refs)).id;
      if (a.systemChannel) editData.systemChannel = (await resolveChannelRef(guild, a.systemChannel, refs)).id;
      if (a.rulesChannel) editData.rulesChannel = (await resolveChannelRef(guild, a.rulesChannel, refs)).id;
      await guild.edit(editData);
      return `Updated server settings for "${guild.name}".`;
    }
    case "bot_presence_set": {
      const updates = [];
      if (a.status !== undefined || a.activityText !== undefined || a.activityType !== undefined) {
        const activities = a.activityText
          ? [{ name: a.activityText, type: ACTIVITY_TYPE_MAP[a.activityType || "playing"] ?? ActivityType.Playing }]
          : [];
        await guild.client.user.setPresence({
          status: a.status || "online",
          activities,
        });
        updates.push(`presence=${a.status || "online"}${a.activityText ? ` (${a.activityType || "playing"}: ${a.activityText})` : ""}`);
      }
      if (a.nickname !== undefined) {
        await bot.setNickname(a.nickname || null, reason);
        updates.push(`nickname="${a.nickname || "(reset)"}"`);
      }
      return `Updated Capri: ${updates.join(", ") || "presence refreshed"}.`;
    }

    // === ROLES & BULK ROLES ===
    case "role_create": {
      const opts = { name: a.name, reason };
      if (a.color !== undefined) opts.color = a.color;
      if (a.hoist !== undefined) opts.hoist = a.hoist;
      if (a.mentionable !== undefined) opts.mentionable = a.mentionable;
      if (a.position !== undefined) opts.position = a.position;
      if (a.unicodeEmoji !== undefined) opts.unicodeEmoji = a.unicodeEmoji;
      opts.permissions = a.permissions ? a.permissions.map((p) => P[p]) : [];
      const created = await guild.roles.create(opts);
      refs.$last_role = created.id;
      return `Created role ${created.name} (${created.id}).`;
    }
    case "role_edit": {
      const opts = { reason };
      if (a.name !== undefined && role.id !== guild.id) opts.name = a.name;
      if (a.color !== undefined && role.id !== guild.id) opts.color = a.color;
      if (a.hoist !== undefined && role.id !== guild.id) opts.hoist = a.hoist;
      if (a.mentionable !== undefined && role.id !== guild.id) opts.mentionable = a.mentionable;
      if (a.position !== undefined && role.id !== guild.id) opts.position = a.position;
      if (a.permissions !== undefined) opts.permissions = a.permissions.map((p) => P[p]);
      await role.edit(opts);
      return `Updated role ${a.name || role.name} (${role.id}).`;
    }
    case "role_delete":
      await role.delete(reason);
      return `Deleted role ${role.name}.`;
    case "roles_bulk_delete": {
      const resolved = [];
      for (const rRef of a.roles) {
        const r = await resolveRoleRef(guild, rRef, refs);
        checkRole(guild, actor, bot, r, { checkActor: checkActorPerms });
        resolved.push(r);
      }
      const deletedNames = [];
      for (const r of resolved) {
        await r.delete(reason);
        deletedNames.push(r.name);
      }
      return `Deleted ${deletedNames.length} role(s): ${deletedNames.join(", ")}.`;
    }
    case "role_add":
      await target.roles.add(role, reason);
      return `Added role "${role.name}" to <@${target.id}>.`;
    case "role_remove":
      await target.roles.remove(role, reason);
      return `Removed role "${role.name}" from <@${target.id}>.`;
    case "role_add_all": {
      const fetched = await guild.members.fetch();
      let pool = filterMembersByGroup([...fetched.values()], a.targetGroup);
      if (a.filterRole) {
        const fRole = await resolveRoleRef(guild, a.filterRole, refs);
        pool = pool.filter((m) => m.roles.cache.has(fRole.id));
      }
      let added = 0;
      let skipped = 0;
      let failed = 0;
      for (const m of pool) {
        if (m.roles.cache.has(role.id)) {
          skipped += 1;
          continue;
        }
        try {
          await m.roles.add(role, reason);
          added += 1;
        } catch {
          failed += 1;
        }
      }
      return `Added role "${role.name}" to ${added} member(s) (${a.targetGroup || "everyone"}; ${skipped} already had it${failed ? `, ${failed} failed` : ""}).`;
    }
    case "role_remove_all": {
      const fetched = await guild.members.fetch();
      let pool = filterMembersByGroup([...fetched.values()], a.targetGroup);
      if (a.filterRole) {
        const fRole = await resolveRoleRef(guild, a.filterRole, refs);
        pool = pool.filter((m) => m.roles.cache.has(fRole.id));
      }
      let removed = 0;
      let skipped = 0;
      let failed = 0;
      for (const m of pool) {
        if (!m.roles.cache.has(role.id)) {
          skipped += 1;
          continue;
        }
        try {
          await m.roles.remove(role, reason);
          removed += 1;
        } catch {
          failed += 1;
        }
      }
      return `Removed role "${role.name}" from ${removed} member(s) (${a.targetGroup || "everyone"}; ${skipped} didn't have it${failed ? `, ${failed} failed` : ""}).`;
    }
    case "member_roles_set": {
      const resolvedRoles = [];
      for (const r of a.roles) {
        const resolved = await resolveRoleRef(guild, r, refs);
        checkRole(guild, actor, bot, resolved, { checkActor: checkActorPerms });
        resolvedRoles.push(resolved.id);
      }
      await target.roles.set(resolvedRoles, reason);
      return `Updated roles for <@${target.id}> (${resolvedRoles.length} role(s)).`;
    }

    // === CHANNELS & PERMISSIONS ===
    case "channel_create": {
      const opts = {
        name: a.name,
        type: CHANNEL_TYPE_MAP[a.type],
        reason,
      };
      if (a.parent) {
        const parent = await resolveChannelRef(guild, a.parent, refs);
        if (!parent || parent.type !== ChannelType.GuildCategory) throw new Error("Parent must be a category.");
        opts.parent = parent.id;
      }
      if (a.topic !== undefined) opts.topic = a.topic;
      if (a.slowmode !== undefined) opts.rateLimitPerUser = a.slowmode;
      if (a.nsfw !== undefined) opts.nsfw = a.nsfw;
      if (a.bitrate !== undefined) opts.bitrate = a.bitrate;
      if (a.userLimit !== undefined) opts.userLimit = a.userLimit;
      if (a.position !== undefined) opts.position = a.position;
      const created = await guild.channels.create(opts);
      if (created.type === ChannelType.GuildCategory) refs.$last_category = created.id;
      refs.$last_channel = created.id;
      return `Created ${a.type} channel ${created.name} (${created.id}).`;
    }
    case "channel_rename":
    case "channel_edit": {
      const liveBefore = await channel.fetch(true).catch(() => channel);
      const beforeName = liveBefore.name;
      const opts = { reason };
      let requestedRename = null;
      if (a.name !== undefined) {
        const formatted = formatChannelName(a.name, liveBefore.type);
        if (formatted !== beforeName) {
          opts.name = formatted;
          requestedRename = formatted;
        }
      }
      if (a.topic !== undefined) opts.topic = a.topic || null;
      if (a.slowmode !== undefined) opts.rateLimitPerUser = a.slowmode;
      if (a.nsfw !== undefined) opts.nsfw = a.nsfw;
      if (a.position !== undefined) opts.position = a.position;
      if (a.bitrate !== undefined) opts.bitrate = a.bitrate;
      if (a.userLimit !== undefined) opts.userLimit = a.userLimit;
      if (a.clearParent) opts.parent = null;
      else if (a.parent) opts.parent = (await resolveChannelRef(guild, a.parent, refs)).id;

      if (Object.keys(opts).length === 1 && a.name !== undefined) {
        return `Channel <#${liveBefore.id}> is already named #${beforeName} (no edit needed).`;
      }
      if (Object.keys(opts).length <= 1) {
        throw new Error("Specify what to change on the channel (name, topic, slowmode, nsfw, or parent).");
      }

      let updated;
      try {
        updated = await Promise.race([
          liveBefore.edit(opts),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Discord rate-limited channel edits (Discord caps channel renames at 2 per 10 minutes per channel). Wait a few minutes and try again.")),
              10_000,
            ),
          ),
        ]);
      } catch (err) {
        const retrySecs = Number(err?.retryAfter || err?.data?.retry_after || 0);
        if (err?.name === "RateLimitError" || err?.status === 429 || retrySecs > 0) {
          const waitHint = retrySecs > 0 ? ` Retry in ~${Math.ceil(retrySecs)}s.` : " Wait a few minutes and try again.";
          throw new Error(`Discord rate-limited channel edits on #${beforeName} (2 renames per 10 minutes cap).${waitHint}`);
        }
        throw err;
      }

      const verified = await updated.fetch(true);
      if (requestedRename !== null && verified.name !== requestedRename) {
        throw new Error(`Discord did not apply rename on <#${verified.id}> (still #${verified.name} instead of #${requestedRename}).`);
      }

      return requestedRename !== null
        ? `Updated <#${verified.id}>: renamed #${beforeName} -> #${verified.name}.`
        : `Updated <#${verified.id}> (#${verified.name}).`;
    }
    case "channel_clone": {
      const cloned = await channel.clone({ name: a.name || `${channel.name}-copy`, reason });
      refs.$last_channel = cloned.id;
      return `Cloned #${channel.name} to #${cloned.name} (${cloned.id}).`;
    }
    case "channel_permissions_set": {
      const targetId = a.targetType === "role"
        ? (a.target === "@everyone" || a.target === "everyone" ? guild.id : (await resolveRoleRef(guild, a.target, refs)).id)
        : resolveMemberId(message, a.target, { dbMembers });
      const overwrites = {};
      for (const perm of a.allow || []) overwrites[perm] = true;
      for (const perm of a.deny || []) overwrites[perm] = false;
      await channel.permissionOverwrites.edit(
        targetId,
        overwrites,
        { type: a.targetType === "role" ? OverwriteType.Role : OverwriteType.Member, reason },
      );
      return `Updated permission overwrites on #${channel.name} for ${a.target}.`;
    }
    case "channel_permissions_delete": {
      const targetId = a.targetType === "role"
        ? (a.target === "@everyone" || a.target === "everyone" ? guild.id : (await resolveRoleRef(guild, a.target, refs)).id)
        : resolveMemberId(message, a.target, { dbMembers });
      await channel.permissionOverwrites.delete(targetId, reason);
      return `Cleared permission overwrites on #${channel.name} for ${a.target}.`;
    }
    case "channel_sync_permissions": {
      if (!channel.lockPermissions) throw new Error("Channel cannot sync permissions with a category.");
      await channel.lockPermissions(reason);
      return `Synced #${channel.name} permissions with its parent category.`;
    }
    case "channel_delete":
      await channel.delete(reason);
      return `Deleted channel #${channel.name} (${channel.id}).`;
    case "channels_bulk_delete": {
      const targets = [];
      for (const chRef of a.channels) {
        const c = await resolveChannelRef(guild, chRef, refs);
        if (checkActorPerms) checkPermission(actor, "ManageChannels", c);
        checkPermission(bot, "ManageChannels", c);
        targets.push(c);
      }
      const deleted = [];
      for (const c of targets) {
        const cName = c.name;
        await c.delete(reason);
        deleted.push(`#${cName}`);
      }
      return `Deleted ${deleted.length} channel(s): ${deleted.join(", ")}.`;
    }

    // === MEMBERS & VOICE & MODERATION ===
    case "member_ban":
      if (!target.bannable) throw new Error("Member is not bannable.");
      await target.ban({ reason, deleteMessageSeconds: (a.deleteMessageDays || 0) * 86400 });
      return `Banned <@${target.id}>.`;
    case "member_unban":
      await guild.members.unban(a.user, reason);
      return `Unbanned user ${a.user}.`;
    case "member_kick":
      if (!target.kickable) throw new Error("Member is not kickable.");
      await target.kick(reason);
      return `Kicked <@${target.id}>.`;
    case "member_timeout":
      if (!target.moderatable) throw new Error("Member cannot be timed out.");
      await target.timeout(a.minutes ? a.minutes * 60_000 : null, reason);
      return a.minutes ? `Timed out <@${target.id}> for ${a.minutes} minutes.` : `Removed timeout from <@${target.id}>.`;
    case "member_nickname":
      await target.setNickname(a.nickname || null, reason);
      return a.nickname ? `Changed <@${target.id}>'s nickname to "${a.nickname}".` : `Cleared <@${target.id}>'s nickname.`;
    case "members_nickname_all": {
      const fetched = await guild.members.fetch();
      const pool = filterMembersByGroup([...fetched.values()], a.targetGroup);
      let updatedCount = 0;
      let skippedCount = 0;
      for (const m of pool) {
        if (m.id === guild.ownerId || bot.roles.highest.comparePositionTo(m.roles.highest) <= 0) {
          skippedCount += 1;
          continue;
        }
        try {
          await m.setNickname(a.nickname || null, reason);
          updatedCount += 1;
        } catch {
          skippedCount += 1;
        }
      }
      return `Updated nicknames for ${updatedCount} member(s) (${skippedCount} skipped due to hierarchy).`;
    }
    case "members_prune": {
      const pruned = await guild.members.prune({ days: a.days, dry: Boolean(a.computeOnly), reason });
      return a.computeOnly
        ? `Dry-run prune estimate (${a.days}d inactive): ${pruned ?? 0} member(s) would be pruned.`
        : `Pruned ${pruned ?? 0} inactive member(s) (${a.days}d threshold).`;
    }
    case "member_dm": {
      await target.send({ content: a.content, allowedMentions: { parse: [] } });
      return `Sent DM to <@${target.id}>.`;
    }
    case "member_move": {
      const dest = await resolveChannelRef(guild, a.channel, refs);
      if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(dest.type)) {
        throw new Error("Destination must be a voice or stage channel.");
      }
      await target.voice.setChannel(dest, reason);
      return `Moved <@${target.id}> to #${dest.name}.`;
    }
    case "member_disconnect":
      if (!target.voice?.channel) throw new Error("Member is not in voice.");
      await target.voice.disconnect(reason);
      return `Disconnected <@${target.id}> from voice.`;
    case "member_mute":
      if (!target.voice?.channel) throw new Error("Member is not in voice.");
      await target.voice.setMute(a.enabled, reason);
      return `${a.enabled ? "Server-muted" : "Unmuted"} <@${target.id}> in voice.`;
    case "member_deafen":
      if (!target.voice?.channel) throw new Error("Member is not in voice.");
      await target.voice.setDeaf(a.enabled, reason);
      return `${a.enabled ? "Server-deafened" : "Undeafened"} <@${target.id}> in voice.`;
    case "voice_move_all": {
      const dest = await resolveChannelRef(guild, a.toChannel, refs);
      if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(dest.type)) {
        throw new Error("Destination must be a voice or stage channel.");
      }
      const from = a.fromChannel ? await resolveChannelRef(guild, a.fromChannel, refs) : null;
      const fetched = await guild.members.fetch();
      const inVoice = [...fetched.values()].filter((m) => m.voice?.channelId && (!from || m.voice.channelId === from.id) && m.voice.channelId !== dest.id);
      let moved = 0;
      for (const m of inVoice) {
        try {
          await m.voice.setChannel(dest, reason);
          moved += 1;
        } catch {
          // skip
        }
      }
      return `Moved ${moved} member(s) to #${dest.name}.`;
    }
    case "voice_disconnect_all": {
      const fetched = await guild.members.fetch();
      const inVoice = [...fetched.values()].filter((m) => m.voice?.channelId && (!channel || m.voice.channelId === channel.id));
      let count = 0;
      for (const m of inVoice) {
        try {
          await m.voice.disconnect(reason);
          count += 1;
        } catch {
          // skip
        }
      }
      return `Disconnected ${count} member(s) from voice${channel ? ` in #${channel.name}` : ""}.`;
    }
    case "voice_mute_all": {
      const fetched = await guild.members.fetch();
      const inVoice = [...fetched.values()].filter((m) => m.voice?.channelId && (!channel || m.voice.channelId === channel.id));
      let count = 0;
      for (const m of inVoice) {
        try {
          await m.voice.setMute(a.enabled, reason);
          count += 1;
        } catch {
          // skip
        }
      }
      return `${a.enabled ? "Muted" : "Unmuted"} ${count} member(s) in voice.`;
    }
    case "voice_deafen_all": {
      const fetched = await guild.members.fetch();
      const inVoice = [...fetched.values()].filter((m) => m.voice?.channelId && (!channel || m.voice.channelId === channel.id));
      let count = 0;
      for (const m of inVoice) {
        try {
          await m.voice.setDeaf(a.enabled, reason);
          count += 1;
        } catch {
          // skip
        }
      }
      return `${a.enabled ? "Deafened" : "Undeafened"} ${count} member(s) in voice.`;
    }
    case "voice_status_set": {
      await guild.client.rest.put(`/channels/${channel.id}/voice-status`, { body: { status: a.status } });
      return `Set voice status on #${channel.name} to "${a.status || "(cleared)"}".`;
    }
    case "voice_join":
    case "voice_leave":
    case "voice_say": {
      throw new Error("2-way Gemini Live AI Voice Channel mode runs on the Python discord.py engine (`python python/bot.py`).");
    }
    case "stage_start": {
      if (channel.type !== ChannelType.GuildStageVoice) throw new Error("Target must be a stage channel.");
      const stage = await guild.stageInstances.create(channel, {
        topic: a.topic,
        privacyLevel: StageInstancePrivacyLevel.GuildOnly,
      });
      return `Started stage in #${channel.name}: "${stage.topic}".`;
    }
    case "stage_edit": {
      if (channel.type !== ChannelType.GuildStageVoice) throw new Error("Target must be a stage channel.");
      await guild.stageInstances.edit(channel, { topic: a.topic });
      return `Updated stage topic in #${channel.name} to "${a.topic}".`;
    }
    case "stage_end": {
      if (channel.type !== ChannelType.GuildStageVoice) throw new Error("Target must be a stage channel.");
      await guild.stageInstances.delete(channel);
      return `Ended stage in #${channel.name}.`;
    }

    // === MESSAGES & POLLS ===
    case "message_send": {
      if (!channel.isTextBased() || !channel.send) throw new Error("Channel is not text-writable.");
      const payload = {
        allowedMentions: a.allowMentions ? { parse: ["users", "roles"] } : { parse: [] },
      };
      if (a.content) payload.content = a.content;
      if (a.replyTo) payload.reply = { messageReference: a.replyTo };
      if (a.embedTitle || a.embedDescription) {
        payload.embeds = [{
          title: a.embedTitle || undefined,
          description: a.embedDescription || undefined,
          color: a.embedColor ? Number.parseInt(a.embedColor.replace("#", ""), 16) : 0xf59e0b,
        }];
      }
      const sent = await channel.send(payload);
      return `Sent message ${sent.id} in <#${channel.id}>.`;
    }
    case "poll_send": {
      if (!channel.isTextBased() || !channel.send) throw new Error("Channel cannot receive polls.");
      const sent = await channel.send({
        poll: {
          question: { text: a.question },
          answers: a.answers.slice(0, 10).map((text) => ({ text })),
          duration: a.hours ?? 24,
          allowMultiselect: Boolean(a.allowMultiselect),
          layoutType: PollLayoutType?.Default ?? 1,
        },
      });
      return `Created poll "${a.question}" (${sent.id}) in <#${channel.id}>.`;
    }
    case "message_edit": {
      const msg = await getMessage();
      if (msg.author.id !== bot.id) throw new Error("Capri can only edit her own messages.");
      await msg.edit({ content: a.content, allowedMentions: { parse: [] } });
      return `Edited message ${msg.id}.`;
    }
    case "message_react": {
      const msg = await getMessage();
      await msg.react(a.emoji);
      return `Reacted ${a.emoji} to message ${msg.id}.`;
    }
    case "message_reactions_clear": {
      const msg = await getMessage();
      await msg.reactions.removeAll();
      return `Cleared all reactions on message ${msg.id}.`;
    }
    case "message_pin":
      await (await getMessage()).pin(reason);
      return `Pinned message ${a.message} in #${channel.name}.`;
    case "message_unpin":
      await (await getMessage()).unpin(reason);
      return `Unpinned message ${a.message} in #${channel.name}.`;
    case "message_delete":
      await (await getMessage()).delete();
      return `Deleted message ${a.message} in #${channel.name}.`;
    case "message_purge": {
      if (!channel.bulkDelete) throw new Error("Bulk purge not supported in this channel.");
      checkPermission(bot, "ReadMessageHistory", channel);
      let remaining = a.count;
      let totalDeleted = 0;
      const filterUserId = a.user ? resolveMemberId(message, a.user, { dbMembers }) : null;
      while (remaining > 0) {
        const batchSize = Math.min(remaining, 100);
        const fetched = await channel.messages.fetch({ limit: batchSize });
        let targets = [...fetched.values()];
        if (filterUserId) targets = targets.filter((m) => m.author?.id === filterUserId);
        if (!targets.length) break;
        const deleted = await channel.bulkDelete(targets, true);
        totalDeleted += deleted.size;
        remaining -= batchSize;
        if (fetched.size < batchSize || deleted.size === 0) break;
      }
      return `Purged ${totalDeleted} message(s) in #${channel.name} (messages >14 days old are skipped by Discord).`;
    }

    // === THREADS ===
    case "thread_create": {
      const type = a.private ? ChannelType.PrivateThread : ChannelType.PublicThread;
      if (channel.type === ChannelType.GuildForum) {
        const post = await channel.threads.create({
          name: a.name,
          message: { content: a.message || a.name },
          reason,
        });
        refs.$last_thread = post.id;
        refs.$last_channel = post.id;
        return `Created forum post "${post.name}" (${post.id}).`;
      }
      const thread = await channel.threads.create({ name: a.name, type, autoArchiveDuration: 1440, reason });
      if (a.message) await thread.send({ content: a.message, allowedMentions: { parse: [] } });
      refs.$last_thread = thread.id;
      refs.$last_channel = thread.id;
      return `Created thread "${thread.name}" (${thread.id}).`;
    }
    case "thread_edit": {
      if (!channel.isThread()) throw new Error("Target must be a thread.");
      const opts = { reason };
      if (a.name !== undefined) opts.name = a.name;
      if (a.archived !== undefined) opts.archived = a.archived;
      if (a.locked !== undefined) opts.locked = a.locked;
      if (a.slowmode !== undefined) opts.rateLimitPerUser = a.slowmode;
      await channel.edit(opts);
      return `Updated thread "${channel.name}".`;
    }
    case "thread_member_add":
      if (!channel.isThread()) throw new Error("Target must be a thread.");
      await channel.members.add(target.id);
      return `Added <@${target.id}> to thread #${channel.name}.`;
    case "thread_member_remove":
      if (!channel.isThread()) throw new Error("Target must be a thread.");
      await channel.members.remove(target.id);
      return `Removed <@${target.id}> from thread #${channel.name}.`;
    case "thread_delete":
      if (!channel.isThread()) throw new Error("Target must be a thread.");
      await channel.delete(reason);
      return `Deleted thread "${channel.name}".`;

    // === WEBHOOKS ===
    case "webhook_create": {
      const hook = await channel.createWebhook({ name: a.name, avatar: a.avatarUrl, reason });
      refs.$last_webhook = hook.id;
      return `Created webhook "${hook.name}" (${hook.id}) in #${channel.name}.`;
    }
    case "webhook_edit": {
      const hookId = REF_TOKENS.has(a.webhook) ? refs[a.webhook] : a.webhook;
      const hook = await guild.fetchWebhooks().then((h) => h.get(hookId) || [...h.values()].find((x) => x.name.toLowerCase() === String(hookId).toLowerCase()));
      if (!hook) throw new Error("Webhook not found.");
      const opts = { reason };
      if (a.name) opts.name = a.name;
      if (a.channel) opts.channel = (await resolveChannelRef(guild, a.channel, refs)).id;
      await hook.edit(opts);
      return `Updated webhook "${hook.name}".`;
    }
    case "webhook_send": {
      const hookId = REF_TOKENS.has(a.webhook) ? refs[a.webhook] : a.webhook;
      const hook = await guild.fetchWebhooks().then((h) => h.get(hookId) || [...h.values()].find((x) => x.name.toLowerCase() === String(hookId).toLowerCase()));
      if (!hook) throw new Error("Webhook not found.");
      await hook.send({
        content: a.content,
        username: a.username || undefined,
        avatarURL: a.avatarUrl || undefined,
        allowedMentions: { parse: [] },
      });
      return `Sent webhook message via "${hook.name}".`;
    }
    case "webhook_delete": {
      const hookId = REF_TOKENS.has(a.webhook) ? refs[a.webhook] : a.webhook;
      const hook = await guild.fetchWebhooks().then((h) => h.get(hookId) || [...h.values()].find((x) => x.name.toLowerCase() === String(hookId).toLowerCase()));
      if (!hook) throw new Error("Webhook not found.");
      await hook.delete(reason);
      return `Deleted webhook "${hook.name}".`;
    }

    // === EMOJIS & STICKERS ===
    case "emoji_create": {
      const created = await guild.emojis.create({ name: a.name, attachment: a.imageUrl, reason });
      return `Created emoji :${created.name}: (${created.id}).`;
    }
    case "emoji_edit": {
      const emojis = await guild.emojis.fetch();
      const targetEmoji = emojis.get(a.emoji) || [...emojis.values()].find((e) => e.name.toLowerCase() === a.emoji.replace(/:/g, "").toLowerCase());
      if (!targetEmoji) throw new Error(`Emoji "${a.emoji}" not found.`);
      await targetEmoji.edit({ name: a.name, reason });
      return `Renamed emoji to :${a.name}:.`;
    }
    case "emoji_delete": {
      const emojis = await guild.emojis.fetch();
      const targetEmoji = emojis.get(a.emoji) || [...emojis.values()].find((e) => e.name.toLowerCase() === a.emoji.replace(/:/g, "").toLowerCase());
      if (!targetEmoji) throw new Error(`Emoji "${a.emoji}" not found.`);
      await targetEmoji.delete(reason);
      return `Deleted emoji :${targetEmoji.name}:.`;
    }
    case "sticker_create": {
      const created = await guild.stickers.create({ name: a.name, tags: a.tags, description: a.description || "", file: a.imageUrl, reason });
      return `Created sticker "${created.name}" (${created.id}).`;
    }
    case "sticker_delete": {
      const stickers = await guild.stickers.fetch();
      const targetSticker = stickers.get(a.sticker) || [...stickers.values()].find((s) => s.name.toLowerCase() === a.sticker.toLowerCase());
      if (!targetSticker) throw new Error(`Sticker "${a.sticker}" not found.`);
      await targetSticker.delete(reason);
      return `Deleted sticker "${targetSticker.name}".`;
    }

    // === SCHEDULED EVENTS ===
    case "event_create": {
      const entityType = {
        voice: GuildScheduledEventEntityType.Voice,
        stage: GuildScheduledEventEntityType.StageInstance,
        external: GuildScheduledEventEntityType.External,
      }[a.entityType];
      const opts = {
        name: a.name,
        scheduledStartTime: a.startTimeIso,
        scheduledEndTime: a.endTimeIso || undefined,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType,
        description: a.description || undefined,
        reason,
      };
      if (a.channel) opts.channel = (await resolveChannelRef(guild, a.channel, refs)).id;
      if (a.location) opts.entityMetadata = { location: a.location };
      const created = await guild.scheduledEvents.create(opts);
      return `Created event "${created.name}" (${created.id}).`;
    }
    case "event_edit": {
      const ev = await guild.scheduledEvents.fetch(a.event);
      const opts = { reason };
      if (a.name) opts.name = a.name;
      if (a.description !== undefined) opts.description = a.description;
      if (a.startTimeIso) opts.scheduledStartTime = a.startTimeIso;
      if (a.endTimeIso) opts.scheduledEndTime = a.endTimeIso;
      if (a.location) opts.entityMetadata = { location: a.location };
      await ev.edit(opts);
      return `Updated scheduled event "${ev.name}".`;
    }
    case "event_delete": {
      const ev = await guild.scheduledEvents.fetch(a.event);
      await ev.delete();
      return `Deleted scheduled event "${ev.name}".`;
    }

    // === AUTOMOD ===
    case "automod_create": {
      const triggerType = a.mentionLimit
        ? AutoModerationRuleTriggerType.MentionSpam
        : AutoModerationRuleTriggerType.Keyword;
      const triggerMetadata = a.mentionLimit
        ? { mentionTotalLimit: a.mentionLimit }
        : { keywordFilter: a.keywords || [], regexPatterns: a.regexPatterns || [] };
      const actions = [];
      if (a.blockMessage !== false) actions.push({ type: AutoModerationActionType.BlockMessage });
      if (a.timeoutSeconds) actions.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: a.timeoutSeconds } });
      if (a.alertChannel) {
        const alertChan = await resolveChannelRef(guild, a.alertChannel, refs);
        actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: alertChan.id } });
      }
      const created = await guild.autoModerationRules.create({
        name: a.name,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType,
        triggerMetadata,
        actions,
        enabled: a.enabled !== false,
        reason,
      });
      return `Created AutoMod rule "${created.name}" (${created.id}).`;
    }
    case "automod_edit": {
      const rule = await guild.autoModerationRules.fetch(a.rule);
      const opts = { reason };
      if (a.name) opts.name = a.name;
      if (a.enabled !== undefined) opts.enabled = a.enabled;
      if (a.keywords || a.regexPatterns || a.mentionLimit) {
        opts.triggerMetadata = {
          ...(a.keywords ? { keywordFilter: a.keywords } : {}),
          ...(a.regexPatterns ? { regexPatterns: a.regexPatterns } : {}),
          ...(a.mentionLimit ? { mentionTotalLimit: a.mentionLimit } : {}),
        };
      }
      await rule.edit(opts);
      return `Updated AutoMod rule "${rule.name}".`;
    }
    case "automod_delete": {
      const rule = await guild.autoModerationRules.fetch(a.rule);
      await rule.delete(reason);
      return `Deleted AutoMod rule "${rule.name}".`;
    }

    // === INVITES ===
    case "invite_create": {
      if (!channel.createInvite) throw new Error("Invites are not supported in this channel.");
      const invite = await channel.createInvite({
        maxAge: (a.maxAgeHours ?? 24) * 3600,
        maxUses: a.maxUses ?? 0,
        temporary: a.temporary ?? false,
        unique: true,
        reason,
      });
      return `Created invite: ${invite.url}`;
    }
    case "invite_delete": {
      const invites = await guild.invites.fetch();
      const targetInv = invites.get(a.code) || [...invites.values()].find((i) => i.code === a.code);
      if (!targetInv) throw new Error(`Invite "${a.code}" not found.`);
      await targetInv.delete(reason);
      return `Deleted invite ${a.code}.`;
    }

    default:
      throw new Error(`Unsupported action: ${step.action}`);
  }
}

export async function executePlan(message, plan, run = executeStep, options = {}) {
  const normalized = normalizePlan(plan, message?.channel?.id || "", message?.content || "");
  validatePlan(normalized);

  const guild = message.guild;
  let stepOptions = options;
  if (guild && !options.guild) {
    await guild.fetch().catch(() => {});
    await guild.roles.fetch().catch(() => {});
    const actor = await guild.members.fetch({ user: message.author.id, force: true }).catch(() => null);
    const bot = await guild.members.fetchMe({ force: true }).catch(() => null);
    stepOptions = { ...options, guild, actor, bot, prefetched: true };
  }

  const results = [];
  const refs = { $current_channel: message?.channel?.id || "" };
  for (const [index, step] of normalized.actions.entries()) {
    try {
      results.push(await run(message, step, refs, stepOptions));
    } catch (error) {
      results.push(`Step ${index + 1} (${step.action}) failed: ${error.message}`);
      break;
    }
  }
  return results;
}

export function createActionHandler({
  completeAI,
  enabled = true,
  prefix = "t",
  allowedUserIds = new Set(),
  allowGuildAdmins = true,
  trustLevel = "full",
  db = null,
  personality = "",
  getRecentContext = () => "",
  onRequest = () => {},
  onReply = () => {},
}) {
  const busy = new Set();
  const planning = new Map();

  return async function handleActionMessage(message) {
    if (!enabled || !message.guild) return false;

    const actorMember = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const actorObj = actorMember || message.author.id;
    const isAuthorized = canRunCommands(actorObj, allowedUserIds, { allowGuildAdmins });
    const recentContext = getRecentContext(message);
    const explicitCommand = isActionRequest(message, prefix, false);

    if (!isAuthorized) {
      if (explicitCommand) {
        await message.reply({ content: COMMAND_DENIED, allowedMentions: { parse: [] } }).catch(() => {});
        return true;
      }
      return false;
    }

    // Authorized users can command Capri casually even with typos/slang and no fixed prefix
    const shouldCheck = shouldCheckAuthorizedAction(message, prefix, Boolean(recentContext));
    if (!shouldCheck) return false;

    const key = `${message.guild.id}:${message.channel.id}:${message.author.id}`;
    const existingPlan = planning.get(key);
    if (existingPlan?.stage === "confirmation") {
      await message.reply({
        content: `Still waiting on your confirmation click for the pending delete plan: ${existingPlan.confirmationUrl}`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
      return true;
    }
    if (existingPlan) return false;

    planning.set(key, { stage: "planning" });
    let attemptedAction = false;

    try {
      await message.guild.roles.fetch().catch(() => {});
      const channels = await message.guild.channels.fetch().catch(() => message.guild.channels.cache);
      const dbMembers = db
        ? db.prepare("SELECT user_id, username, global_name, display_name, nickname FROM guild_members WHERE guild_id = ?").all(message.guild.id)
        : [];

      const context = {
        guildName: message.guild.name,
        guildId: message.guild.id,
        currentChannel: { id: message.channel.id, name: message.channel.name },
        recentConversation: recentContext,
        roles: [...message.guild.roles.cache.values()]
          .filter((r) => r.id !== message.guild.id)
          .slice(0, 60)
          .map((r) => ({ id: r.id, name: r.name })),
        channels: [...channels.values()]
          .filter(Boolean)
          .slice(0, 80)
          .map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type] || String(c.type) })),
        mentionedUsers: [...(message.mentions?.users?.values() || [])].map((u) => ({ id: u.id, name: u.username })),
        knownMembersSample: dbMembers.slice(0, 60).map((m) => ({
          id: m.user_id,
          name: m.display_name,
          username: m.username,
        })),
      };

      const actionSchemaSummary = Object.fromEntries(
        Object.entries(ACTIONS).map(([name, [, args]]) => [name, args]),
      );

      const raw = await completeAI({
        messages: [
          {
            role: "system",
            content: [
              "You are Capri's conversational Discord command planner. The user is an authorized server controller chatting naturally (often with typos, slang, or mid-sentence requests).",
              "Determine whether their message contains ANY server read/create/update/mod/bulk/voice/presence/poll/delete request.",
              "If it is purely casual chat with NO Discord server action/inspection requested, return ONLY: {\"actions\":[],\"chat\":true}",
              "If an action IS requested, return ONLY: {\"actions\":[{\"action\":\"...\",\"args\":{...}}],\"alsoChat\":true|false}",
              "If an action target/name is truly ambiguous, return ONLY: {\"actions\":[],\"clarification\":\"short question in Capri's voice\"}",
              `Supported action schemas (use EXACT argument key names!): ${JSON.stringify(actionSchemaSummary)}`,
              "CRITICAL EXAMPLES:",
              '- "rename this channel to saitama" -> {"actions":[{"action":"channel_edit","args":{"channel":"' + message.channel.id + '","name":"saitama"}}]}',
              '- "cpuld you add role coke to everyone" -> {"actions":[{"action":"role_add_all","args":{"role":"coke","targetGroup":"everyone"}}]}',
              '- "give everyone the vip role except bots" -> {"actions":[{"action":"role_add_all","args":{"role":"vip","targetGroup":"humans"}}]}',
              '- "create a category ops with text chat briefing and voice deck, then lock briefing" -> {"actions":[{"action":"channel_create","args":{"name":"ops","type":"category"}},{"action":"channel_create","args":{"name":"briefing","type":"text","parent":"$last_category"}},{"action":"channel_create","args":{"name":"deck","type":"voice","parent":"$last_category"}},{"action":"channel_permissions_set","args":{"channel":"briefing","target":"@everyone","targetType":"role","deny":["SendMessages"]}}]}',
              '- "hop in vc" -> {"actions":[{"action":"voice_join","args":{}}]}',
              '- "leave vc" -> {"actions":[{"action":"voice_leave","args":{}}]}',
              '- "delete #old-chat" -> {"actions":[{"action":"channel_delete","args":{"channel":"old-chat"}}]}',
              "Rules:",
              "- ALWAYS include required args using the EXACT schema key names: channel_edit MUST include at least one changed field like \"name\", \"topic\", \"slowmode\", \"nsfw\", \"parent\". role_add / role_remove / role_add_all / role_remove_all MUST use key \"role\" (NOT \"roleName\" or \"name\").",
              "- For bulk role/nickname operations across all members/humans/bots, use role_add_all, role_remove_all, or members_nickname_all.",
              "- Up to 100 actions per plan. Chain newly created IDs with $last_role, $last_channel, $last_category, $last_thread, $last_webhook.",
              "- Non-delete actions run IMMEDIATELY with NO button. ONLY delete/purge/prune actions wait for Confirm deletion / Cancel buttons.",
              "- NEVER invent snowflake IDs or tell the user to click 'Run these actions'.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              message: renderDiscordMentions(message.content, {
                users: message.mentions?.users,
                roles: message.mentions?.roles,
                channels: message.mentions?.channels,
              }),
              rawContent: message.content,
              context,
            }),
          },
        ],
        thinking: false,
        temperature: 0,
        responseMimeType: "application/json",
      });

      const parsed = extractJson(raw);
      if (!parsed) {
        if (explicitCommand) {
          await message.reply({ content: "Action planner choked on that response — say it one more time and I'll run it.", allowedMentions: { parse: [] } }).catch(() => {});
          return true;
        }
        return false;
      }

      if (!Array.isArray(parsed.actions) || !parsed.actions.length) {
        if (parsed.chat === true) return false;
        if (parsed.clarification) {
          onRequest(message);
          const msg = String(parsed.clarification).slice(0, 1800);
          await message.reply({ content: msg, allowedMentions: { parse: [] } });
          onReply(message, msg);
          return true;
        }
        return false;
      }

      attemptedAction = true;
      const normalized = normalizePlan({ actions: parsed.actions }, message.channel.id, message.content);
      const plan = validatePlan(normalized);
      onRequest(message);

      if (!requiresDeleteConfirmation(plan)) {
        if (busy.has(message.guild.id)) {
          await message.reply("Hold on — another server op is mid-flight, try again in a sec.");
          return true;
        }
        busy.add(message.guild.id);
        let results;
        try {
          results = await executePlan(message, plan, executeStep, { trustLevel, dbMembers });
        } finally {
          busy.delete(message.guild.id);
        }

        const outcome = formatActionOutcome(results);
        let finalReply = outcome.report.slice(0, 1900);

        if (!outcome.allSucceeded) {
          finalReply = `Hit a snag on that op:\n${outcome.report}`.slice(0, 1900);
        }

        await message.reply({ content: finalReply, allowedMentions: { parse: [] } });
        await onReply(message, finalReply);
        return true;
      }

      // === DELETE / PURGE CONFIRMATION GATE ===
      const snapshot = JSON.stringify(plan);
      const token = randomUUID();
      const rows = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`capri:approve:${token}`).setLabel("Confirm deletion").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`capri:cancel:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        ),
      ];
      const summaryLines = plan.actions.map((s, i) => `${i + 1}. **${s.action}** — \`${JSON.stringify(s.args)}\``).join("\n");
      const details = plan.actions.map((s, i) => `${i + 1}. ${s.action}\n${JSON.stringify(s.args, null, 2)}`).join("\n\n");

      const sent = await message.reply({
        content: `⚠️ **Deletion gate triggered** — nothing's wiped yet. Hit **Confirm deletion** within 2 minutes to pull the trigger, or **Cancel** to stand down.\n\n${summaryLines.slice(0, 1500)}`,
        files: [{ attachment: Buffer.from(details), name: "capri-delete-plan.txt" }],
        components: rows,
        allowedMentions: { parse: [] },
      });

      planning.set(key, { stage: "confirmation", confirmationUrl: sent.url });
      let click;
      try {
        click = await sent.awaitMessageComponent({
          time: 120_000,
          filter: (i) => i.user.id === message.author.id && [`capri:approve:${token}`, `capri:cancel:${token}`].includes(i.customId),
        });
      } catch {
        const expired = "Deletion timed out — nothing touched.";
        await sent.edit({ content: expired, components: [] }).catch(() => {});
        onReply(message, expired);
        return true;
      }

      await click.deferUpdate();
      await sent.edit({ components: [] });

      if (click.customId.includes(":cancel:")) {
        const cancelled = "Standing down. Nothing deleted.";
        await sent.edit({ content: cancelled });
        onReply(message, cancelled);
        return true;
      }

      if (busy.has(message.guild.id)) {
        const busyMsg = "Another server operation is already running — try again once it clears.";
        await sent.edit({ content: busyMsg });
        onReply(message, busyMsg);
        return true;
      }

      busy.add(message.guild.id);
      let results;
      try {
        results = await executePlan(message, JSON.parse(snapshot), executeStep, { trustLevel, dbMembers });
      } finally {
        busy.delete(message.guild.id);
      }

      const report = results.join("\n").slice(0, 1900);
      await click.followUp({ content: report, ephemeral: true, allowedMentions: { parse: [] } }).catch(() => {});
      await sent.edit({ content: `Done.\n${report}`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
      onReply(message, report);
      return true;
    } catch (error) {
      console.warn("Capri action handler error:", error.message);
      if (attemptedAction || explicitCommand) {
        await message.reply({
          content: `Ran into a wall executing that: ${error.message}`,
          allowedMentions: { parse: [] },
        }).catch(() => {});
        return true;
      }
      return false;
    } finally {
      planning.delete(key);
    }
  };
}
