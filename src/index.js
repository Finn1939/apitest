import "dotenv/config";
import { Client, Events, GatewayIntentBits, Options, Partials } from "discord.js";
import { config, validateConfig } from "./config.js";
import { parseCommand } from "./commands.js";
import { askAI } from "./ai.js";
import { searchWeb } from "./search.js";
import {
  addFact,
  addHistory,
  loadMemory,
  parseRememberCommand,
  saveMemory,
  buildContext,
  logMessage,
} from "./memory.js";
import { createMemoryDb } from "./db.js";
import { createJobs, embedText } from "./jobs.js";
import { streamReply } from "./llm.js";
import { deliverReply, deliverStreamedReply, renderAliveness } from "./aliveness.js";
import { renderDiscordMentions } from "./render.js";
import { isAddressedToBot, isReplyIdentityQuestion, pickIdentityAnswer, shouldResolveReplyTarget } from "./replies.js";

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

// Short bot-game commands (Karuta etc.) that should never count as conversation.
const GAME_COMMAND_RE = /^(?:k(?:d|l|g|c|u|i|q|t|v|w|m|a)?|dk|grab|drop|burn|daily|vote|inv(?:entory)?|collection|wishlist|worker|observe)$/;

function isGameCommand(content) {
  return GAME_COMMAND_RE.test(content.trim().toLowerCase().replace(/[.!]+$/, ""));
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

async function sendSpontaneousMessage(channel) {
  const lastReply = spontaneousReplies.get(channel.id) || 0;
  if (Date.now() - lastReply < config.spontaneousCooldownMs) return;

  const answer = await askAI({
    prompt: "Start a brief, natural conversation in this Discord channel. Say one short thing, react to the general mood, or ask a light question. Do not mention commands or that you are a bot.",
    personality: config.personality,
    systemContext: renderAliveness(new Date(), lastSpokeAtRef.value),
  });
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
    { name: "memory_stats", description: "Show persistent memory statistics" },
    { name: "memories", description: "Show remembered facts for a user", options: [{ name: "user", description: "Member to inspect", type: 6, required: true }] },
    { name: "forget_all", description: "Forget a user's facts", options: [{ name: "user", description: "Member to forget", type: 6, required: true }] },
    { name: "reflect_now", description: "Run a self-reflection immediately" },
  ]).catch((error) => console.error("Failed to register memory commands:", error));
  setTimeout(scheduleSpontaneousMessages, randomDelay(20, 50));
  // Warm the local embedding model so the first live reply is not slow.
  jobs.backgroundQueue.add(() => embedText("warmup")).catch(() => {});
  setInterval(() => jobs.backgroundQueue.add(() => jobs.reflect()), 7 * 24 * 60 * 60_000).unref();
  // Daily housekeeping: fact decay (once a day, not every 10 minutes) + nightly journal.
  setInterval(() => jobs.backgroundQueue.add(async () => {
    jobs.decay();
    await jobs.writeJournal();
  }), 24 * 60 * 60_000).unref();
});

function isAdmin(interaction) {
  return config.adminUserIds.has(interaction.user.id);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !isAdmin(interaction)) return;
  if (!["memory_stats", "memories", "forget_all", "reflect_now"].includes(interaction.commandName)) return;
  await interaction.deferReply({ ephemeral: true });
  if (interaction.commandName === "memory_stats") {
    const messages = memoryDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
    const facts = memoryDb.prepare("SELECT COUNT(*) AS count FROM facts").get().count;
    const journal = memoryDb.prepare("SELECT COUNT(*) AS count FROM journal").get().count;
    const last = memoryDb.prepare("SELECT MAX(created_at) AS value FROM summaries").get().value;
    const model = memoryDb.prepare("SELECT updated_at FROM self_model WHERE id = 1").get();
    await interaction.editReply(`Messages: ${messages}\nFacts: ${facts}\nJournal entries: ${journal}\nLast consolidation: ${last ? new Date(last).toISOString() : "never"}\nSelf-model age: ${Math.round((Date.now() - model.updated_at) / 36e5)} hours`);
  } else if (interaction.commandName === "memories") {
    const user = interaction.options.getUser("user");
    const rows = memoryDb.prepare(`
      SELECT fact FROM facts WHERE subject = ? ORDER BY hits DESC, last_seen DESC LIMIT 20
    `).all(`user:${user.id}`);
    await interaction.editReply(rows.length ? rows.map(({ fact }) => `- ${fact}`).join("\n") : "No memories for that user.");
  } else if (interaction.commandName === "forget_all") {
    const user = interaction.options.getUser("user");
    memoryDb.prepare("DELETE FROM facts WHERE subject = ?").run(`user:${user.id}`);
    await interaction.editReply(`Forgot facts for ${user.username}.`);
  } else {
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

  const karutaCommand = isGameCommand(message.content);
  if (karutaCommand) {
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
  // In a DM, every message is talking to her.
  const engaged = !inDm && !karutaCommand
    ? isEngaged(message.channel.id, message.author.id)
    : inDm;
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
      const answer = await askAI({
        prompt: `Someone in Discord said: "${renderedContent}".${replyNote} React naturally, only if there is a reason to join in. If you would add nothing useful, answer exactly: NO_REPLY.`,
        personality: config.personality,
        systemContext: renderAliveness(new Date(), lastSpokeAtRef.value),
      });
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
      answer = await deliverStreamedReply(message, (onDelta) => streamReply({ messages, onDelta }), {
        lastSpokeAtRef,
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
