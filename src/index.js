import { readFileSync } from "node:fs";
import "dotenv/config";
import { Client, Events, GatewayIntentBits, Options, Partials } from "discord.js";
import { config, validateConfig } from "./config.js";
import { parseCommand } from "./commands.js";
import { askAI, completeAI } from "./ai.js";
import { searchWeb } from "./search.js";
import {
  addFact,
  addHistory,
  forgetFacts,
  loadMemory,
  parseRememberCommand,
  relationshipSummary,
  saveMemory,
  buildContext,
  logMessage,
} from "./memory.js";
import { createMemoryDb } from "./db.js";
import { createJobs, embedText } from "./jobs.js";
import { streamReply } from "./llm.js";
import { deliverReply, deliverStreamedReply, renderAliveness } from "./aliveness.js";
import { renderDiscordMentions } from "./render.js";
import { detectIntimacy, isAddressedToBot, isDuplicateReply, isGameCommand, isReplyIdentityQuestion, pickIdentityAnswer, shouldResolveReplyTarget, SPONTANEOUS_OPENERS } from "./replies.js";

validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
  makeCache: Options.cacheWithLimits({
    MessageManager: 25,
    UserManager: 50,
    GuildMemberManager: 50,
  }),
  sweepers: {
    messages: { interval: 300, lifetime: 1800 },
  },
});

const storedMemory = loadMemory();
const conversations = storedMemory.conversations;
const channelFacts = storedMemory.facts;
const lastBotMessageAtByChannel = new Map();
const spontaneousReplies = new Map();
const botActivityByChannel = new Map();
const botCommandCountByChannel = new Map();
// channelId -> Map<userId, expiresAt>: after she replies to someone, that
// person's follow-up messages in the same channel are guaranteed a reply for
// a while, even without a mention or reply. This is how she keeps a
// conversation going like a person would.
const engagedConversations = new Map();
const memoryDb = createMemoryDb(config.dbPath);
const jobs = createJobs(memoryDb);
let pendingByChannel = new Map();
const lastSpokeAtRef = { value: Date.now() };

setInterval(() => {
  console.log(`RSS: ${process.memoryUsage().rss} bytes`);
}, 10 * 60_000).unref();

function persistMemory() {
  saveMemory(conversations, channelFacts);
}

function updateAffinity(userId) {
  const now = Date.now();
  memoryDb.prepare(`
    INSERT INTO relationships(user_id, affinity, last_interacted) VALUES (?, 0.05, ?)
    ON CONFLICT(user_id) DO UPDATE SET affinity = affinity + 0.05, last_interacted = ?
  `).run(userId, now, now);
}

// --- Romantic attachment ---------------------------------------------------
// A second axis, separate from friendship affinity. It only grows from
// intimacy signals in messages addressed to her, never from chat volume, so
// a regular she talks to every day stays a friend unless the warmth is there.
// Three guards stop spam from racing to "in love": a daily budget, the same
// words only counting once per day, and growth slowing the deeper it is.
const ROMANCE_DAILY_CAP = 1.0;
const ROMANCE_MAX = 5;
const romanceGrowthByUser = new Map();

function updateRomance(userId, { weight, signal }) {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let budget = romanceGrowthByUser.get(userId);
  if (!budget || budget.day !== dayKey) {
    budget = { day: dayKey, used: 0, signals: new Set() };
    romanceGrowthByUser.set(userId, budget);
  }
  if (budget.used >= ROMANCE_DAILY_CAP) return;
  const signalKey = `${weight}:${signal}`;
  if (budget.signals.has(signalKey)) return;
  budget.signals.add(signalKey);

  const current = memoryDb.prepare("SELECT romance FROM relationships WHERE user_id = ?").get(userId)?.romance ?? 0;
  if (current >= ROMANCE_MAX) return;
  const scale = Math.max(0.15, 1 - current / 6);
  const gain = Math.min(weight * scale, ROMANCE_DAILY_CAP - budget.used);
  if (gain <= 0) return;
  budget.used += gain;
  memoryDb.prepare(`
    INSERT INTO relationships(user_id, affinity, last_interacted, romance)
    VALUES (?, 0.05, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET romance = MIN(romance + ?, ?), last_interacted = ?
  `).run(userId, Date.now(), gain, gain, ROMANCE_MAX, Date.now());
}

// Feelings fade only after a full month of complete silence — never while
// the conversation is still alive.
function decayStaleRomance() {
  memoryDb.prepare(`
    UPDATE relationships
    SET romance = MAX(0, romance - 0.05)
    WHERE romance > 0 AND last_interacted < ?
  `).run(Date.now() - 30 * 24 * 60 * 60_000);
}

function randomDelay(minMinutes, maxMinutes) {
  return (minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60_000;
}

function markEngaged(channelId, userId) {
  if (!userId) return;
  let channel = engagedConversations.get(channelId);
  if (!channel) {
    channel = new Map();
    engagedConversations.set(channelId, channel);
  }
  channel.set(userId, Date.now() + config.convoEngageMs);
}

// Active engagement check; renews the window so a flowing conversation never
// expires mid-chat. Returns false once the user goes quiet past the window.
function isEngaged(channelId, userId) {
  const channel = engagedConversations.get(channelId);
  if (!channel) return false;
  const expiresAt = channel.get(userId);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    channel.delete(userId);
    if (!channel.size) engagedConversations.delete(channelId);
    return false;
  }
  channel.set(userId, Date.now() + config.convoEngageMs);
  return true;
}

// Short bot-game commands (Karuta, OwO, Dank-style) that should never count as
// conversation. The pattern itself lives in replies.js so tests can cover it.

function lastAssistantReply(channelId) {
  const history = conversations.get(channelId) || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "assistant") return history[index].content;
  }
  return null;
}

function dupNudge(prompt, lastText) {
  return `${prompt}\n\n[System instruction, never mention it: your previous message was already almost exactly "${String(lastText).slice(0, 200)}". Repeating yourself word-for-word is broken behavior — reply with clearly different words this time.]`;
}

// One retry when a fresh reply is a verbatim repeat of her last reply in that
// channel. Keeps the first answer if the retry fails or repeats again.
async function dedupeAnswer(channelId, basePrompt, answer, regenerate) {
  const last = lastAssistantReply(channelId);
  if (!last || !answer || !isDuplicateReply(answer, last)) return answer;
  try {
    const retry = await regenerate(dupNudge(basePrompt, last));
    if (retry && !isDuplicateReply(retry, last)) return retry.trim();
    console.warn("Dedup retry still repeated; keeping the first answer.");
  } catch (error) {
    console.warn("Dedup retry failed:", error.message);
  }
  return answer;
}

// A channel the bot has already learned is a bot-game channel (e.g. Karuta).
function isLearnedGameChannel(channelId) {
  const facts = channelFacts.get(channelId) || [];
  return facts.some((fact) => fact.includes("bot-game channel"));
}

// What message did they hit Discord's "reply" on? Without this, "his user"
// in a reply to someone else's message is an unresolvable pronoun. Returns
// null for normal messages, so the common path stays free of extra work.
async function resolveReplyTarget(message) {
  const referenceId = message.reference?.messageId;
  if (!referenceId) return null;
  // Cache first (free). Only hit the REST API when the cache missed, and only
  // once: fetchReference() already resolves the referenced message; fetching
  // the same id again via the channel adds a second identical call.
  let ref = message.channel?.messages?.cache?.get(referenceId) || null;
  try {
    if (!ref) ref = await message.fetchReference();
  } catch {
    ref = null; // the referenced message may be deleted or too old to fetch
  }
  if (ref?.author) {
    // mentions.repliedUser comes from the gateway event itself, so it is an
    // independent source: if it disagrees with the fetched author, refuse to
    // guess instead of naming the wrong person.
    const repliedUser = message.mentions?.repliedUser;
    if (repliedUser && repliedUser.id !== ref.author.id) {
      console.warn(`Reply author metadata disagrees with the message reference for message ${message.id}; refusing to guess.`);
      return null;
    }
    return {
      authorName: ref.member?.displayName || ref.author.globalName || ref.author.username || "someone",
      authorId: ref.author.id,
      isSelf: ref.author.id === client.user.id,
      content: renderDiscordMentions(ref.content || "", {
        users: ref.mentions?.users,
        roles: ref.mentions?.roles,
        channels: ref.mentions?.channels,
      }).replace(/\s+/g, " ").trim().slice(0, 200),
      ageMs: Math.max(0, message.createdTimestamp - (ref.createdTimestamp || message.createdTimestamp)),
    };
  }
  // Even if the message is gone, the reply mention still says who it was.
  const user = message.mentions?.repliedUser;
  if (!user) return null;
  const member = message.mentions?.members?.get(user.id);
  return {
    authorName: member?.displayName || user.globalName || user.displayName || user.username || "someone",
    authorId: user.id,
    isSelf: user.id === client.user.id,
    content: "",
    ageMs: 0,
  };
}

// Real human conversation per channel in a time window: human messages from
// memory.db (bot messages are never counted), minus game commands.
function realConversationCounts(sinceMs) {
  const rows = memoryDb.prepare(`
    SELECT channel_id, content FROM messages
    WHERE created_at >= ? AND is_bot = 0
  `).all(sinceMs);
  const counts = new Map();
  for (const row of rows) {
    if (isGameCommand(row.content)) continue;
    counts.set(row.channel_id, (counts.get(row.channel_id) || 0) + 1);
  }
  return counts;
}

// Channels she may open a conversation in: text channels she can send in, with
// at least three real human messages in the last 24 hours, and not a learned
// bot-game channel. Dead and game channels are left alone.
function activeConversationChannels() {
  const counts = realConversationCounts(Date.now() - 24 * 60 * 60_000);
  return client.channels.cache.filter((channel) =>
    channel.isTextBased() &&
    !channel.isDMBased?.() &&
    channel.permissionsFor(client.user)?.has("SendMessages") &&
    !isLearnedGameChannel(channel.id) &&
    (counts.get(channel.id) || 0) >= 3);
}

function rememberBotMessage(channelId, answer) {
  lastBotMessageAtByChannel.set(channelId, Date.now());
  const history = conversations.get(channelId) || [];
  conversations.set(channelId, addHistory(history, { role: "assistant", content: answer }));
  persistMemory();
}

// Log her own replies into the persistent memory so she remembers what she said.
function rememberOwnMessage(messageLike, answer) {
  if (!answer) return;
  const loggedId = logMessage(memoryDb, {
    channelId: messageLike.channel.id,
    authorId: client.user.id,
    authorName: client.user.username,
    username: client.user.username,
    content: answer,
    createdAt: Date.now(),
    guildId: messageLike.guild?.id || "",
    isBot: true,
  });
  jobs.enqueueEmbedding(loggedId, answer);
}

function rememberUserMessage(channelId, displayName, content) {
  const history = conversations.get(channelId) || [];
  const entry = { role: "user", content: `${displayName}: ${content}` };
  conversations.set(channelId, addHistory(history, entry));
  persistMemory();
}

function factsContext(channelId) {
  const facts = channelFacts.get(channelId) || [];
  return facts.length ? `Things explicitly remembered in this channel:\n${facts.map((fact) => `- ${fact}`).join("\n")}` : "";
}

// Recent human lines give "follow up on what people were talking about" openers
// something real to hook into. Bot output is never included.
function recentHumanLines(channelId, limit = 8) {
  const rows = memoryDb.prepare(`
    SELECT author_name, content FROM messages
    WHERE channel_id = ? AND is_bot = 0
    ORDER BY id DESC LIMIT ?
  `).all(channelId, limit).reverse();
  return rows.map((row) => `${row.author_name}: ${row.content}`).join("\n");
}

// Composed per message: a rotating opener angle (so openings stop feeling
// samey) plus the channel's recent human conversation as hook-in context.
function spontaneousPromptFor(channelId) {
  const opener = SPONTANEOUS_OPENERS[Math.floor(Math.random() * SPONTANEOUS_OPENERS.length)];
  const recent = recentHumanLines(channelId);
  const recentNote = recent
    ? `\nRecent human conversation in this channel (context only — never repeat it word for word):\n${recent}`
    : "";
  return `Start a brief, natural conversation in this Discord channel. ${opener} One short message only. Do not mention commands or that you are a bot.${recentNote}`;
}

async function sendSpontaneousMessage(channel) {
  const lastReply = spontaneousReplies.get(channel.id) || 0;
  if (Date.now() - lastReply < config.spontaneousCooldownMs) return;

  const prompt = spontaneousPromptFor(channel.id);
  let answer = await askAI({
    prompt,
    personality: config.personality,
    systemContext: renderAliveness(new Date(), lastSpokeAtRef.value),
  });
  answer = await dedupeAnswer(channel.id, prompt, answer, (nudged) =>
    askAI({
      prompt: nudged,
      personality: config.personality,
      systemContext: renderAliveness(new Date(), lastSpokeAtRef.value),
    }));
  await deliverReply({ channel, react: async () => {} }, answer, {
    lastSpokeAtRef,
    spontaneous: true,
  });
  spontaneousReplies.set(channel.id, Date.now());
  rememberBotMessage(channel.id, answer);
  rememberOwnMessage({ channel, guild: channel.guild }, answer);
}

function scheduleSpontaneousMessages() {
  const available = [...activeConversationChannels().values()];
  if (available.length) {
    const channel = available[Math.floor(Math.random() * available.length)];
    sendSpontaneousMessage(channel).catch((error) =>
      console.error("Spontaneous chat failed:", error));
  } else {
    console.log("No channels with real human activity in the last 24h; skipping spontaneous opener.");
  }
  setTimeout(scheduleSpontaneousMessages, randomDelay(20, 50));
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Prefix: ${config.prefix} | Model: ${config.aiModel}`);
  // Older databases logged her own messages before the is_bot flag existed;
  // mark them so they never count as human activity.
  memoryDb.prepare("UPDATE messages SET is_bot = 1 WHERE author_id = ?").run(readyClient.user.id);
  readyClient.application.commands.set([
    // Everyone
    { name: "help", description: "How to talk to her and everything she can do" },
    { name: "relationship", description: "How she feels about you", options: [{ name: "user", description: "Someone else (admins only)", type: 6, required: false }] },
    { name: "status", description: "Uptime, ping, and memory stats" },
    { name: "diary", description: "Read her latest diary entry" },
    // Admin only
    { name: "memory_stats", description: "Show persistent memory statistics" },
    { name: "memories", description: "Show remembered facts for a user", options: [{ name: "user", description: "Member to inspect", type: 6, required: true }] },
    { name: "forget_all", description: "Forget a user's facts", options: [{ name: "user", description: "Member to forget", type: 6, required: true }] },
    { name: "reflect_now", description: "Run a self-reflection immediately" },
    { name: "friends", description: "Her closest bonds and feelings overview" },
    { name: "forget_fact", description: "Remove one remembered fact for a user", options: [
      { name: "user", description: "Member to edit", type: 6, required: true },
      { name: "text", description: "Part of the fact to remove", type: 3, required: true },
    ] },
    { name: "reload_personality", description: "Re-read the personality file without a restart" },
  ]).catch((error) => console.error("Failed to register memory commands:", error));
  setTimeout(scheduleSpontaneousMessages, randomDelay(20, 50));
  // Warm the local embedding model so the first live reply is not slow.
  jobs.backgroundQueue.add(() => embedText("warmup")).catch(() => {});
  setInterval(() => jobs.backgroundQueue.add(() => jobs.reflect()), 7 * 24 * 60 * 60_000).unref();
  // Daily housekeeping: fact decay (once a day, not every 10 minutes) + nightly journal.
  setInterval(() => jobs.backgroundQueue.add(async () => {
    jobs.decay();
    decayStaleRomance();
    await jobs.writeJournal();
  }), 24 * 60 * 60_000).unref();
});

function isAdmin(interaction) {
  return config.adminUserIds.has(interaction.user.id);
}

// Commands everyone can use, vs. the admin-only maintenance set. Feelings of
// OTHER people (the /friends overview) stay admin-only: romance is personal.
const PUBLIC_COMMANDS = new Set(["help", "relationship", "status", "diary"]);
const ADMIN_COMMANDS = new Set([
  "memory_stats", "memories", "forget_all", "reflect_now",
  "friends", "forget_fact", "reload_personality",
]);

// Latest known display name for a Discord user id, from what she has seen.
function displayNameFor(userId) {
  return memoryDb.prepare(
    "SELECT author_name FROM messages WHERE author_id = ? ORDER BY id DESC LIMIT 1",
  ).get(userId)?.author_name || `<@${userId}>`;
}

function meterBar(value, max = 5, width = 10) {
  const ratio = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * width);
  return `${"■".repeat(filled)}${"─".repeat(width - filled)}`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function helpText(forAdmin) {
  const name = client.user.username;
  const adminLines = forAdmin
    ? [
      "",
      "**Admin only**",
      "- `/memories <user>` — everything she remembers about someone",
      "- `/forget_fact <user> <text>` — remove one wrong fact",
      "- `/forget_all <user>` — forget someone completely",
      "- `/friends` — her bonds overview",
      "- `/memory_stats`, `/reflect_now`, `/reload_personality` — maintenance",
    ]
    : [];
  return [
    `**How to talk to ${name}**`,
    `- Mention her, reply to her message, or just keep chatting — she keeps the thread for ${Math.round(config.convoEngageMs / 60_000)} minutes after she replies`,
    "- DMs are always welcome",
    `- \`${config.prefix} <question>\` — searches the web and answers with sources`,
    '- "remember this: ..." — she saves it for the channel',
    '- "forget everything" — clears this channel\'s memory',
    "",
    "**Commands**",
    "- `/relationship` — how she feels about you",
    "- `/diary` — her latest diary entry",
    "- `/status` — uptime, ping, and memory",
    "- `/help` — this list",
    ...adminLines,
    "",
    "Friendship grows just by talking. Anything deeper has to be earned.",
  ].join("\n");
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  if (!PUBLIC_COMMANDS.has(name) && !ADMIN_COMMANDS.has(name)) return;
  if (ADMIN_COMMANDS.has(name) && !isAdmin(interaction)) return;
  // Personal or maintenance output is only for the invoker; help/status/diary
  // are fine to leave visible so others can learn the commands.
  const ephemeral = name !== "help" && name !== "status" && name !== "diary";
  await interaction.deferReply({ ephemeral });
  const botName = client.user.username;

  if (name === "help") {
    await interaction.editReply(helpText(isAdmin(interaction)));
  } else if (name === "relationship") {
    // Non-admins can only ever look at themselves; admins may inspect anyone.
    const target = isAdmin(interaction)
      ? (interaction.options.getUser("user") ?? interaction.user)
      : interaction.user;
    const row = memoryDb.prepare(
      "SELECT affinity, romance, last_interacted FROM relationships WHERE user_id = ?",
    ).get(target.id);
    const targetName = target.id === interaction.user.id
      ? (interaction.member?.displayName || target.username)
      : target.displayName || target.username;
    if (!row || (row.affinity <= 0 && row.last_interacted <= 0)) {
      await interaction.editReply(
        `**${botName}** and **${targetName}** haven't really talked yet — say hi sometime!`,
      );
      return;
    }
    const summary = relationshipSummary(row);
    const lines = [
      `How **${botName}** feels about **${targetName}**:`,
      "",
      `**Friendship** — ${summary.friendLabel}`,
      `\`${meterBar(row.affinity)}\``,
    ];
    if (summary.romanceLabel) {
      lines.push(`**Romance** — she ${summary.romanceLabel}`);
      lines.push(`\`${meterBar(summary.effectiveRomance)}\``);
    } else {
      lines.push("**Romance** — just friends, nothing more");
    }
    if (summary.daysSinceTalk !== null && summary.daysSinceTalk >= 1) {
      lines.push("", `Last really talked: ${summary.daysSinceTalk === 1 ? "yesterday" : `${summary.daysSinceTalk} days ago`}`);
    }
    await interaction.editReply(lines.join("\n"));
  } else if (name === "status") {
    const messages = memoryDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
    const facts = memoryDb.prepare("SELECT COUNT(*) AS count FROM facts").get().count;
    const journal = memoryDb.prepare("SELECT COUNT(*) AS count FROM journal").get().count;
    const model = memoryDb.prepare("SELECT updated_at FROM self_model WHERE id = 1").get();
    const ping = client.ws.ping >= 0 ? `${Math.round(client.ws.ping)}ms` : "measuring…";
    const rss = process.memoryUsage().rss / 1024 / 1024;
    await interaction.editReply([
      `**${botName} status**`,
      `Uptime: ${formatUptime(process.uptime())} | Ping: ${ping}`,
      `Model: \`${config.aiModel}\``,
      `Memory: ${Math.round(rss)} MB RSS`,
      `Brain: ${messages} messages, ${facts} facts, ${journal} diary entries`,
      `Self-image refreshed ${Math.max(1, Math.round((Date.now() - model.updated_at) / 36e5))}h ago`,
    ].join("\n"));
  } else if (name === "diary") {
    const entry = memoryDb.prepare(
      "SELECT entry, created_at FROM journal ORDER BY created_at DESC LIMIT 1",
    ).get();
    if (!entry) {
      await interaction.editReply(
        `**${botName}** hasn't written in her diary yet — she does that at night, after a day worth remembering.`,
      );
      return;
    }
    const written = new Date(entry.created_at).toISOString().slice(0, 10);
    await interaction.editReply(`**${botName}'s diary — ${written}**\n\n${entry.entry}`);
  } else if (name === "memory_stats") {
    const messages = memoryDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
    const facts = memoryDb.prepare("SELECT COUNT(*) AS count FROM facts").get().count;
    const journal = memoryDb.prepare("SELECT COUNT(*) AS count FROM journal").get().count;
    const last = memoryDb.prepare("SELECT MAX(created_at) AS value FROM summaries").get().value;
    const model = memoryDb.prepare("SELECT updated_at FROM self_model WHERE id = 1").get();
    await interaction.editReply(`Messages: ${messages}\nFacts: ${facts}\nJournal entries: ${journal}\nLast consolidation: ${last ? new Date(last).toISOString() : "never"}\nSelf-model age: ${Math.round((Date.now() - model.updated_at) / 36e5)} hours`);
  } else if (name === "memories") {
    const user = interaction.options.getUser("user");
    const rows = memoryDb.prepare(`
      SELECT fact FROM facts WHERE subject = ? ORDER BY hits DESC, last_seen DESC LIMIT 20
    `).all(`user:${user.id}`);
    await interaction.editReply(rows.length ? rows.map(({ fact }) => `- ${fact}`).join("\n") : "No memories for that user.");
  } else if (name === "forget_all") {
    const user = interaction.options.getUser("user");
    memoryDb.prepare("DELETE FROM facts WHERE subject = ?").run(`user:${user.id}`);
    // Forgetting someone means the feelings too — the admin's escape hatch
    // against griefing the romance meter.
    memoryDb.prepare("DELETE FROM relationships WHERE user_id = ?").run(user.id);
    await interaction.editReply(`Forgot facts and feelings for ${user.username}.`);
  } else if (name === "friends") {
    const friends = memoryDb.prepare(`
      SELECT user_id, affinity, romance FROM relationships
      WHERE affinity > 0 ORDER BY affinity DESC LIMIT 10
    `).all();
    const crushes = memoryDb.prepare(`
      SELECT user_id, affinity, romance FROM relationships
      WHERE romance > 0 ORDER BY romance DESC LIMIT 10
    `).all();
    const friendLines = friends.map((row) => {
      const summary = relationshipSummary(row);
      const crush = summary.romanceLabel ? ` (and she ${summary.romanceLabel.replace("you", "them")})` : "";
      return `- ${displayNameFor(row.user_id)} — ${summary.friendLabel}${crush}`;
    });
    const crushLines = crushes.map((row) => {
      const summary = relationshipSummary(row);
      return `- ${displayNameFor(row.user_id)} — she ${summary.romanceLabel.replace("you", "them")}`;
    });
    await interaction.editReply([
      `**${botName}'s bonds**`,
      "",
      "**Closest friends**",
      friendLines.length ? friendLines.join("\n") : "Nobody yet — go talk to her!",
      "",
      "**Feelings**",
      crushLines.length ? crushLines.join("\n") : "No romance brewing.",
    ].join("\n"));
  } else if (name === "forget_fact") {
    const user = interaction.options.getUser("user");
    const text = interaction.options.getString("text");
    const removed = forgetFacts(memoryDb, `user:${user.id}`, text);
    if (!removed.length) {
      await interaction.editReply(`No facts about ${user.username} match "${text.slice(0, 80)}".`);
      return;
    }
    const shown = removed.slice(0, 5).map((fact) => `- ${fact}`);
    const more = removed.length > 5 ? `\n…and ${removed.length - 5} more` : "";
    await interaction.editReply(`Removed ${removed.length} fact${removed.length === 1 ? "" : "s"} about ${user.username}:\n${shown.join("\n")}${more}`);
  } else if (name === "reload_personality") {
    try {
      const fresh = readFileSync(config.personalityPath, "utf8").trim();
      if (!fresh) throw new Error("the file is empty");
      config.personality = fresh;
      await interaction.editReply(`Personality reloaded from \`${config.personalityPath}\` (${fresh.length} characters). No restart needed.`);
    } catch (error) {
      await interaction.editReply(`Reload failed (${error.message}) — keeping the current personality.`);
    }
  } else if (name === "reflect_now") {
    await jobs.backgroundQueue.add(() => jobs.reflect());
    await interaction.editReply("Self-reflection completed.");
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    botActivityByChannel.set(message.channel.id, (botActivityByChannel.get(message.channel.id) || 0) + 1);
    // Log other bots' messages (truncated, never in learned game channels) so
    // she knows who TEST./OwO/Karuta are when someone asks "who is dis?".
    // No embeddings: game-bot spam would burn CPU for zero recall value.
    if (!isLearnedGameChannel(message.channel.id) && message.content) {
      logMessage(memoryDb, {
        channelId: message.channel.id,
        authorId: message.author.id,
        authorName: message.author.displayName || message.author.username,
        username: message.author.username,
        content: message.content.replace(/\s+/g, " ").trim().slice(0, 200),
        createdAt: message.createdTimestamp,
        guildId: message.guild?.id || "",
        isBot: true,
      });
    }
    return;
  }

  // Game commands (Karuta/OwO/Dank-style) never count as conversation; they
  // also drive the bot-game channel learning below.
  const gameCommand = isGameCommand(message.content);
  if (gameCommand) {
    const count = (botCommandCountByChannel.get(message.channel.id) || 0) + 1;
    botCommandCountByChannel.set(message.channel.id, count);
    if (count >= 5 && (botActivityByChannel.get(message.channel.id) || 0) >= 5) {
      const facts = channelFacts.get(message.channel.id) || [];
      const fact = "This is a bot-game channel, probably Karuta: people repeatedly send short game commands and bots repeatedly reply with drops, cards, or command results.";
      if (!facts.includes(fact)) {
        channelFacts.set(message.channel.id, addFact(facts, fact));
        persistMemory();
      }
    }
  }

  // Render Discord markup into readable text before the model or her memory
  // ever sees it: <@123> becomes @Display name, <#456> becomes #channel.
  const mentionLookups = {
    users: message.mentions.users,
    roles: message.mentions.roles,
    channels: message.mentions.channels,
  };
  const renderedContent = renderDiscordMentions(message.content, mentionLookups);

  const loggedId = logMessage(memoryDb, {
    channelId: message.channel.id,
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.username,
    username: message.author.username,
    content: renderedContent,
    createdAt: message.createdTimestamp,
    guildId: message.guild?.id || "",
  });
  jobs.enqueueEmbedding(loggedId, renderedContent);
  const pending = (pendingByChannel.get(message.channel.id) || 0) + 1;
  pendingByChannel.set(message.channel.id, pending);
  if (pending >= 100) {
    pendingByChannel.set(message.channel.id, 0);
    jobs.backgroundQueue.add(() => jobs.consolidate(message.channel.id));
  }

  const displayName = message.member?.displayName || message.author.username;
  rememberUserMessage(message.channel.id, displayName, renderedContent);

  // Decide what this message is BEFORE any async work, so stray replies in
  // game channels never trigger Discord API calls just to resolve targets.
  const mentioned = message.mentions.has(client.user);
  const inDm = message.channel.isDMBased?.() === true;
  const heuristicAddressed = isAddressedToBot(renderedContent, {
    botUsername: client.user.username,
    recentBotMessage: Date.now() - (lastBotMessageAtByChannel.get(message.channel.id) || 0) <= 5 * 60_000,
  });
  // A Discord reply aimed at another bot is a command for that bot, not a
  // continuation of a conversation with her. mentions.repliedUser is free
  // gateway data — no REST call needed to know this.
  const repliedUser = message.mentions?.repliedUser;
  const replyingToAnotherBot = !mentioned
    && Boolean(repliedUser?.bot)
    && repliedUser.id !== client.user.id;
  // In a DM, every message is talking to her.
  const engaged = inDm || (!gameCommand && !replyingToAnotherBot && !isLearnedGameChannel(message.channel.id)
    ? isEngaged(message.channel.id, message.author.id)
    : false);
  const command = parseCommand(message.content, config.prefix);
  const needsReplyTarget = shouldResolveReplyTarget({
    hasReference: Boolean(message.reference?.messageId),
    mentioned,
    addressed: heuristicAddressed,
    engaged,
    isCommand: command !== null,
  });
  const replyTarget = needsReplyTarget ? await resolveReplyTarget(message) : null;
  // A reply aimed at her (even with the ping toggled off) is always for her.
  const replyingToMe = replyTarget?.isSelf === true;
  const addressed = mentioned || replyingToMe || engaged || inDm || heuristicAddressed;
  // Romance only grows from intimacy in messages aimed at her — never from
  // commands or game traffic.
  if (addressed && !command && !gameCommand) {
    const intimacy = detectIntimacy(renderedContent);
    if (intimacy) updateRomance(message.author.id, intimacy);
  }
  if (!addressed && command === null) {
    const lastReply = spontaneousReplies.get(message.channel.id) || 0;
    const canReply = Date.now() - lastReply >= config.spontaneousCooldownMs;
    if (!canReply || message.content.length < 8 || Math.random() >= config.spontaneousChance) return;
    if (isGameCommand(message.content) || isLearnedGameChannel(message.channel.id)) return;

    await message.channel.sendTyping();
    try {
      // The roll already fired, so one lazy fetch is fine: restore the
      // reply-context note for chime-ins without paying for it on every roll.
      let noteTarget = replyTarget;
      if (!noteTarget && message.reference?.messageId) {
        noteTarget = await resolveReplyTarget(message);
      }
      const replyNote = noteTarget
        ? ` They sent it as a Discord reply to ${noteTarget.isSelf ? "your earlier message" : `${noteTarget.authorName}'s message${noteTarget.content ? ` ("${noteTarget.content}")` : ""}`}.`
        : "";
      const chimePrompt = `Someone in Discord said: "${renderedContent}".${replyNote} React naturally, only if there is a reason to join in. If you would add nothing useful, answer exactly: NO_REPLY.`;
      let answer = await askAI({
        prompt: chimePrompt,
        personality: config.personality,
        systemContext: renderAliveness(new Date(), lastSpokeAtRef.value),
      });
      answer = await dedupeAnswer(message.channel.id, chimePrompt, answer, (nudged) =>
        askAI({
          prompt: nudged,
          personality: config.personality,
          systemContext: renderAliveness(new Date(), lastSpokeAtRef.value),
        }));
      if (!/^no[_\s-]?reply$/i.test(answer.trim())) {
        await deliverReply(message, answer, { lastSpokeAtRef });
        updateAffinity(message.author.id);
        markEngaged(message.channel.id, message.author.id);
        spontaneousReplies.set(message.channel.id, Date.now());
        rememberBotMessage(message.channel.id, answer);
        rememberOwnMessage(message, answer);
      }
    } catch (error) {
      console.error("Unprompted reply failed:", error);
    }
    return;
  }

  const stripped = message.content
    .replaceAll(`<@${client.user.id}>`, "")
    .replaceAll(`<@!${client.user.id}>`, "");
  const prompt = command !== null
    ? renderDiscordMentions(command, mentionLookups).trim()
    : renderDiscordMentions(stripped, mentionLookups).trim();
  if (!prompt) {
    await message.reply("Hey! What do you want to talk about?");
    return;
  }

  await message.channel.sendTyping();
  try {
    let answer;
    if (isReplyIdentityQuestion(prompt)) {
      // Deterministic: built only from the verified reply target, so she can
      // never name the wrong bot. Never hardcode her own name — use the
      // live username so renaming the bot cannot make her lie.
      answer = pickIdentityAnswer(replyTarget, client.user.username);
      await deliverReply(message, answer, { lastSpokeAtRef });
      updateAffinity(message.author.id);
      markEngaged(message.channel.id, message.author.id);
      rememberBotMessage(message.channel.id, answer);
      rememberOwnMessage(message, answer);
      return;
    }
    let delivered = false;
    const rememberedFact = !command ? parseRememberCommand(prompt) : null;
    if (rememberedFact) {
      const facts = channelFacts.get(message.channel.id) || [];
      channelFacts.set(message.channel.id, addFact(facts, rememberedFact));
      persistMemory();
      answer = `Got it, I'll remember this in this channel: ${rememberedFact}`;
    } else if (!command && /^(forget everything|clear memory)$/i.test(prompt)) {
      conversations.delete(message.channel.id);
      channelFacts.delete(message.channel.id);
      persistMemory();
      answer = "Channel memory cleared.";
    } else if (command !== null) {
      const results = await searchWeb(prompt);
      const context = results.length
        ? `Use these current search results as supporting information. Include a source link when useful:\n${results
          .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}\n${result.url}`)
          .join("\n\n")}`
        : "No useful search result was found. Answer from reliable general knowledge and be clear that the web search returned no match.";
      answer = await askAI({
        prompt,
        personality: config.personality,
        systemContext: `${renderAliveness(new Date(), lastSpokeAtRef.value)}\n${context}`,
      });
    } else {
      // Memory-rich chat reply: hybrid retrieval + streamed delivery.
      const factsContextText = factsContext(message.channel.id);
      const deepRecall = /\b(remember|that time|back when|used to|last week|yesterday|earlier)\b/i.test(prompt);
      let embedVector = null;
      try {
        embedVector = await embedText(prompt);
      } catch {
        // FTS-only retrieval still works if the local embedder fails.
      }
      const persistentContext = buildContext(memoryDb, {
        message: {
          channelId: message.channel.id,
          authorId: message.author.id,
          authorName: displayName,
          content: prompt,
          guildId: message.guild?.id || "",
          activeConvo: engaged || replyingToMe,
        },
        embedVector,
        deepRecall,
        personalityPath: config.personalityPath,
        botId: client.user.id,
        replyTo: replyTarget,
        memoryContextTokens: config.memoryContextTokens,
      });
      const messages = [
        {
          role: "system",
          content: [
            `Your personality: ${config.personality}`,
            "Reply conversationally and naturally, like chatting with a friend on Discord.",
            "Use Discord-friendly formatting and keep replies concise.",
            renderAliveness(new Date(), lastSpokeAtRef.value),
            factsContextText,
            persistentContext.memoryBlock,
          ].filter(Boolean).join("\n"),
        },
        { role: "user", content: prompt },
      ];
      const lastOwnReply = lastAssistantReply(message.channel.id);
      answer = await deliverStreamedReply(message, (onDelta) => streamReply({ messages, onDelta }), {
        lastSpokeAtRef,
        // If the stream produced a verbatim repeat of what she just said in
        // this channel, regenerate once and swap it in before anyone reads it.
        dupCheck: lastOwnReply ? async (streamedText) => {
          if (!isDuplicateReply(streamedText, lastOwnReply)) return null;
          const retry = await completeAI({
            messages: [...messages.slice(0, -1), { role: "user", content: dupNudge(prompt, lastOwnReply) }],
            thinking: false,
            maxTokens: 512,
          });
          return isDuplicateReply(retry, lastOwnReply) ? null : retry;
        } : undefined,
      });
      delivered = true;
    }
    if (!answer) return;
    if (!delivered) await deliverReply(message, answer, { lastSpokeAtRef });
    updateAffinity(message.author.id);
    markEngaged(message.channel.id, message.author.id);
    rememberBotMessage(message.channel.id, answer);
    rememberOwnMessage(message, answer);
  } catch (error) {
    console.error(error);
    await message.reply("My brain tripped for a second. Please try again.");
  }
});

client.login(config.discordToken);
