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
  softDeleteMessageByDiscordId,
  updateMessageContentByDiscordId,
} from "./memory.js";
import { createMemoryDb } from "./db.js";
import { createJobs, embedText } from "./jobs.js";
import { streamReply } from "./llm.js";
import { deliverReply, deliverStreamedReply, renderAliveness } from "./aliveness.js";
import { renderChannelSnapshot, renderDiscordMentions, renderEmbeds, renderButtons, renderMediaExtras, visionUserContent } from "./render.js";
import { createAnalyst } from "./analysis.js";
import { detectIntimacy, formatReactionSummary, isAddressedToBot, isDuplicateReply, isGameCommand, isPointingAtBot, isReplyIdentityQuestion, learnedGameCommands, pickIdentityAnswer, shouldResolveReplyTarget, SPONTANEOUS_OPENERS } from "./replies.js";

validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    // Reactions are how people answer her without typing; edits and deletes are
    // how conversations get revised. Seeing them all is part of "being there".
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
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

// The last time another bot (OwO, Karuta, a music bot) spoke in a channel —
// the freshness signal for the live channel snapshot: if a bot panel just
// landed, her reply should see it even in a channel that is not a learned
// game one yet.
const otherBotMessageAtByChannel = new Map();

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
// AI judgment layer: reaction meanings, game-channel spectating, command
// learning. Shares the key pool with replies but with its own tight budget;
// every failure falls back to the deterministic rules that ran before it.
const analyst = createAnalyst({
  completeAI,
  maxPerMinute: config.analysisMaxPerMinute,
  persona: config.personality.slice(0, 800),
});
for (const { command } of memoryDb.prepare("SELECT command FROM learned_commands").all()) {
  learnedGameCommands.add(command);
}
let pendingByChannel = new Map();
const lastSpokeAtRef = { value: Date.now() };

setInterval(() => {
  console.log(`RSS: ${process.memoryUsage().rss} bytes`);
}, 10 * 60_000).unref();

function persistMemory() {
  saveMemory(conversations, channelFacts);
}

// --- Vision -------------------------------------------------------------------
// The model is vision-language capable, so when someone sends her an image
// while talking to her, she actually looks at it. sharp (bundled with the
// transformers dependency) downscales photos to a small JPEG — a 4 MB phone
// photo becomes ~150 KB, keeping payloads tiny and memory flat. If sharp is
// unavailable, only small originals pass through.
let sharpModule = null;
try {
  sharpModule = (await import("sharp")).default;
} catch {
  // Optional: text and metadata still work without vision downscaling.
}

const VISION_MAX_IMAGES = 2;
const VISION_MAX_BYTES = 8 * 1024 * 1024;

async function toDataUrl(buffer, contentType) {
  if (sharpModule) {
    const out = await sharpModule(buffer)
      .rotate() // respect EXIF orientation
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  }
  if (buffer.length <= 2 * 1024 * 1024) {
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  }
  return null;
}

// Only images from people actually talking to her are fetched — never from
// bot spam, never from passive channel traffic. Same request count as a
// normal reply; the images ride along inside it.
async function collectVisionImages(message) {
  const images = [];
  for (const attachment of message.attachments.values()) {
    if (images.length >= VISION_MAX_IMAGES) break;
    const type = String(attachment.contentType || "");
    if (!type.startsWith("image/")) continue;
    if (attachment.size > VISION_MAX_BYTES) continue;
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const dataUrl = await toDataUrl(Buffer.from(await response.arrayBuffer()), type);
      if (dataUrl) images.push(dataUrl);
    } catch (error) {
      console.warn("Could not load an image for vision:", error.message);
    }
  }
  return images;
}

// --- Reactions on her messages ------------------------------------------------
// Reaction events carry only ids, so her recent sent messages are tracked
// (capped) — matching reactions to her needs zero API calls. The stored meta
// keeps the message text (what the reaction landed on — needed to interpret
// it) and the Message object itself (so she can mirror an emoji back onto it).
const sentMessageMetaById = new Map();
function trackSentMessage(message, content = "") {
  if (!message?.id) return;
  sentMessageMetaById.set(message.id, {
    channelId: message.channel?.id || "",
    content: String(content || "").slice(0, 280),
    message,
  });
  if (sentMessageMetaById.size > 60) {
    for (const oldest of sentMessageMetaById.keys()) { sentMessageMetaById.delete(oldest); break; } // Map keeps insertion order
  }
}

// Streamed replies are tracked the moment they exist, but their real text
// arrives later — fill it in once the stream has finished.
function noteSentMessageContent(messageId, content) {
  const meta = sentMessageMetaById.get(messageId);
  if (meta) meta.content = String(content || "").slice(0, 280);
}

// Ephemeral social signals: reactions she received in the last 30 minutes.
// Not database rows — reactions are feelings of the moment, not history.
// Each record gains a `meaning` once the judgment layer interprets it, which
// then shows up in her reply context ("❤️ from Ren — flirty teasing").
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
  const list = (reactionsByChannel.get(channelId) || [])
    .filter((entry) => Date.now() - entry.at < 30 * 60_000);
  return list.length ? formatReactionSummary(list) : null;
}

// --- AI reaction interpretation ---------------------------------------------
// Instead of a flat "heart = +0.4", reactions queue per channel and are
// interpreted in ONE batched judgment call: a heart on her flirty joke lands
// differently than a heart on homework help. Any failure (budget spent, API
// down, bad JSON) falls back to the old flat rule, so this can never make
// her dumber — only smarter on average.
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

// The pre-analysis rule, kept verbatim as the fallback path.
function fallbackHeartRule(entries) {
  for (const entry of entries) {
    if (HEART_REACT_RE.test(entry.emoji)) {
      updateRomance(entry.userId, { weight: 0.4, signal: `react:${entry.emoji}` });
    }
  }
}

// She mirrors one emoji back onto her own message — at most once per message,
// so a pile of hearts cannot stack five emoji onto it.
function mirrorReaction(messageId, emoji) {
  if (mirroredReactionMessageIds.has(messageId)) return;
  const meta = sentMessageMetaById.get(messageId);
  mirroredReactionMessageIds.add(messageId);
  if (mirroredReactionMessageIds.size > 40) {
    for (const oldest of mirroredReactionMessageIds.keys()) { mirroredReactionMessageIds.delete(oldest); break; }
  }
  if (meta?.message?.react) {
    meta.message.react(emoji).catch(() => { /* mirroring is best-effort */ });
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
    // Group the batch by which of her messages was reacted to, so the
    // judgment sees the text the reaction landed on.
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
    const peopleNotes = bondsNotesFor(batch.map((entry) => entry.userId));
    const results = await analyst.interpretReactions({
      groups: [...groups.values()],
      contextLines: recentHumanLines(channelId, 6),
      peopleNotes,
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
      // The meaning becomes part of her live context for the next half hour.
      if (entry.recordRef) entry.recordRef.meaning = result.meaning;
      if (result.romanceWeight > 0) {
        // The AI's weight replaces the flat 0.4; the daily budget, per-signal
        // dedup and deep-growth slowdown all still apply.
        updateRomance(entry.userId, { weight: result.romanceWeight, signal: `react:${entry.emoji}` });
      }
      if (result.reactBack && result.reactEmoji) mirrorReaction(entry.messageId, result.reactEmoji);
      // What the moment meant becomes a durable fact — the diary and future
      // replies remember WHY the heart felt nice, not just that it happened.
      const noteText = result.note || (result.meaning ? `Reacted ${entry.emoji} — ${result.meaning}` : "");
      if (noteText && result.romanceWeight >= 0.3 && !notedUsers.has(entry.userId)) {
        notedUsers.add(entry.userId);
        const subject = `user:${entry.userId}`;
        const existing = memoryDb.prepare("SELECT id FROM facts WHERE subject = ? AND fact = ?").get(subject, noteText);
        if (!existing) {
          const now = Date.now();
          memoryDb.prepare(
            "INSERT INTO facts(subject, fact, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)",
          ).run(subject, noteText, 0.7, now, now);
        }
      }
    }
  } catch (error) {
    console.warn("Reaction analysis failed:", error.message);
    fallbackHeartRule(batch);
  }
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
    // The referenced message may be a bot panel whose content is empty — the
    // game state is all in embeds/buttons. Render those so replying "here" to
    // an OwO panel shows her the actual card and choices.
    const refPanel = [renderEmbeds(ref.embeds), renderButtons(ref.components)].filter(Boolean).join(" ");
    const refText = renderDiscordMentions(ref.content || "", {
      users: ref.mentions?.users,
      roles: ref.mentions?.roles,
      channels: ref.mentions?.channels,
    });
    return {
      authorName: ref.member?.displayName || ref.author.globalName || ref.author.username || "someone",
      authorId: ref.author.id,
      isSelf: ref.author.id === client.user.id,
      content: `${refText}${refPanel ? ` ${refPanel}` : ""}`.replace(/\s+/g, " ").trim().slice(0, 320),
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

// Recent lines from everyone — humans AND bots, labels included. This is the
// spectator's view of a game channel: commands, panels, results in order.
function recentChannelLines(channelId, limit = 8) {
  const rows = memoryDb.prepare(`
    SELECT author_name, content, is_bot FROM messages
    WHERE channel_id = ? ORDER BY id DESC LIMIT ?
  `).all(channelId, limit).reverse();
  return rows.map((row) => row.is_bot ? `${row.author_name} [bot]: ${row.content}` : `${row.author_name}: ${row.content}`).join("\n");
}

// One line per person describing her bond with them — the compact form
// judgment prompts understand ("Ren: friendship — close friends; romance — …").
function bondsNotesFor(userIds) {
  return [...new Set(userIds)].filter(Boolean).map((userId) => {
    const row = memoryDb.prepare(
      "SELECT affinity, romance, last_interacted FROM relationships WHERE user_id = ?",
    ).get(userId);
    const name = displayNameFor(userId);
    if (!row) return `- ${name}: no bond yet`;
    const summary = relationshipSummary(row);
    const romanceBit = summary.romanceLabel ? `; romance — she ${summary.romanceLabel.replace("you", "them")}` : "";
    return `- ${name}: friendship — ${summary.friendLabel}${romanceBit}`;
  }).join("\n");
}

// The people behind a channel's recent human chatter, most recent first —
// whose bonds to include in a judgment prompt.
function recentSpeakers(channelId, limit = 5) {
  return memoryDb.prepare(`
    SELECT author_id FROM (
      SELECT author_id, MAX(id) AS last_id FROM messages
      WHERE channel_id = ? AND is_bot = 0 GROUP BY author_id
      ORDER BY last_id DESC LIMIT ?
    )
  `).all(channelId, limit).map((row) => row.author_id);
}

// --- AI chime-in judgment -----------------------------------------------------
// Both spontaneous paths used to fire on chance alone: the in-flow one asked
// the full reply model with almost no context (one quoted message), the idle
// one always sent a rotating opener. Now, when the roll hits, the judgment
// module first decides whether the moment is worth joining and writes the
// line — seeing the recent rendered conversation, her bonds with the
// speakers, and the time of day. A failed or budgetless judgment falls back
// to the old behavior: she is never quieter because the layer is down, only
// smarter when it is up.

// Cheap anti-repeat: if the judgment's line already appears nearly verbatim
// in the recent channel lines, she stays silent rather than echo herself.
function isRepeatOfRecent(line, lines) {
  const head = String(line || "").slice(0, 40).trim().toLowerCase();
  if (!head) return true;
  return String(lines || "").toLowerCase().includes(head);
}

async function judgeChimeInFor(channel, occasion, referenceId) {
  // Learned game channels log no bot traffic, so the persistent lines the
  // judgment would read hold no panels — take one live look instead, or it
  // would weigh a moment it cannot see.
  let lines = recentChannelLines(channel.id, 8);
  if (isLearnedGameChannel(channel.id) && !channel.isDMBased?.()) {
    const live = await fetchLiveChannelLines(channel, referenceId);
    if (live) lines = live;
  }
  const verdict = await analyst.judgeChimeIn({
    channelLabel: channel.name || "chat",
    lines,
    peopleNotes: bondsNotesFor(recentSpeakers(channel.id)),
    worldNote: renderAliveness(new Date(), lastSpokeAtRef.value),
    occasion,
  });
  return { verdict, lines };
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

  // Claim the slot up front: while the judgment is in flight (or after she
  // decides to stay quiet) the timer must not re-roll her.
  spontaneousReplies.set(channel.id, Date.now());

  if (config.analysisEnabled) {
    try {
      const { verdict, lines } = await judgeChimeInFor(
        channel, "the channel has gone quiet and she is considering starting something");
      if (verdict) {
        if (!verdict.speak || !verdict.line || isRepeatOfRecent(verdict.line, lines)) return;
        await deliverReply({ channel, react: async () => {} }, verdict.line, {
          lastSpokeAtRef,
          spontaneous: true,
          onSent: (sent) => trackSentMessage(sent, verdict.line),
        });
        rememberBotMessage(channel.id, verdict.line);
        rememberOwnMessage({ channel, guild: channel.guild }, verdict.line);
        return;
      }
      // No verdict (budget spent, API down, bad JSON): fall through to the
      // classic opener below — never quieter than before.
    } catch (error) {
      console.warn("Chime-in judgment failed:", error.message);
    }
  }

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
    onSent: (sent) => trackSentMessage(sent, answer),
  });
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
    const analysis = analyst.stats;
    await interaction.editReply([
      `**${botName} status**`,
      `Uptime: ${formatUptime(process.uptime())} | Ping: ${ping}`,
      `Model: \`${config.aiModel}\``,
      `Memory: ${Math.round(rss)} MB RSS`,
      `Brain: ${messages} messages, ${facts} facts, ${journal} diary entries`,
      `Analysis: ${analysis.calls} AI judgments, ${analysis.fallbacks} fell back to rules`,
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

// --- Edits, deletes, reactions: witnessing the whole conversation ----------

// A message was edited: her stored copy becomes the CURRENT text (marked), so
// she never quotes a version the author already fixed. Bot panels (OwO's
// HighLow card changes) are updated too, outside learned game channels.
client.on(Events.MessageUpdate, async (_oldMessage, incoming) => {
  try {
    if (!incoming?.id) return;
    let edited = incoming;
    if (edited.partial) {
      edited = await edited.fetch().catch(() => null);
      if (!edited) return;
    }
    const authorId = edited.author?.id;
    if (authorId === client.user.id) return; // her own edits are none
    const isOtherBot = edited.author?.bot;
    if (isOtherBot && isLearnedGameChannel(edited.channel?.id)) return;
    const mentionLookups = {
      users: edited.mentions?.users,
      roles: edited.mentions?.roles,
      channels: edited.mentions?.channels,
    };
    const panelText = isOtherBot
      ? [renderEmbeds(edited.embeds), renderButtons(edited.components)].filter(Boolean).join(" ")
      : "";
    const text = [
      renderDiscordMentions(edited.content || "", mentionLookups),
      panelText,
      isOtherBot ? "" : renderMediaExtras(edited),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    // Game panels churn silently; human edits carry the (edited) marker — the
    // same way Discord shows it — so she can tease "saw you edit that, nya".
    updateMessageContentByDiscordId(memoryDb, edited.id,
      `${text.slice(0, 400)}${isOtherBot ? "" : " (edited)"}`);
  } catch (error) {
    console.warn("Edit tracking failed:", error.message);
  }
});

// A message was deleted: never erase what she saw — mark it instead.
client.on(Events.MessageDelete, (message) => {
  try {
    softDeleteMessageByDiscordId(memoryDb, message?.id);
  } catch {
    // Best-effort; a failed marker costs nothing.
  }
});

client.on(Events.MessageDeleteBulk, (messages) => {
  try {
    for (const message of messages.values()) {
      softDeleteMessageByDiscordId(memoryDb, message?.id);
    }
  } catch {
    // Best-effort.
  }
});

// Someone reacted to one of her messages: she notices. Reactions queue up for
// a batched AI interpretation — what the emoji really meant here, how much
// romance (if any) it carries, whether to mirror an emoji back. Analysis
// disabled or unavailable: hearts fall back to the old flat rule.
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (!user || user.id === client.user.id) return;
    const message = reaction?.message;
    const channelId = message?.channelId;
    if (!channelId || !sentMessageMetaById.has(message.id)) return;
    const emoji = reaction.emoji?.name || "";
    if (!emoji) return;
    const record = recordReaction(channelId, { emoji, userName: displayNameFor(user.id) });
    if (!record) return;
    if (!config.analysisEnabled) {
      if (HEART_REACT_RE.test(emoji)) updateRomance(user.id, { weight: 0.4, signal: `react:${emoji}` });
      return;
    }
    queueReactionForAnalysis(channelId, {
      messageId: message.id,
      emoji,
      userId: user.id,
      userName: record.userName,
      recordRef: record,
    });
  } catch (error) {
    console.warn("Reaction tracking failed:", error.message);
  }
});

// --- AI game spectating -------------------------------------------------------
// In game channels she used to be completely silent. Now, when a game bot
// posts a panel with a win/loss-worthy signal, she occasionally (cooldown +
// chance + judgment) sends ONE spectator comment — teasing an all-in,
// celebrating a jackpot. The same judgment call can learn the command word
// that triggered the panel, so the game-command filter grows without code
// changes (the "whl" lesson, automated).
const GAME_PANEL_SIGNAL_RE = /\b(?:won|lost|win|winner|jackpot|congrat\w*|bankrupt|broke|bust|payout|multiplier|streak|all\s?in|profit)\b/i;
const gameWatchLastAtByChannel = new Map();

function maybeWatchGamePanel(message, panelText) {
  try {
    if (!panelText) return;
    if (message.channel?.isDMBased?.()) return;
    const signalText = `${message.content || ""} ${panelText}`.replace(/\s+/g, " ").trim();
    if (!GAME_PANEL_SIGNAL_RE.test(signalText)) return;
    const channelId = message.channel.id;
    const last = gameWatchLastAtByChannel.get(channelId) || 0;
    if (Date.now() - last < config.gameWatchCooldownMs) return;
    if (Math.random() >= config.gameWatchChance) return;
    // Claim the slot before the call, so a failed judgment doesn't re-roll instantly.
    gameWatchLastAtByChannel.set(channelId, Date.now());
    jobs.backgroundQueue.add(async () => {
      // The last HUMAN line before this panel — the candidate trigger command.
      const triggerRow = memoryDb.prepare(
        "SELECT content FROM messages WHERE channel_id = ? AND is_bot = 0 ORDER BY id DESC LIMIT 1",
      ).get(channelId);
      // Learned game channels log no bot traffic, so the panel that triggered
      // this watch is invisible to recentChannelLines — hand it to the
      // judgment explicitly, or it would judge a moment it cannot see.
      const baseLines = recentChannelLines(channelId, 8);
      const panelLine = `${message.author.displayName || message.author.username} [bot]: ${String(panelText).replace(/\s+/g, " ").trim().slice(0, 400)}`;
      const verdict = await analyst.judgeGameMoment({
        channelLabel: message.channel.name || "game-channel",
        gameBotName: message.author.displayName || message.author.username,
        lines: isLearnedGameChannel(channelId)
          ? (baseLines ? `${baseLines}\n${panelLine}` : panelLine)
          : baseLines,
        triggerCandidate: triggerRow ? String(triggerRow.content).slice(0, 24) : "",
      });
      if (!verdict) return;
      if (verdict.learnedCommand && !learnedGameCommands.has(verdict.learnedCommand)) {
        learnedGameCommands.add(verdict.learnedCommand);
        memoryDb.prepare("INSERT OR IGNORE INTO learned_commands(command, learned_at) VALUES (?, ?)")
          .run(verdict.learnedCommand, Date.now());
        console.log(`Judgment layer: learned new game command "${verdict.learnedCommand}"`);
      }
      if (!verdict.speak || !verdict.line) return;
      const channel = message.channel;
      await deliverReply({ channel, react: async () => {} }, verdict.line, {
        lastSpokeAtRef,
        spontaneous: true,
        onSent: (sent) => trackSentMessage(sent, verdict.line),
      });
      rememberBotMessage(channel.id, verdict.line);
      rememberOwnMessage({ channel, guild: channel.guild }, verdict.line);
    }).catch((error) => console.warn("Game spectating failed:", error.message));
  } catch (error) {
    console.warn("Game watch trigger failed:", error.message);
  }
}

// Raw live lines from a channel, no preamble — shared by the reply snapshot
// and the chime-in judgment. When someone used Discord's reply on a specific
// message, that exact message is merged in even if the channel is too busy
// for it to still be in the last ten (they are pointing AT it — it must be
// visible no matter how far up it scrolled).
async function fetchLiveChannelLines(channel, referenceId) {
  try {
    const recent = await channel.messages.fetch({ limit: 10 });
    const msgs = [...recent.values()];
    if (referenceId && !msgs.some((msg) => msg.id === referenceId)) {
      try {
        const ref = await channel.messages.fetch(referenceId);
        if (ref) msgs.push(ref);
      } catch {
        // the referenced message may be deleted or too old — the recent ten
        // still give her the scene
      }
    }
    return renderChannelSnapshot(msgs, client.user.id);
  } catch {
    return "";
  }
}

// The addressed-reply wrapper: live lines plus the explanatory preamble the
// reply model reads. One REST fetch, only on messages already addressed to
// her; any failure degrades to replying without the snapshot.
async function fetchGameChannelSnapshot(channel, referenceId) {
  const text = await fetchLiveChannelLines(channel, referenceId);
  return text
    ? `Recent messages in this channel (live view — bot messages include their rendered panels and buttons, oldest first):\n${text}`
    : "";
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    botActivityByChannel.set(message.channel.id, (botActivityByChannel.get(message.channel.id) || 0) + 1);
    // Her own messages are logged at delivery time (rememberOwnMessage, with
    // the full reply text) — the gateway echo must not double-log them.
    if (message.author.id !== client.user.id) {
      otherBotMessageAtByChannel.set(message.channel.id, Date.now());
      // Log other bots' messages (truncated, never in learned game channels) so
      // she knows who TEST./OwO/Karuta are when someone asks "who is dis?".
      // Game panels live in embeds and buttons, not content — render them so she
      // can see the HighLow card the user wants help deciding on. Bot attachments
      // (Karuta's card drops) are noted as metadata.
      // No embeddings: game-bot spam would burn CPU for zero recall value.
      const panelText = [
        renderEmbeds(message.embeds),
        renderButtons(message.components),
        renderMediaExtras(message),
      ].filter(Boolean).join(" ");
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
      // AI spectating: one judgment call when a game panel shows a
      // win/loss-worthy moment — she may tease, and she may learn a new
      // game command from what triggered it.
      if (config.analysisEnabled) maybeWatchGamePanel(message, panelText);
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
  // Media awareness: attachments, stickers and polls become readable notes, so
  // "look at this [attached: meme.png (image, 512 KB, 800×600)]" is a real
  // conversation even when she cannot watch a video or listen to a voice clip.
  const mediaExtras = renderMediaExtras(message);
  const loggedContent = `${renderedContent}${mediaExtras ? ` ${mediaExtras}` : ""}`.trim();

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
  // In a DM, every message is talking to her. Engagement now also carries
  // inside bot-game channels — that is where people hold whole conversations
  // with her around the games — but only for follow-ups that are real
  // conversation: not commands, not replies to other bots, and at least 8
  // characters, the same noise floor as the spontaneous path, so game-channel
  // chatter like "W" or "lol" never drags her in.
  const gameChannelFollowUp = isLearnedGameChannel(message.channel.id)
    && !gameCommand && !replyingToAnotherBot
    && message.content.trim().length >= 8;
  const engagementEligible = !gameCommand && !replyingToAnotherBot
    && (!isLearnedGameChannel(message.channel.id) || gameChannelFollowUp);
  const engaged = inDm || (engagementEligible
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

    // The roll fired: claim the slot so nothing re-rolls while the judgment
    // is in flight, and a "stay quiet" verdict buys real quiet.
    spontaneousReplies.set(message.channel.id, Date.now());

    if (config.analysisEnabled) {
      try {
        const { verdict, lines } = await judgeChimeInFor(
          message.channel, "someone just said something she overheard", message.reference?.messageId);
        if (verdict) {
          if (verdict.speak && verdict.line && !isRepeatOfRecent(verdict.line, lines)) {
            await deliverReply(message, verdict.line, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, verdict.line) });
            updateAffinity(message.author.id);
            markEngaged(message.channel.id, message.author.id);
            rememberBotMessage(message.channel.id, verdict.line);
            rememberOwnMessage(message, verdict.line);
          }
          return;
        }
        // No verdict (budget spent, API down, bad JSON): fall through to the
        // classic NO_REPLY path below — never quieter than before.
      } catch (error) {
        console.warn("Chime-in judgment failed:", error.message);
      }
    }

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
      const chimePrompt = `Someone in Discord said: "${loggedContent}".${replyNote} React naturally, only if there is a reason to join in. If you would add nothing useful, answer exactly: NO_REPLY.`;
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
        await deliverReply(message, answer, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, answer) });
        updateAffinity(message.author.id);
        markEngaged(message.channel.id, message.author.id);
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
    // A bare @-mention used to always get the canned line — even when they
    // were pointing straight at something: a Discord reply aimed at a game
    // panel with no words ("@teacher-san" while replying to OwO's card), or
    // an @-mention holding up an attachment. She answered "Hey! What do you
    // want to talk about?" while the fully rendered panel sat unused in the
    // already-resolved reply target — that read as "she can't see it". If
    // there is anything to look at, fall through to the memory-rich reply:
    // the thing they pointed at IS the message.
    const pointingAtSomething = Boolean(replyTarget?.content)
      || Boolean(mediaExtras)
      || Boolean(message.attachments?.size);
    if (!pointingAtSomething) {
      await message.reply("Hey! What do you want to talk about?");
      return;
    }
  }

  await message.channel.sendTyping();
  try {
    let answer;
    if (isReplyIdentityQuestion(prompt)) {
      // Deterministic: built only from the verified reply target, so she can
      // never name the wrong bot. Never hardcode her own name — use the
      // live username so renaming the bot cannot make her lie.
      answer = pickIdentityAnswer(replyTarget, client.user.username);
      await deliverReply(message, answer, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, answer) });
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
      // Vision: if they attached image(s) to a message meant for her, actually
      // look at them — the images ride along in the same request, so the reply
      // costs no extra API call.
      let visionImages = [];
      if (message.attachments?.size) {
        try {
          visionImages = await collectVisionImages(message);
        } catch {
          // A failed download must never block the text reply.
        }
      }
      const promptWithMedia = `${prompt}${mediaExtras ? ` ${mediaExtras}` : ""}`.trim();
      let embedVector = null;
      if (promptWithMedia) {
        try {
          embedVector = await embedText(promptWithMedia);
        } catch {
          // FTS-only retrieval still works if the local embedder fails.
        }
      }
      // "here @OwO" / "this" aimed at another bot is a pointer, not a command:
      // they are holding up that bot's message for her to look at.
      const mentionedOtherBot = mentioned
        ? null
        : [...message.mentions.users.values()].find((user) => user.bot && user.id !== client.user.id) || null;
      const pointingAtBot = mentionedOtherBot && isPointingAtBot(prompt)
        ? (mentionedOtherBot.displayName || mentionedOtherBot.globalName || mentionedOtherBot.username)
        : null;
      const reactionsSeen = recentReactionSummary(message.channel.id);
      // Learned game channels log no bot panels, and in any channel a fresh
      // panel can be pushed out of the persistent transcript window fast — so
      // take one live look at the channel whenever a bot was part of the scene
      // by ANY source. The in-memory map is wiped by every restart (that is,
      // every deploy), so the log check keeps the live look working right
      // after a redeploy; and when they used Discord's reply, the exact
      // message they pointed at is merged into the snapshot no matter how far
      // up it scrolled. This is how she actually sees the HighLow card someone
      // wants help deciding on, instead of "you haven't shown me anything".
      const otherBotRecent = Date.now() - (otherBotMessageAtByChannel.get(message.channel.id) || 0) <= 5 * 60_000;
      let loggedBotRecent = false;
      try {
        const lastOtherBotRow = memoryDb.prepare(
          "SELECT created_at FROM messages WHERE channel_id = ? AND is_bot = 1 AND author_id != ? ORDER BY id DESC LIMIT 1",
        ).get(message.channel.id, client.user.id);
        loggedBotRecent = lastOtherBotRow
          ? Date.now() - lastOtherBotRow.created_at <= 10 * 60_000
          : false;
      } catch {
        loggedBotRecent = false;
      }
      const pointedWithReply = Boolean(message.reference?.messageId);
      const gameSnapshot = !message.channel.isDMBased?.()
        && (isLearnedGameChannel(message.channel.id) || otherBotRecent || loggedBotRecent || pointedWithReply)
        ? await fetchGameChannelSnapshot(message.channel, message.reference?.messageId)
        : "";
      const persistentContext = buildContext(memoryDb, {
        message: {
          channelId: message.channel.id,
          authorId: message.author.id,
          authorName: displayName,
          content: promptWithMedia,
          guildId: message.guild?.id || "",
          activeConvo: engaged || replyingToMe,
          pointingAtBot,
          reactionsSeen,
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
            ...(gameSnapshot ? [gameSnapshot] : []),
            ...(visionImages.length
              ? ["This message includes attached image(s) and you can actually see them. Look at them properly: mention what you concretely notice — people, animals, text, places, the vibe — like a friend who actually opened the photo, not someone guessing from the filename. Describe what stands out; that description is how you'll remember the image later."]
              : []),
          ].filter(Boolean).join("\n"),
        },
        // A bare @-mention that fell through above must not become an empty
        // user turn — the floor note sends the model to what they pointed at
        // (the reply target and any attachment are already in the context).
        { role: "user", content: visionUserContent(
          promptWithMedia
            || "(no text — they only tagged you. Look at the message they replied to and any attachment, then respond.)",
          visionImages,
        ) },
      ];
      const lastOwnReply = lastAssistantReply(message.channel.id);
      let streamedSentId = null;
      answer = await deliverStreamedReply(message, (onDelta) => streamReply({ messages, onDelta }), {
        lastSpokeAtRef,
        // Tracked from the first moment the message exists (reactions during
        // streaming count); the real text is filled in below once the stream
        // finishes — that text is what reaction interpretation reads later.
        onSent: (sent) => {
          streamedSentId = sent?.id;
          trackSentMessage(sent, "");
        },
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
      if (streamedSentId && answer) noteSentMessageContent(streamedSentId, answer);
    }
    if (!answer) return;
    if (!delivered) await deliverReply(message, answer, { lastSpokeAtRef, onSent: (sent) => trackSentMessage(sent, answer) });
    updateAffinity(message.author.id);
    markEngaged(message.channel.id, message.author.id);
    rememberBotMessage(message.channel.id, answer);
    rememberOwnMessage(message, answer);
  } catch (error) {
    console.error(error);
    await message.reply("My brain tripped for a second. Please try again.");
  }
});

// Verifiable deploys: the zip ships commit-hash.txt, so "am I actually
// running the latest build?" is answerable from the host logs in one glance.
try {
  const buildHash = readFileSync(new URL("../commit-hash.txt", import.meta.url), "utf8").trim();
  if (buildHash) console.log(`[teacher-san] running build ${buildHash.slice(0, 12)}`);
} catch {
  // No hash file (dev checkout) — nothing to report.
}

client.login(config.discordToken);
