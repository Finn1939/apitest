import { readFileSync } from "node:fs";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
} from "discord.js";
import { config, validateConfig } from "./config.js";
import { parseCommand } from "./commands.js";
import { canRunCommands, COMMAND_DENIED } from "./command-auth.js";
import { searchWeb } from "./search.js";
import {
  addFact,
  addHistory,
  buildContext,
  forgetFacts,
  loadMemory,
  logMessage,
  parseRememberCommand,
  relationshipSummary,
  removeGuildMember,
  saveMemory,
  softDeleteMessageByDiscordId,
  syncGuildDirectory,
  updateMemberVoiceState,
  updateMessageContentByDiscordId,
  upsertGuildMember,
} from "./memory.js";
import { createMemoryDb } from "./db.js";
import { createJobs, embedText } from "./jobs.js";
import { createAnalyst } from "./analysis.js";
import { createAutonomyEngine, pickAutonomousReaction, shouldConsiderAutonomousReaction } from "./autonomy.js";
import { completeAI, askAI } from "./ai.js";
import { streamReply } from "./llm.js";
import { deliverReply, deliverStreamedReply, renderAliveness } from "./aliveness.js";
import {
  CONTEXT_GROUNDING,
  detectIntimacy,
  formatReactionSummary,
  isAddressedToBot,
  isChannelRenameChallenge,
  isDuplicateReply,
  isGameCommand,
  isPointingAtBot,
  learnedGameCommands,
  parseChannelRenameClaim,
  pickIdentityAnswer,
  shouldResolveReplyTarget,
  SPONTANEOUS_OPENERS,
} from "./replies.js";
import {
  renderButtons,
  renderChannelSnapshot,
  renderDiscordMentions,
  renderEmbeds,
  renderMediaExtras,
  visionUserContent,
} from "./render.js";
import {
  collectRichMediaAndText,
  collectVisionImages,
  VISION_UNAVAILABLE_NOTE,
} from "./media.js";
import { createActionHandler } from "./actions.js";

validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  makeCache: Options.cacheWithLimits({
    MessageManager: 50,
    UserManager: 500,
  }),
  rest: {
    rejectOnRateLimit: ["/channels"],
  },
  sweepers: {
    messages: { interval: 300, lifetime: 1800 },
  },
});

const storedMemory = loadMemory();
const conversations = storedMemory.conversations;
const channelFacts = storedMemory.facts;
const lastBotMessageAtByChannel = new Map();
const otherBotMessageAtByChannel = new Map();
const spontaneousReplies = new Map();
const botActivityByChannel = new Map();
const botCommandCountByChannel = new Map();
const engagedConversations = new Map();

const memoryDb = createMemoryDb(config.dbPath);
const jobs = createJobs(memoryDb);
const analyst = createAnalyst({
  completeAI,
  maxPerMinute: config.analysisMaxPerMinute,
  persona: config.personality.slice(0, 800),
});
const autonomy = createAutonomyEngine({
  db: memoryDb,
  completeAI,
  persona: config.personality,
});

for (const { command } of memoryDb.prepare("SELECT command FROM learned_commands").all()) {
  learnedGameCommands.add(command);
}

let pendingByChannel = new Map();
const lastSpokeAtRef = { value: Date.now() };

function persistMemory() {
  saveMemory(conversations, channelFacts);
}

// --- Ephemeral reaction tracking ---------------------------------------------
const sentMessageMetaById = new Map();
function trackSentMessage(message, content = "") {
  if (!message?.id) return;
  sentMessageMetaById.set(message.id, {
    channelId: message.channel?.id || "",
    content: String(content || "").slice(0, 280),
    message,
  });
  if (sentMessageMetaById.size > 80) {
    for (const oldest of sentMessageMetaById.keys()) {
      sentMessageMetaById.delete(oldest);
      break;
    }
  }
}

function noteSentMessageContent(messageId, content) {
  const meta = sentMessageMetaById.get(messageId);
  if (meta) meta.content = String(content || "").slice(0, 280);
}

const reactionsByChannel = new Map();
const HEART_REACT_RE = /❤|💕|💖|💗|💓|💘|🥰|😍|💌|😘|heart|love|labyu/i;

function recordReaction(channelId, { emoji, userName }) {
  if (!channelId || !emoji) return null;
  let list = reactionsByChannel.get(channelId);
  if (!list) {
    list = [];
    reactionsByChannel.set(channelId, list);
  }
  const record = { emoji, userName, at: Date.now(), meaning: "" };
  list.push(record);
  if (list.length > 40) list.splice(0, list.length - 40);
  return record;
}

function recentReactionSummary(channelId) {
  const list = (reactionsByChannel.get(channelId) || []).filter((entry) => Date.now() - entry.at < 30 * 60_000);
  return list.length ? formatReactionSummary(list) : null;
}

const reactionQueueByChannel = new Map();
const reactionFlushTimers = new Map();
const mirroredReactionMessageIds = new Set();

function queueReactionForAnalysis(channelId, entry) {
  let queue = reactionQueueByChannel.get(channelId);
  if (!queue) {
    queue = [];
    reactionQueueByChannel.set(channelId, queue);
  }
  queue.push(entry);
  if (queue.length > 20) queue.splice(0, queue.length - 20);
  if (queue.length >= 8) {
    flushReactions(channelId);
    return;
  }
  if (!reactionFlushTimers.has(channelId)) {
    reactionFlushTimers.set(channelId, setTimeout(() => flushReactions(channelId), config.reactionFlushMs));
  }
}

function fallbackHeartRule(entries) {
  for (const entry of entries) {
    if (HEART_REACT_RE.test(entry.emoji)) {
      updateRomance(entry.userId, { weight: 0.4, signal: `react:${entry.emoji}` });
    }
  }
}

function mirrorReaction(messageId, emoji) {
  if (mirroredReactionMessageIds.has(messageId)) return;
  const meta = sentMessageMetaById.get(messageId);
  mirroredReactionMessageIds.add(messageId);
  if (mirroredReactionMessageIds.size > 40) {
    for (const oldest of mirroredReactionMessageIds.keys()) {
      mirroredReactionMessageIds.delete(oldest);
      break;
    }
  }
  if (meta?.message?.react) {
    meta.message.react(emoji).catch(() => {});
  }
}

async function flushReactions(channelId) {
  const timer = reactionFlushTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    reactionFlushTimers.delete(channelId);
  }
  const queue = reactionQueueByChannel.get(channelId) || [];
  if (!queue.length) return;
  const batch = queue.splice(0, 10);
  if (queue.length) {
    reactionFlushTimers.set(channelId, setTimeout(() => flushReactions(channelId), 15_000));
  }

  try {
    const groups = new Map();
    for (const entry of batch) {
      if (!groups.has(entry.messageId)) {
        groups.set(entry.messageId, {
          herText: sentMessageMetaById.get(entry.messageId)?.content || "",
          reactions: [],
        });
      }
      groups.get(entry.messageId).reactions.push({ emoji: entry.emoji, who: entry.userName });
    }
    const results = await analyst.interpretReactions({
      groups: [...groups.values()],
      contextLines: recentHumanLines(channelId, 6),
      peopleNotes: bondsNotesFor(batch.map((entry) => entry.userId)),
    });
    if (!results) {
      fallbackHeartRule(batch);
      return;
    }
    const notedUsers = new Set();
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      const result = results[index];
      if (!result) continue;
      if (entry.record && result.meaning) entry.record.meaning = result.meaning;
      if (result.romanceWeight > 0) {
        updateRomance(entry.userId, { weight: result.romanceWeight, signal: `react:${entry.emoji}` });
      }
      if (result.reactBack && result.reactEmoji) {
        mirrorReaction(entry.messageId, result.reactEmoji);
      }
      if (result.note && !notedUsers.has(entry.userId)) {
        notedUsers.add(entry.userId);
        noteEventFact(entry.userId, result.note);
      }
    }
  } catch (error) {
    console.warn("Reaction interpretation failed; using fallback rule:", error.message);
    fallbackHeartRule(batch);
  }
}

function noteEventFact(userId, fact) {
  if (!userId || !fact) return;
  const now = Date.now();
  const existing = memoryDb.prepare("SELECT id FROM facts WHERE subject = ? AND fact = ?").get(`user:${userId}`, fact);
  if (existing) {
    memoryDb.prepare("UPDATE facts SET hits = hits + 1, last_seen = ? WHERE id = ?").run(now, existing.id);
  } else {
    memoryDb.prepare("INSERT INTO facts(subject, fact, confidence, first_seen, last_seen) VALUES (?, ?, 0.75, ?, ?)")
      .run(`user:${userId}`, fact, now, now);
  }
}

function isLearnedGameChannel(channelId) {
  return (channelFacts.get(channelId) || []).some((fact) => fact.includes("bot-game channel"));
}

function updateAffinity(userId, delta = 0.05) {
  if (!userId) return;
  const now = Date.now();
  const existing = memoryDb.prepare("SELECT affinity FROM relationships WHERE user_id = ?").get(userId);
  if (existing) {
    memoryDb.prepare("UPDATE relationships SET affinity = MIN(5, affinity + ?), last_interacted = ? WHERE user_id = ?")
      .run(delta, now, userId);
  } else {
    memoryDb.prepare("INSERT INTO relationships(user_id, affinity, last_interacted) VALUES (?, ?, ?)")
      .run(userId, delta, now);
  }
}

function updateRomance(userId, intimacy) {
  if (!userId || !intimacy) return;
  const now = Date.now();
  const delta = 0.06 * intimacy.weight;
  const existing = memoryDb.prepare("SELECT affinity, romance FROM relationships WHERE user_id = ?").get(userId);
  if (existing) {
    const ceiling = existing.affinity + 1;
    memoryDb.prepare("UPDATE relationships SET romance = MIN(5, MIN(?, romance + ?)), last_interacted = ? WHERE user_id = ?")
      .run(ceiling, delta, now, userId);
  } else {
    memoryDb.prepare("INSERT INTO relationships(user_id, affinity, last_interacted, romance) VALUES (?, 0, ?, ?)")
      .run(userId, now, Math.min(1, delta));
  }
}

function decayStaleRomance() {
  const cutoff = Date.now() - 14 * 86_400_000;
  memoryDb.prepare("UPDATE relationships SET romance = MAX(0, romance - 0.1) WHERE romance > 0 AND last_interacted < ?").run(cutoff);
}

function markEngaged(channelId, userId) {
  let users = engagedConversations.get(channelId);
  if (!users) {
    users = new Map();
    engagedConversations.set(channelId, users);
  }
  users.set(userId, Date.now() + config.convoEngageMs);
}

function isEngagedWith(channelId, userId) {
  const users = engagedConversations.get(channelId);
  if (!users) return false;
  const expiry = users.get(userId);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    users.delete(userId);
    return false;
  }
  return true;
}

function isAdminUser(userId) {
  return config.adminUserIds.has(userId);
}

function displayNameFor(userId) {
  const row = memoryDb.prepare(`
    SELECT author_name, username FROM messages
    WHERE author_id = ? ORDER BY id DESC LIMIT 1
  `).get(userId);
  if (row) {
    return row.username && row.username !== row.author_name ? `${row.author_name} (@${row.username})` : row.author_name;
  }
  const member = memoryDb.prepare("SELECT display_name, username FROM guild_members WHERE user_id = ? LIMIT 1").get(userId);
  if (member) {
    return member.username && member.username !== member.display_name ? `${member.display_name} (@${member.username})` : member.display_name;
  }
  return `<@${userId}>`;
}

async function confirmDeletion(send, userId, promptText) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("capri:mem:confirm").setLabel("Confirm deletion").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("capri:mem:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  const sent = await send({ content: `⚠️ ${promptText}`, components: [row], allowedMentions: { parse: [] } });
  try {
    const click = await sent.awaitMessageComponent({
      time: 120_000,
      filter: (i) => i.user.id === userId && ["capri:mem:confirm", "capri:mem:cancel"].includes(i.customId),
    });
    await click.deferUpdate();
    await sent.edit({ components: [] }).catch(() => {});
    if (click.customId === "capri:mem:cancel") {
      await sent.edit({ content: "Cancelled. Nothing was deleted." }).catch(() => {});
      return false;
    }
    return true;
  } catch {
    await sent.edit({ content: "Confirmation timed out. Nothing was deleted.", components: [] }).catch(() => {});
    return false;
  }
}

function meterBar(value, max = 5) {
  const clamped = Math.max(0, Math.min(max, Number(value) || 0));
  const filled = Math.round((clamped / max) * 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${clamped.toFixed(1)}/${max}`;
}

function formatUptime(seconds) {
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function randomDelay(minMinutes, maxMinutes) {
  return (minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60_000;
}

async function dedupeAnswer(channelId, prompt, answer, regenerate) {
  const lastAssistant = [...(conversations.get(channelId) || [])].reverse().find((entry) => entry.role === "assistant")?.content;
  if (!isDuplicateReply(answer, lastAssistant)) return answer;
  try {
    const nudged = `${prompt}\n(Note: do not repeat or paraphrase your previous reply "${lastAssistant.slice(0, 120)}". Say something fresh.)`;
    const retried = await regenerate(nudged);
    if (retried && retried.trim() && !isDuplicateReply(retried, lastAssistant)) {
      return retried.trim();
    }
  } catch (error) {
    console.warn("Dedup retry failed:", error.message);
  }
  return answer;
}

async function resolveReplyTarget(message) {
  const referenceId = message.reference?.messageId;
  if (!referenceId) return null;
  let ref = message.channel?.messages?.cache?.get(referenceId) || null;
  try {
    if (!ref) ref = await message.fetchReference();
  } catch {
    ref = null;
  }
  if (ref?.author) {
    const repliedUser = message.mentions?.repliedUser;
    if (repliedUser && repliedUser.id !== ref.author.id) return null;
    const refPanel = [renderEmbeds(ref.embeds), renderButtons(ref.components), renderMediaExtras(ref)].filter(Boolean).join(" ");
    const refText = renderDiscordMentions(ref.content || "", {
      users: ref.mentions?.users,
      roles: ref.mentions?.roles,
      channels: ref.mentions?.channels,
    });
    return {
      rawMessage: ref,
      authorName: ref.member?.displayName || ref.author.globalName || ref.author.username || "someone",
      authorId: ref.author.id,
      isSelf: ref.author.id === client.user.id,
      content: `${refText}${refPanel ? ` ${refPanel}` : ""}`.replace(/\s+/g, " ").trim().slice(0, 420),
      ageMs: Math.max(0, message.createdTimestamp - (ref.createdTimestamp || message.createdTimestamp)),
    };
  }
  const user = message.mentions?.repliedUser;
  if (!user) return null;
  const member = message.mentions?.members?.get(user.id);
  return {
    rawMessage: null,
    authorName: member?.displayName || user.globalName || user.displayName || user.username || "someone",
    authorId: user.id,
    isSelf: user.id === client.user.id,
    content: "",
    ageMs: 0,
  };
}

function realConversationCounts(sinceMs) {
  const rows = memoryDb.prepare("SELECT channel_id, content FROM messages WHERE created_at >= ? AND is_bot = 0").all(sinceMs);
  const counts = new Map();
  for (const row of rows) {
    if (isGameCommand(row.content)) continue;
    counts.set(row.channel_id, (counts.get(row.channel_id) || 0) + 1);
  }
  return counts;
}

function activeConversationChannels() {
  const counts = realConversationCounts(Date.now() - 24 * 60 * 60_000);
  return client.channels.cache.filter((channel) =>
    channel.isTextBased()
    && !channel.isDMBased?.()
    && channel.permissionsFor(client.user)?.has("SendMessages")
    && !isLearnedGameChannel(channel.id)
    && (counts.get(channel.id) || 0) >= 2,
  );
}

function rememberBotMessage(channelId, answer) {
  lastBotMessageAtByChannel.set(channelId, Date.now());
  const history = conversations.get(channelId) || [];
  conversations.set(channelId, addHistory(history, { role: "assistant", content: answer }));
  persistMemory();
}

function rememberOwnMessage(messageLike, answer) {
  if (!answer) return;
  const channelId = messageLike.channelId || messageLike.channel?.id;
  if (!channelId) throw new Error("Cannot remember a bot reply without a channel ID.");
  const loggedId = logMessage(memoryDb, {
    channelId: String(channelId),
    authorId: client.user.id,
    authorName: client.user.username,
    username: client.user.username,
    content: answer,
    createdAt: Date.now(),
    guildId: String(messageLike.guildId || messageLike.guild?.id || ""),
    isBot: true,
  });
  jobs.enqueueEmbedding(loggedId, answer);
}

function rememberUserMessage(channelId, displayName, content) {
  const history = conversations.get(channelId) || [];
  conversations.set(channelId, addHistory(history, { role: "user", content: `${displayName}: ${content}` }));
  persistMemory();
}

function rememberActionRequest(message) {
  const channelId = message.channelId || message.channel?.id;
  if (!channelId) throw new Error("Cannot remember an action request without a channel ID.");
  const content = renderDiscordMentions(message.content, {
    users: message.mentions.users,
    roles: message.mentions.roles,
    channels: message.mentions.channels,
  });
  const displayName = message.member?.displayName || message.author.username;
  const loggedId = logMessage(memoryDb, {
    channelId: String(channelId),
    authorId: message.author.id,
    authorName: displayName,
    username: message.author.username,
    content,
    createdAt: message.createdTimestamp,
    guildId: message.guild?.id || "",
    discordId: message.id,
  });
  jobs.enqueueEmbedding(loggedId, content);
  rememberUserMessage(String(channelId), displayName, content);
}

function rememberActionReply(message, content) {
  const channelId = message.channelId || message.channel?.id;
  if (!channelId) throw new Error("Cannot remember an action reply without a channel ID.");
  rememberBotMessage(String(channelId), content);
  rememberOwnMessage({ channelId, guildId: message.guildId || message.guild?.id }, content);
}

function factsContext(channelId) {
  const facts = channelFacts.get(channelId) || [];
  return facts.length ? `Things explicitly remembered in this channel:\n${facts.map((fact) => `- ${fact}`).join("\n")}` : "";
}

function recentHumanLines(channelId, limit = 10) {
  const rows = memoryDb.prepare(`
    SELECT author_name, content FROM messages
    WHERE channel_id = ? AND is_bot = 0
    ORDER BY id DESC LIMIT ?
  `).all(channelId, limit).reverse();
  return rows.map((row) => `${row.author_name}: ${row.content}`).join("\n");
}

function recentChannelLines(channelId, limit = 10) {
  const rows = memoryDb.prepare(`
    SELECT author_name, content, is_bot FROM messages
    WHERE channel_id = ? ORDER BY id DESC LIMIT ?
  `).all(channelId, limit).reverse();
  return rows.map((row) => row.is_bot ? `${row.author_name} [bot]: ${row.content}` : `${row.author_name}: ${row.content}`).join("\n");
}

function recentActionContext(message) {
  const rows = memoryDb.prepare(`
    SELECT author_id, author_name, content, is_bot FROM messages
    WHERE channel_id = ? AND (author_id = ? OR author_id = ?) AND created_at >= ?
    ORDER BY id DESC LIMIT 12
  `).all(message.channel.id, message.author.id, client.user.id, Date.now() - 10 * 60_000).reverse();
  return rows
    .filter((row) => !/run these actions/i.test(row.content || ""))
    .map((row) =>
      row.author_id === client.user.id ? `Capri: ${row.content}` : `${row.author_name}: ${row.content}`,
    )
    .join("\n");
}

function bondsNotesFor(userIds) {
  return [...new Set(userIds)].filter(Boolean).map((userId) => {
    const row = memoryDb.prepare("SELECT affinity, romance, last_interacted FROM relationships WHERE user_id = ?").get(userId);
    const name = displayNameFor(userId);
    if (!row) return `- ${name}: no bond yet`;
    const summary = relationshipSummary(row);
    const romanceBit = summary.romanceLabel ? `; romance — she ${summary.romanceLabel.replace("you", "them")}` : "";
    return `- ${name}: friendship — ${summary.friendLabel}${romanceBit}`;
  }).join("\n");
}

function recentSpeakers(channelId, limit = 6) {
  return memoryDb.prepare(`
    SELECT author_id FROM (
      SELECT author_id, MAX(id) AS last_id FROM messages
      WHERE channel_id = ? AND is_bot = 0 GROUP BY author_id
      ORDER BY last_id DESC LIMIT ?
    )
  `).all(channelId, limit).map((row) => row.author_id);
}

function isRepeatOfRecent(line, lines) {
  const head = String(line || "").slice(0, 40).trim().toLowerCase();
  if (!head) return true;
  return String(lines || "").toLowerCase().includes(head);
}

async function fetchLiveChannelLines(channel, referenceId) {
  try {
    const recent = await channel.messages.fetch({ limit: 12 });
    const msgs = [...recent.values()];
    if (referenceId && !msgs.some((msg) => msg.id === referenceId)) {
      try {
        const ref = await channel.messages.fetch(referenceId);
        if (ref) msgs.push(ref);
      } catch {
        // ignore
      }
    }
    return renderChannelSnapshot(msgs, client.user.id);
  } catch {
    return "";
  }
}

async function fetchGameChannelSnapshot(channel, referenceId) {
  const text = await fetchLiveChannelLines(channel, referenceId);
  return text
    ? `Recent messages in this channel (live view, oldest first):\n${text}`
    : "";
}

async function judgeChimeInFor(channel, occasion, referenceId) {
  let lines = recentChannelLines(channel.id, 10);
  if (isLearnedGameChannel(channel.id) && !channel.isDMBased?.()) {
    const live = await fetchLiveChannelLines(channel, referenceId);
    if (live) lines = live;
  }
  const moodState = autonomy.getState();
  const verdict = await analyst.judgeChimeIn({
    channelLabel: channel.name || "chat",
    lines,
    peopleNotes: bondsNotesFor(recentSpeakers(channel.id)),
    worldNote: renderAliveness(new Date(), lastSpokeAtRef.value, moodState.mood),
    occasion,
  });
  return { verdict, lines };
}

async function sendSpontaneousMessage(channel) {
  const lastReply = spontaneousReplies.get(channel.id) || 0;
  if (Date.now() - lastReply < config.spontaneousCooldownMs) return;
  spontaneousReplies.set(channel.id, Date.now());

  const moodState = autonomy.getState();
  const recent = recentHumanLines(channel.id, 10);

  if (config.analysisEnabled) {
    try {
      const decision = await autonomy.decideAutonomousAction({
        channelLabel: channel.name || "chat",
        recentLines: recent,
        peopleNotes: bondsNotesFor(recentSpeakers(channel.id)),
        worldNote: renderAliveness(new Date(), lastSpokeAtRef.value, moodState.mood),
        occasion: "checking in on the channel on her own initiative",
      });
      if (decision.action === "speak" && decision.line && !isRepeatOfRecent(decision.line, recent)) {
        await deliverReply({ channel, react: async () => {} }, decision.line, {
          lastSpokeAtRef,
          spontaneous: true,
          onSent: (sent) => trackSentMessage(sent, decision.line),
        });
        rememberBotMessage(channel.id, decision.line);
        rememberOwnMessage({ channel, guild: channel.guild }, decision.line);
        return;
      }
      if (decision.action === "silent") return;
    } catch (error) {
      console.warn("Autonomous pulse check failed:", error.message);
    }
  }

  const opener = SPONTANEOUS_OPENERS[Math.floor(Math.random() * SPONTANEOUS_OPENERS.length)];
  const prompt = `Start a brief, natural message in this Discord channel. ${opener} One punchy message.${recent ? `\nRecent chat:\n${recent}` : ""}`;
  const answer = await askAI({
    prompt,
    personality: config.personality,
    systemContext: renderAliveness(new Date(), lastSpokeAtRef.value, moodState.mood),
  });
  await deliverReply({ channel, react: async () => {} }, answer, {
    lastSpokeAtRef,
    spontaneous: true,
    onSent: (sent) => trackSentMessage(sent, answer),
  });
  rememberBotMessage(channel.id, answer);
  rememberOwnMessage({ channel, guild: channel.guild }, answer);
}

function scheduleSpontaneousMessages() {
  const available = [...activeConversationChannels().values()];
  if (available.length) {
    const channel = available[Math.floor(Math.random() * available.length)];
    sendSpontaneousMessage(channel).catch((error) => console.error("Spontaneous chat failed:", error));
  }
  const minMins = config.autonomyLevel === "high" ? 7 : config.autonomyLevel === "low" ? 30 : 14;
  const maxMins = config.autonomyLevel === "high" ? 18 : config.autonomyLevel === "low" ? 60 : 32;
  setTimeout(scheduleSpontaneousMessages, randomDelay(minMins, maxMins));
}

const handleActions = createActionHandler({
  completeAI,
  enabled: process.env.DISCORD_ACTIONS_ENABLED !== "false",
  prefix: config.prefix,
  allowedUserIds: config.commandUserIds,
  allowGuildAdmins: config.allowGuildAdmins,
  trustLevel: config.commandTrustLevel,
  db: memoryDb,
  personality: config.personality,
  getRecentContext: recentActionContext,
  onRequest: rememberActionRequest,
  onReply: async (message, content) => {
    rememberActionReply(message, content);
    if (config.fullServerSync && message.guild) {
      await syncGuildDirectory(memoryDb, message.guild).catch(() => {});
    }
  },
});

// === READY & FULL SERVER SYNC ===
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} | Provider: ${config.aiProvider} | Model: ${config.aiModel} | Autonomy: ${config.autonomyLevel}`);
  memoryDb.prepare("UPDATE messages SET is_bot = 1 WHERE author_id = ?").run(readyClient.user.id);

  if (config.fullServerSync) {
    for (const guild of readyClient.guilds.cache.values()) {
      syncGuildDirectory(memoryDb, guild)
        .then((stats) => console.log(`[Capri sync] ${guild.name}: ${stats.memberCount} members, ${stats.channelCount} channels, ${stats.roleCount} roles`))
        .catch((err) => console.warn(`[Capri sync] failed for ${guild.name}:`, err.message));
    }
  }

  readyClient.application.commands.set([
    { name: "help", description: "How to talk to Capri and what she controls" },
    { name: "relationship", description: "How Capri feels about you", options: [{ name: "user", description: "Someone else (admins only)", type: 6, required: false }] },
    { name: "status", description: "Uptime, model, autonomy, and memory stats" },
    { name: "diary", description: "Read Capri's latest diary entry" },
    { name: "server_sync", description: "Re-sync all server members, roles, and channels into Capri's brain" },
    { name: "memory_stats", description: "Show persistent memory statistics" },
    { name: "memories", description: "Show remembered facts for a user", options: [{ name: "user", description: "Member to inspect", type: 6, required: true }] },
    { name: "forget_all", description: "Forget a user's facts and bond", options: [{ name: "user", description: "Member to forget", type: 6, required: true }] },
    { name: "reflect_now", description: "Run a self-reflection immediately" },
    { name: "friends", description: "Capri's closest bonds overview" },
    {
      name: "forget_fact",
      description: "Remove matching remembered facts for a user",
      options: [
        { name: "user", description: "Member to edit", type: 6, required: true },
        { name: "text", description: "Part of the fact to remove", type: 3, required: true },
      ],
    },
    { name: "reload_personality", description: "Re-read personality.txt without restarting" },
  ]).catch((error) => console.error("Failed to register slash commands:", error));

  setTimeout(scheduleSpontaneousMessages, randomDelay(4, 12));
  jobs.backgroundQueue.add(() => embedText("warmup")).catch(() => {});
  setInterval(() => jobs.backgroundQueue.add(() => jobs.reflect()), 7 * 24 * 60 * 60_000).unref();
  setInterval(() => jobs.backgroundQueue.add(async () => {
    jobs.decay();
    decayStaleRomance();
    await jobs.writeJournal();
  }), 24 * 60 * 60_000).unref();
});

// === LIVE GUILD TOPOLOGY & MEMBER SYNC EVENTS ===
const topologySyncTimers = new Map();
function scheduleTopologySync(guild) {
  if (!config.fullServerSync || !guild?.id) return;
  const prev = topologySyncTimers.get(guild.id);
  if (prev) clearTimeout(prev);
  topologySyncTimers.set(guild.id, setTimeout(() => {
    topologySyncTimers.delete(guild.id);
    syncGuildDirectory(memoryDb, guild).catch(() => {});
  }, 500));
}

client.on(Events.GuildCreate, (guild) => {
  if (config.fullServerSync) syncGuildDirectory(memoryDb, guild).catch(() => {});
});
client.on(Events.GuildUpdate, (_oldGuild, newGuild) => scheduleTopologySync(newGuild));
client.on(Events.ChannelCreate, (channel) => scheduleTopologySync(channel.guild));
client.on(Events.ChannelUpdate, (_oldCh, newCh) => scheduleTopologySync(newCh.guild));
client.on(Events.ChannelDelete, (channel) => scheduleTopologySync(channel.guild));
client.on(Events.ThreadCreate, (thread) => scheduleTopologySync(thread.guild));
client.on(Events.ThreadUpdate, (_oldTh, newTh) => scheduleTopologySync(newTh.guild));
client.on(Events.ThreadDelete, (thread) => scheduleTopologySync(thread.guild));
client.on(Events.GuildRoleCreate, (role) => scheduleTopologySync(role.guild));
client.on(Events.GuildRoleUpdate, (_oldRole, newRole) => scheduleTopologySync(newRole.guild));
client.on(Events.GuildRoleDelete, (role) => scheduleTopologySync(role.guild));

client.on(Events.GuildMemberAdd, async (member) => {
  upsertGuildMember(memoryDb, member.guild.id, member);
  if (!config.welcomeNewMembers || member.user?.bot) return;
  try {
    const channel = member.guild.systemChannel
      || member.guild.channels.cache.find((c) => c.isTextBased() && c.permissionsFor(client.user)?.has("SendMessages"));
    if (!channel) return;
    const line = await askAI({
      prompt: `${member.displayName} (@${member.user.username}) just joined the server "${member.guild.name}". Drop one short, natural greeting in Capri's voice — not corporate, like someone actually in the room noticing they walked in.`,
      personality: config.personality,
      systemContext: renderAliveness(new Date(), lastSpokeAtRef.value, autonomy.getState().mood),
    });
    if (line) {
      await channel.send({ content: line.slice(0, 500), allowedMentions: { parse: [] } });
      rememberBotMessage(channel.id, line);
      rememberOwnMessage({ channel, guild: member.guild }, line);
    }
  } catch {
    // non-fatal
  }
});

client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
  upsertGuildMember(memoryDb, newMember.guild.id, newMember);
});

client.on(Events.GuildMemberRemove, (member) => {
  removeGuildMember(memoryDb, member.guild.id, member.id);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  const userId = newState.id || oldState.id;
  if (guildId && userId) {
    updateMemberVoiceState(memoryDb, guildId, userId, newState.channelId || "");
  }
});

// === SLASH COMMANDS ===
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  const publicCommands = new Set(["help", "relationship", "status", "diary"]);
  if (!publicCommands.has(name) && !isAdminUser(interaction.user.id)) {
    await interaction.reply({ content: "Admin only.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: !publicCommands.has(name) });

  if (name === "help") {
    await interaction.editReply([
      "**Capri — Live Discord Control & Persona**",
      "- Talk naturally anywhere or mention `@Capri` — she remembers people, context, attachments, voice/video/images, and chimes in on her own.",
      "- **No fixed commands needed**: authorized users can just ask casually in chat (e.g. *\"rename #general to lounge and slowmode 5s\"*, *\"lock #announcements\"*, *\"who's in voice?\"*, *\"ban @spammer\"*).",
      "- **Create / Read / Update / Mod** actions execute immediately. **Delete / Purge** actions always prompt with **Confirm deletion** / **Cancel** buttons.",
      "- Prefix search: `t <query>` runs a quick web lookup.",
    ].join("\n"));
  } else if (name === "server_sync") {
    if (!interaction.guild) {
      await interaction.editReply("Run this inside a server.");
      return;
    }
    const stats = await syncGuildDirectory(memoryDb, interaction.guild);
    await interaction.editReply(`Synced **${interaction.guild.name}**: ${stats.memberCount} members, ${stats.channelCount} channels, ${stats.roleCount} roles.`);
  } else if (name === "relationship") {
    const requested = interaction.options.getUser("user");
    const target = requested && isAdminUser(interaction.user.id) ? requested : interaction.user;
    const row = memoryDb.prepare("SELECT affinity, romance, last_interacted FROM relationships WHERE user_id = ?").get(target.id);
    const botName = client.user.username;
    const targetName = target.id === interaction.user.id ? (interaction.member?.displayName || target.username) : target.displayName || target.username;
    if (!row || (row.affinity <= 0 && row.last_interacted <= 0)) {
      await interaction.editReply(`**${botName}** and **${targetName}** haven't really talked yet.`);
      return;
    }
    const summary = relationshipSummary(row);
    const lines = [
      `How **${botName}** feels about **${targetName}**:`,
      `**Friendship** — ${summary.friendLabel}`,
      `\`${meterBar(row.affinity)}\``,
      summary.romanceLabel ? `**Romance** — she ${summary.romanceLabel}\n\`${meterBar(summary.effectiveRomance)}\`` : "**Romance** — strictly platonic",
    ];
    await interaction.editReply(lines.join("\n"));
  } else if (name === "status") {
    const messages = memoryDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
    const facts = memoryDb.prepare("SELECT COUNT(*) AS count FROM facts").get().count;
    const members = memoryDb.prepare("SELECT COUNT(*) AS count FROM guild_members").get().count;
    const moodState = autonomy.getState();
    const ping = client.ws.ping >= 0 ? `${Math.round(client.ws.ping)}ms` : "measuring…";
    await interaction.editReply([
      `**${client.user.username} status**`,
      `Uptime: ${formatUptime(process.uptime())} | Ping: ${ping}`,
      `Provider: \`${config.aiProvider}\` | Model: \`${config.aiModel}\` | Autonomy: \`${config.autonomyLevel}\``,
      `Current mood: ${moodState.mood}`,
      `Brain: ${messages} messages, ${facts} facts, ${members} synced server members`,
    ].join("\n"));
  } else if (name === "diary") {
    const entry = memoryDb.prepare("SELECT entry, created_at FROM journal ORDER BY created_at DESC LIMIT 1").get();
    if (!entry) {
      await interaction.editReply("No diary entries yet — check back after tonight's reflection.");
      return;
    }
    await interaction.editReply(`**${client.user.username}'s diary — ${new Date(entry.created_at).toISOString().slice(0, 10)}**\n\n${entry.entry}`);
  } else if (name === "memory_stats") {
    const messages = memoryDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
    const facts = memoryDb.prepare("SELECT COUNT(*) AS count FROM facts").get().count;
    const members = memoryDb.prepare("SELECT COUNT(*) AS count FROM guild_members").get().count;
    await interaction.editReply(`Messages: ${messages}\nFacts: ${facts}\nSynced members: ${members}`);
  } else if (name === "memories") {
    const user = interaction.options.getUser("user");
    const rows = memoryDb.prepare("SELECT fact FROM facts WHERE subject = ? ORDER BY hits DESC, last_seen DESC LIMIT 20").all(`user:${user.id}`);
    await interaction.editReply(rows.length ? rows.map(({ fact }) => `- ${fact}`).join("\n") : "No memories for that user.");
  } else if (name === "forget_all") {
    const user = interaction.options.getUser("user");
    if (!await confirmDeletion((data) => interaction.editReply(data), interaction.user.id, `Delete stored facts and relationship scores for ${user.username}?`)) return;
    memoryDb.prepare("DELETE FROM facts WHERE subject = ?").run(`user:${user.id}`);
    memoryDb.prepare("DELETE FROM relationships WHERE user_id = ?").run(user.id);
    await interaction.editReply(`Forgot facts and bond for ${user.username}.`);
  } else if (name === "friends") {
    const friends = memoryDb.prepare("SELECT user_id, affinity, romance FROM relationships WHERE affinity > 0 ORDER BY affinity DESC LIMIT 10").all();
    const lines = friends.map((row) => `- ${displayNameFor(row.user_id)} — ${relationshipSummary(row).friendLabel}`);
    await interaction.editReply(lines.length ? lines.join("\n") : "No bonds recorded yet.");
  } else if (name === "forget_fact") {
    const user = interaction.options.getUser("user");
    const text = interaction.options.getString("text");
    if (!await confirmDeletion((data) => interaction.editReply(data), interaction.user.id, `Delete facts about ${user.username} matching "${text}"?`)) return;
    const removed = forgetFacts(memoryDb, `user:${user.id}`, text);
    await interaction.editReply(removed.length ? `Removed ${removed.length} fact(s).` : "No matching facts found.");
  } else if (name === "reload_personality") {
    const fresh = readFileSync(config.personalityPath, "utf8").trim();
    if (fresh) config.personality = fresh;
    await interaction.editReply(`Reloaded \`${config.personalityPath}\` (${fresh.length} chars).`);
  } else if (name === "reflect_now") {
    await jobs.backgroundQueue.add(() => jobs.reflect());
    await interaction.editReply("Self-reflection completed.");
  }
});

// === MESSAGE UPDATES, DELETES, REACTIONS ===
client.on(Events.MessageUpdate, async (_oldMessage, incoming) => {
  try {
    if (!incoming?.id) return;
    const edited = incoming.partial ? await incoming.fetch().catch(() => null) : incoming;
    if (!edited || edited.author?.id === client.user.id) return;
    const text = renderDiscordMentions(edited.content || "", {
      users: edited.mentions?.users,
      roles: edited.mentions?.roles,
      channels: edited.mentions?.channels,
    });
    const extras = [renderEmbeds(edited.embeds), renderButtons(edited.components), renderMediaExtras(edited)].filter(Boolean).join(" ");
    const full = [text, extras].filter(Boolean).join(" ").trim();
    if (full) updateMessageContentByDiscordId(memoryDb, edited.id, `${full} (edited)`);
  } catch {
    // ignore
  }
});

client.on(Events.MessageDelete, (deleted) => {
  if (deleted?.id) softDeleteMessageByDiscordId(memoryDb, deleted.id);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});
    const msg = reaction.message;
    if (!msg?.author || msg.author.id !== client.user.id) return;
    const emoji = reaction.emoji?.name || reaction.emoji?.toString() || "";
    const member = msg.guild?.members?.cache?.get(user.id);
    const userName = member?.displayName || user.globalName || user.username || "someone";
    const record = recordReaction(msg.channel?.id, { emoji, userName });
    if (config.analysisEnabled) {
      queueReactionForAnalysis(msg.channel.id, {
        messageId: msg.id,
        userId: user.id,
        userName,
        emoji,
        record,
      });
    } else if (HEART_REACT_RE.test(emoji)) {
      updateRomance(user.id, { weight: 0.4, signal: `react:${emoji}` });
    }
  } catch {
    // ignore
  }
});

// === MAIN MESSAGE LOOP ===
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    botActivityByChannel.set(message.channel.id, (botActivityByChannel.get(message.channel.id) || 0) + 1);
    if (message.author.id !== client.user.id) {
      otherBotMessageAtByChannel.set(message.channel.id, Date.now());
      const panelText = [renderEmbeds(message.embeds), renderButtons(message.components), renderMediaExtras(message)].filter(Boolean).join(" ");
      const logText = `${message.content || ""}${panelText ? ` ${panelText}` : ""}`.replace(/\s+/g, " ").trim();
      if (logText && !isLearnedGameChannel(message.channel.id)) {
        logMessage(memoryDb, {
          channelId: message.channel.id,
          authorId: message.author.id,
          authorName: message.author.displayName || message.author.username,
          username: message.author.username,
          content: logText.slice(0, 400),
          createdAt: message.createdTimestamp,
          guildId: message.guild?.id || "",
          isBot: true,
          discordId: message.id,
        });
      }
    }
    return;
  }

  if (message.guild && message.member) {
    upsertGuildMember(memoryDb, message.guild.id, message.member);
  }

  const command = parseCommand(message.content, config.prefix);
  if (command !== null && !canRunCommands(message.member || message.author.id, config.commandUserIds, { allowGuildAdmins: config.allowGuildAdmins })) {
    await message.reply({ content: COMMAND_DENIED, allowedMentions: { parse: [] } });
    return;
  }

  // 1) Casual natural-language server actions & takeover commands (no fixed command required!)
  if (await handleActions(message)) return;

  const gameCommand = isGameCommand(message.content);
  if (gameCommand) {
    const count = (botCommandCountByChannel.get(message.channel.id) || 0) + 1;
    botCommandCountByChannel.set(message.channel.id, count);
    if (count >= 5 && (botActivityByChannel.get(message.channel.id) || 0) >= 5) {
      const facts = channelFacts.get(message.channel.id) || [];
      const fact = "This is a bot-game channel where people spam short game commands.";
      if (!facts.includes(fact)) {
        channelFacts.set(message.channel.id, addFact(facts, fact));
        persistMemory();
      }
    }
  }

  const mentionLookups = {
    users: message.mentions.users,
    roles: message.mentions.roles,
    channels: message.mentions.channels,
  };
  const renderedContent = renderDiscordMentions(message.content, mentionLookups);
  const embedExtras = renderEmbeds(message.embeds, { maxLength: 1500 });
  const buttonExtras = renderButtons(message.components);
  const mediaExtras = renderMediaExtras(message);
  const loggedContent = [renderedContent, embedExtras, buttonExtras, mediaExtras].filter(Boolean).join(" ").trim();

  const loggedId = logMessage(memoryDb, {
    channelId: message.channel.id,
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.username,
    username: message.author.username,
    content: loggedContent,
    createdAt: message.createdTimestamp,
    guildId: message.guild?.id || "",
    discordId: message.id,
  });
  jobs.enqueueEmbedding(loggedId, loggedContent);

  const pending = (pendingByChannel.get(message.channel.id) || 0) + 1;
  pendingByChannel.set(message.channel.id, pending);
  if (pending >= 100) {
    pendingByChannel.set(message.channel.id, 0);
    jobs.backgroundQueue.add(() => jobs.consolidate(message.channel.id));
  }

  const displayName = message.member?.displayName || message.author.username;
  rememberUserMessage(message.channel.id, displayName, loggedContent);

  const mentioned = message.mentions.has(client.user);
  const inDm = message.channel.isDMBased?.() === true;
  const heuristicAddressed = isAddressedToBot(renderedContent, {
    botUsername: client.user.username,
    recentBotMessage: Date.now() - (lastBotMessageAtByChannel.get(message.channel.id) || 0) <= 5 * 60_000,
  });
  const repliedUser = message.mentions?.repliedUser;
  const replyingToAnotherBot = !mentioned && Boolean(repliedUser?.bot) && repliedUser.id !== client.user.id;
  const engaged = isEngagedWith(message.channel.id, message.author.id)
    && !gameCommand
    && !replyingToAnotherBot
    && renderedContent.trim().length >= 2;
  const addressed = mentioned || inDm || heuristicAddressed || engaged;

  let replyTarget = null;
  if (shouldResolveReplyTarget({
    hasReference: Boolean(message.reference?.messageId),
    mentioned,
    addressed,
    engaged,
    isCommand: command !== null,
  })) {
    replyTarget = await resolveReplyTarget(message);
  }

  // 2) Autonomous lurking behavior when NOT directly addressed!
  if (!addressed && command === null) {
    if (gameCommand || replyingToAnotherBot) return;

    // Autonomous silent emoji reaction like a real lurker
    if (shouldConsiderAutonomousReaction({
      isBot: false,
      isGameCmd: gameCommand,
      contentLength: renderedContent.length,
      chance: config.autonomousReactChance,
    })) {
      message.react(pickAutonomousReaction(renderedContent)).catch(() => {});
    }

    const lastSpontaneous = spontaneousReplies.get(message.channel.id) || 0;
    const canChime = Date.now() - lastSpontaneous >= config.spontaneousCooldownMs
      && renderedContent.trim().length >= 8
      && Math.random() < config.spontaneousChance;
    if (!canChime) return;

    spontaneousReplies.set(message.channel.id, Date.now());
    if (config.analysisEnabled) {
      try {
        const { verdict, lines } = await judgeChimeInFor(
          message.channel,
          "someone just said something in chat she noticed on her own",
          message.reference?.messageId,
        );
        if (verdict) {
          if (verdict.speak && verdict.line && !isRepeatOfRecent(verdict.line, lines)) {
            await deliverReply(message, verdict.line, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, verdict.line) });
            updateAffinity(message.author.id);
            markEngaged(message.channel.id, message.author.id);
            rememberBotMessage(message.channel.id, verdict.line);
            rememberOwnMessage(message, verdict.line);
          } else if (verdict.emoji) {
            message.react(verdict.emoji).catch(() => {});
          }
          return;
        }
      } catch (error) {
        console.warn("Autonomous chime-in failed:", error.message);
      }
    }
    return;
  }

  // 3) Direct / engaged conversation
  const stripped = message.content.replaceAll(`<@${client.user.id}>`, "").replaceAll(`<@!${client.user.id}>`, "");
  const prompt = command !== null
    ? renderDiscordMentions(command, mentionLookups).trim()
    : renderDiscordMentions(stripped, mentionLookups).trim();

  if (!prompt && !replyTarget?.content && !mediaExtras && !message.attachments?.size) {
    await message.reply("Yeah? What's up.");
    return;
  }

  const renameClaim = replyTarget?.isSelf
    ? parseChannelRenameClaim(replyTarget.rawMessage?.content || replyTarget.content)
    : null;
  if (message.guild && renameClaim && isChannelRenameChallenge(prompt)) {
    let answer;
    try {
      const liveChannel = await message.guild.channels.fetch(renameClaim.channelId, { force: true });
      if (!liveChannel) {
        answer = `Discord no longer returns <#${renameClaim.channelId}>, so I can't verify that rename.`;
      } else if (liveChannel.name === renameClaim.newName) {
        answer = `I checked Discord directly: <#${liveChannel.id}> is #${liveChannel.name}. The rename did apply. I can't see your client's display, so I won't guess why it still looks unchanged.`;
      } else {
        answer = `I checked Discord directly: <#${liveChannel.id}> is still #${liveChannel.name}, not #${renameClaim.newName}. The rename hasn't applied; I shouldn't have said otherwise.`;
      }
    } catch (error) {
      console.warn("Live channel rename verification failed:", error.message);
      answer = `I couldn't verify <#${renameClaim.channelId}> with Discord just now, so I won't guess whether the rename applied. Try again in a moment.`;
    }

    await message.reply({ content: answer, allowedMentions: { parse: [] } });
    updateAffinity(message.author.id);
    markEngaged(message.channel.id, message.author.id);
    rememberBotMessage(message.channel.id, answer);
    rememberOwnMessage(message, answer);
    return;
  }

  await message.channel.sendTyping();

  try {
    if (/who am i replying to|who is this reply to/i.test(prompt)) {
      const answer = pickIdentityAnswer(replyTarget, client.user.username);
      await deliverReply(message, answer, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, answer) });
      updateAffinity(message.author.id);
      markEngaged(message.channel.id, message.author.id);
      rememberBotMessage(message.channel.id, answer);
      rememberOwnMessage(message, answer);
      return;
    }

    const rememberedFact = command === null ? parseRememberCommand(prompt) : null;
    if ((rememberedFact || /^(forget everything|clear memory)$/i.test(prompt)) && !canRunCommands(message.member || message.author.id, config.commandUserIds, { allowGuildAdmins: config.allowGuildAdmins })) {
      await message.reply({ content: COMMAND_DENIED, allowedMentions: { parse: [] } });
      return;
    }

    if (rememberedFact) {
      const facts = channelFacts.get(message.channel.id) || [];
      channelFacts.set(message.channel.id, addFact(facts, rememberedFact));
      persistMemory();
      const answer = `Locked in memory for this channel: ${rememberedFact}`;
      await deliverReply(message, answer, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, answer) });
      rememberBotMessage(message.channel.id, answer);
      rememberOwnMessage(message, answer);
      return;
    }

    if (command === null && /^(forget everything|clear memory)$/i.test(prompt)) {
      if (!await confirmDeletion((data) => message.reply(data), message.author.id, "Wipe short-term channel history and manual channel facts?")) return;
      conversations.delete(message.channel.id);
      channelFacts.delete(message.channel.id);
      persistMemory();
      await message.reply("Short-term channel memory cleared.");
      return;
    }

    if (command !== null) {
      const results = await searchWeb(prompt);
      const searchCtx = results.length
        ? `Web search results:\n${results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.url}`).join("\n\n")}`
        : "No web results matched; answer from general knowledge.";
      const answer = await askAI({
        prompt,
        personality: config.personality,
        systemContext: `${renderAliveness(new Date(), lastSpokeAtRef.value, autonomy.getState().mood)}\n${searchCtx}`,
      });
      await deliverReply(message, answer, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, answer) });
      rememberBotMessage(message.channel.id, answer);
      rememberOwnMessage(message, answer);
      return;
    }

    // Full multimodal + memory-rich reply
    const factsContextText = factsContext(message.channel.id);
    const deepRecall = /\b(remember|that time|back when|used to|last week|yesterday|earlier|history)\b/i.test(prompt);

    const [visionImages, richMedia] = await Promise.all([
      collectVisionImages(message, { referencedMessage: replyTarget?.rawMessage }).catch(() => []),
      collectRichMediaAndText(message, { referencedMessage: replyTarget?.rawMessage }).catch(() => ({ textNotes: "", binaryMedia: [] })),
    ]);

    const imageAttachmentsFailed = visionImages.length === 0
      && [...(message.attachments?.values?.() || [])].some((a) => String(a.contentType || "").startsWith("image/"));

    const promptWithMedia = [prompt, embedExtras, buttonExtras, mediaExtras, richMedia.textNotes]
      .filter(Boolean)
      .join("\n")
      .trim();

    let embedVector = null;
    if (promptWithMedia) {
      try {
        embedVector = await embedText(promptWithMedia);
      } catch {
        // FTS fallback
      }
    }

    const pointingAtBot = isPointingAtBot(prompt) && repliedUser?.bot && repliedUser.id !== client.user.id
      ? (repliedUser.username || "bot")
      : "";

    const context = buildContext(memoryDb, {
      message: {
        channelId: message.channel.id,
        channelName: message.channel?.name || "",
        channelTopic: message.channel?.topic || "",
        authorId: message.author.id,
        authorName: displayName,
        content: promptWithMedia,
        guildId: message.guild?.id || "",
        pointingAtBot,
        reactionsSeen: recentReactionSummary(message.channel.id),
      },
      embedVector,
      deepRecall,
      personality: config.personality,
      botId: client.user.id,
      replyTo: replyTarget,
    });

    const liveSnapshot = !inDm && (isLearnedGameChannel(message.channel.id) || Date.now() - (otherBotMessageAtByChannel.get(message.channel.id) || 0) <= 5 * 60_000)
      ? await fetchGameChannelSnapshot(message.channel, message.reference?.messageId)
      : "";

    const moodState = autonomy.getState();
    const systemPrompt = [
      context.personality,
      renderAliveness(new Date(), lastSpokeAtRef.value, moodState.mood),
      context.memoryBlock,
      factsContextText,
      liveSnapshot,
      imageAttachmentsFailed ? VISION_UNAVAILABLE_NOTE : "",
      CONTEXT_GROUNDING,
    ].filter(Boolean).join("\n\n");

    const userContent = visionUserContent(
      promptWithMedia || "(pointing at attached media)",
      visionImages,
      richMedia.binaryMedia,
    );

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

    const streamed = await deliverStreamedReply(
      message,
      (onDelta) => streamReply({ messages, onDelta }),
      {
        lastSpokeAtRef,
        dupCheck: (candidate) => dedupeAnswer(message.channel.id, promptWithMedia, candidate, (nudged) =>
          askAI({ prompt: nudged, personality: config.personality, systemContext: context.memoryBlock })),
        onSent: (sent) => trackSentMessage(sent, ""),
      },
    );

    if (streamed) {
      noteSentMessageContent(message.id, streamed);
      updateAffinity(message.author.id);
      const intimacy = detectIntimacy(renderedContent);
      if (intimacy) updateRomance(message.author.id, intimacy);
      markEngaged(message.channel.id, message.author.id);
      rememberBotMessage(message.channel.id, streamed);
      rememberOwnMessage(message, streamed);
    }
  } catch (error) {
    console.error("Message handling error:", error);
    await message.reply("Signal glitched for a second — say that again?").catch(() => {});
  }
});

client.login(config.discordToken);
