import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROMPT_A } from "./prompts.js";

export const HISTORY_LIMIT = 30;
export const FACT_LIMIT = 100;
export const MEMORY_FILE = resolve(process.env.MEMORY_FILE || "data/channel-memory.json");

export function addHistory(history, entry, limit = HISTORY_LIMIT) {
  return [...history, entry].slice(-limit);
}

export function addFact(facts, fact) {
  if (!fact || facts.includes(fact)) return facts;
  return [...facts, fact].slice(-FACT_LIMIT);
}

export function parseRememberCommand(prompt) {
  const match = prompt.match(/^remember(?:\s+that)?\s*[:\-]?\s*(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function loadMemory(filePath = MEMORY_FILE) {
  try {
    const stored = JSON.parse(readFileSync(filePath, "utf8"));
    return {
      conversations: new Map(Object.entries(stored.conversations || {})),
      facts: new Map(Object.entries(stored.facts || {})),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { conversations: new Map(), facts: new Map() };
    }
    throw new Error(`Failed to load memory from ${filePath}: ${error.message}`);
  }
}

export function saveMemory(conversations, facts, filePath = MEMORY_FILE) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.tmp`;
  const stored = {
    conversations: Object.fromEntries(conversations),
    facts: Object.fromEntries(facts),
  };
  writeFileSync(temporaryFile, `${JSON.stringify(stored, null, 2)}\n`);
  renameSync(temporaryFile, filePath);
}

const estimatedTokens = (text) => Math.ceil(String(text).length / 4);

// Human-feeling tier for how close the bot is to someone (affinity grows ~0.05 per interaction).
function affinityTier(affinity) {
  if (affinity >= 4) return "one of your closest people in this server";
  if (affinity >= 1.5) return "a regular you are genuinely fond of";
  if (affinity >= 0.5) return "a familiar face you like talking to";
  if (affinity >= 0.2) return "an acquaintance you are starting to know";
  return "someone you barely know yet";
}

function timeAgo(timestamp) {
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function truncateTokens(text, maxTokens) {
  const value = String(text || "");
  const maxChars = maxTokens * 4;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

export function logMessage(db, message) {
  return db.prepare(`
    INSERT INTO messages(channel_id, author_id, author_name, username, content, created_at, guild_id, is_bot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.channelId,
    message.authorId,
    message.authorName || message.authorId,
    message.username || "",
    message.content,
    message.createdAt || Date.now(),
    message.guildId || "",
    message.isBot ? 1 : 0,
  ).lastInsertRowid;
}

export function buildContext(db, { message, embedVector, personalityPath = "personality.txt", deepRecall = false, botId = "", replyTo = null, memoryContextTokens = 32000 }) {
  const personality = truncateTokens(readFileSync(personalityPath, "utf8").trim(), 2000);
  const selfModel = truncateTokens(
    db.prepare("SELECT persona FROM self_model WHERE id = 1").get()?.persona || "",
    1200,
  );

  // Who is speaking, how the bot feels about them, and when they last really talked.
  const speakerName = message.authorName || "Someone";
  const speakerHandle = db.prepare(
    "SELECT username FROM messages WHERE author_id = ? AND username != '' ORDER BY id DESC LIMIT 1"
  ).get(message.authorId)?.username;
  const relationship = db.prepare(
    "SELECT affinity, last_interacted FROM relationships WHERE user_id = ?"
  ).get(message.authorId);
  const speakerLines = [
    `${speakerName}${speakerHandle ? ` (@${speakerHandle})` : ""} is talking to you right now.`,
  ];
  if (message.activeConvo) {
    speakerLines.push("You are in the middle of an ongoing conversation with them right now; they are talking to you even without mentioning you.");
  }
  if (relationship && (relationship.affinity > 0 || relationship.last_interacted > 0)) {
    speakerLines.push(`To you they feel like ${affinityTier(relationship.affinity)}.`);
    if (relationship.last_interacted > 0) {
      const days = Math.floor((Date.now() - relationship.last_interacted) / 86_400_000);
      if (days >= 2) speakerLines.push(`You last really talked ${days} day${days === 1 ? "" : "s"} ago.`);
      else if (days === 1) speakerLines.push("You last really talked yesterday.");
    }
  } else {
    speakerLines.push("You do not know them yet; this may be your first real exchange.");
  }
  // If they used Discord's reply feature, name the message they replied to —
  // this is how "tell me his user" becomes answerable instead of ambiguous.
  if (replyTo?.authorName) {
    const target = replyTo.isSelf ? "your earlier message" : `${replyTo.authorName}'s message`;
    speakerLines.push(
      `They used Discord's reply on ${target}${replyTo.content ? ` — "${replyTo.content}"` : " (its text is unavailable)"}.`,
    );
    if (replyTo.isSelf) {
      speakerLines.push("The user is replying to you, the bot. Pronouns such as \"you\" and \"your\" refer to you; pronouns such as \"I\" and \"me\" refer to the replying user.");
    } else {
      speakerLines.push(`When they say "he", "him" or "his", they most likely mean ${replyTo.authorName}.`);
      speakerLines.push(`If the user asks who they are replying to, name the author exactly as ${replyTo.authorName}. Do not guess another bot or person from surrounding messages.`);
    }
  }
  const speakerText = speakerLines.join(" ");

  // Roster of people (and bots) the bot has actually seen in this server, with
  // usernames, so "what's his username?" and "who is dis?" style questions can
  // be answered. Humans come first; bots are labelled so she never mistakes a
  // game bot for a person.
  const rosterRows = db.prepare(`
    SELECT author_id, author_name, is_bot,
           COALESCE(NULLIF(username, ''), NULLIF(author_name, ''), author_id) AS handle,
           MAX(created_at) AS last_active
    FROM messages
    WHERE created_at >= ? AND author_id != ? AND (guild_id = ? OR guild_id = '')
    GROUP BY author_id
    ORDER BY is_bot ASC, last_active DESC
    LIMIT 15
  `).all(Date.now() - 30 * 86_400_000, botId || "", message.guildId || "");
  const rosterText = rosterRows.length
    ? rosterRows.map((row) => {
        const hasHandle = row.handle !== row.author_name;
        return `- ${row.author_name}${hasHandle ? ` (@${row.handle})` : ""}${row.is_bot ? " [a bot]" : ""} — last active ${timeAgo(row.last_active)}`;
      }).join("\n")
    : "";

  // Facts are keyed by stable Discord user ID, so they survive nickname changes.
  const speakerFacts = db.prepare(`
    SELECT fact, confidence FROM facts
    WHERE subject = ?
    ORDER BY hits DESC, last_seen DESC
  `).all(`user:${message.authorId}`);
  const factsText = speakerFacts.length
    ? `What you know about ${speakerName} (the speaker):\n${speakerFacts.map(({ fact, confidence }) =>
      `- [${confidence.toFixed(2)}] ${fact}`).join("\n")}`
    : "";

  const recent = db.prepare(`
    SELECT author_name, content FROM messages
    WHERE channel_id = ?
    ORDER BY id DESC LIMIT 500
  `).all(message.channelId).reverse();
  const recentText = recent.map((entry) => `${entry.author_name}: ${entry.content}`).join("\n");
  const summaries = db.prepare(`
    SELECT summary FROM summaries WHERE channel_id = ? ORDER BY created_at DESC LIMIT 2
  `).all(message.channelId).map(({ summary }) => summary).join("\n");

  const relevantColumns = "m.id, m.author_name, m.content, m.importance, m.created_at, m.guild_id";
  const guildClause = message.guildId ? "AND (m.guild_id = ? OR m.guild_id = '')" : "";
  const ranked = new Map();
  const addRanked = (rows) => rows.forEach((row, rank) => {
    const entry = ranked.get(row.id);
    if (entry) entry.score += 1 / (60 + rank + 1);
    else ranked.set(row.id, { row, score: 1 / (60 + rank + 1) });
  });

  // Keyword leg: search meaningful words instead of the whole sentence as one phrase.
  const terms = [...new Set((message.content.toLowerCase().match(/[a-z0-9']{4,}/g) || []))].slice(0, 8);
  if (terms.length) {
    try {
      const ftsQuery = terms.map((term) => `"${term}"`).join(" OR ");
      const ftsSql = `
        SELECT ${relevantColumns}
        FROM fts_messages
        JOIN messages m ON m.id = fts_messages.rowid
        WHERE fts_messages MATCH ? ${guildClause}
        LIMIT 12
      `;
      const ftsRows = message.guildId
        ? db.prepare(ftsSql).all(ftsQuery, message.guildId)
        : db.prepare(ftsSql).all(ftsQuery);
      addRanked(ftsRows);
    } catch {
      // FTS query syntax can vary with user input; normal conversation still works.
    }
  }

  // Semantic leg: true KNN over the sqlite-vec virtual table.
  if (embedVector?.length === 384) {
    try {
      const k = deepRecall ? 24 : 12;
      const vecRows = db.prepare(`
        SELECT ${relevantColumns}
        FROM (SELECT message_id, distance FROM vec_messages_v WHERE embedding MATCH ? AND k = ${k}) v
        JOIN messages m ON m.id = v.message_id
      `).all(Buffer.from(new Float32Array(embedVector).buffer));
      addRanked(vecRows);
    } catch {
      // Retrieval remains useful through FTS when vector search is unavailable.
    }
  }

  const now = Date.now();
  const uniqueRelevant = [...ranked.values()]
    .filter(({ row }) => !message.guildId || !row.guild_id || row.guild_id === message.guildId)
    .map(({ row, score }) => ({
      row,
      score: score * 0.7
        + 0.2 * Math.exp(-(now - row.created_at) / (30 * 24 * 60 * 60 * 1000))
        + 0.1 * (row.importance ?? 0.5),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, deepRecall ? 32 : 24)
    .map(({ row }) => row);
  const relevantText =
    [summaries, ...uniqueRelevant.map((row) => `${row.author_name}: ${row.content}`)].filter(Boolean).join("\n");

  // Budget the sections BEFORE they enter the template. All replacements use
  // function form: String.replace interprets "$&", "$`", "$'" and "$$" in a
  // string replacement, so memories containing dollar signs (code snippets,
  // prices, shell commands) would silently corrupt the block.
  const fixedTokens = estimatedTokens(`${personality}\n${speakerText}\n${rosterText}`);
  const memoryBudget = Math.max(4000, memoryContextTokens - fixedTokens - 4000);
  const factsBudget = Math.min(4000, Math.floor(memoryBudget * 0.14));
  const recentBudget = Math.min(12000, Math.floor(memoryBudget * 0.43));
  const relevantBudget = Math.max(0, Math.min(8000, memoryBudget - factsBudget - recentBudget));
  const boundedFacts = truncateTokens(factsText, factsBudget);
  const boundedRecent = truncateTokens(recentText, recentBudget);
  const boundedRelevant = truncateTokens(relevantText, relevantBudget);

  const memoryBlock = PROMPT_A
    .replace("{{SELF_MODEL}}", () => selfModel)
    .replace("{{SPEAKER}}", () => speakerText)
    .replace("{{ROSTER}}", () => rosterText || "You have not met anyone here yet.")
    .replace("{{USER_FACTS}}", () => boundedFacts || `You know nothing about ${speakerName} yet.`)
    .replace("{{RELEVANT_MEMORIES}}", () => boundedRelevant || "No relevant memories.")
    .replace("{{RECENT_MESSAGES}}", () => boundedRecent || "No recent messages.");

  return {
    personality,
    memoryBlock,
    estimatedTokens: estimatedTokens(`${personality}\n${memoryBlock}`),
  };
}
