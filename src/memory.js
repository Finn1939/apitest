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

export function truncateTokens(text, maxTokens) {
  const value = String(text || "");
  const maxChars = maxTokens * 4;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

export function logMessage(db, message) {
  return db.prepare(`
    INSERT INTO messages(channel_id, author_id, author_name, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    message.channelId,
    message.authorId,
    message.authorName || message.authorId,
    message.content,
    message.createdAt || Date.now(),
  ).lastInsertRowid;
}

export function buildContext(db, { message, embedVector, personalityPath = "personality.txt" }) {
  const personality = truncateTokens(readFileSync(personalityPath, "utf8").trim(), 500);
  const selfModel = truncateTokens(
    db.prepare("SELECT persona FROM self_model WHERE id = 1").get()?.persona || "",
    200,
  );
  const speakerFacts = db.prepare(`
    SELECT fact, confidence FROM facts
    WHERE subject = ?
    ORDER BY hits DESC, last_seen DESC
  `).all(`user:${message.authorName}`).slice(0, 12);
  const factsText = truncateTokens(speakerFacts.map(({ fact, confidence }) =>
    `- [${confidence.toFixed(2)}] ${fact}`).join("\n"), 600);

  const recent = db.prepare(`
    SELECT author_name, content FROM messages
    WHERE channel_id = ?
    ORDER BY id DESC LIMIT 20
  `).all(message.channelId).reverse();
  const recentText = truncateTokens(recent.map((entry) => `${entry.author_name}: ${entry.content}`).join("\n"), 1000);
  const summaries = db.prepare(`
    SELECT summary FROM summaries WHERE channel_id = ? ORDER BY created_at DESC LIMIT 2
  `).all(message.channelId).map(({ summary }) => summary).join("\n");

  const relevant = [];
  if (message.content.length > 2) {
    const escaped = message.content.replace(/"/g, '""');
    try {
      const rows = db.prepare(`
        SELECT m.id, m.author_name, m.content, m.importance, m.created_at
        FROM fts_messages
        JOIN messages m ON m.id = fts_messages.rowid
        WHERE fts_messages MATCH ?
        LIMIT 8
      `).all(`"${escaped}"`);
      relevant.push(...rows);
    } catch {
      // FTS query syntax can vary with user input; normal conversation still works.
    }
  }
  if (embedVector) {
    try {
      const vectorRows = db.prepare(`
        SELECT message_id AS id FROM vec_messages
      `).all();
      if (vectorRows.length) relevant.push(...db.prepare(`
        SELECT m.id, m.author_name, m.content, m.importance, m.created_at
        FROM messages m JOIN vec_messages v ON v.message_id = m.id
        WHERE m.content != '' LIMIT 0
      `).all());
    } catch {
      // Retrieval remains useful through FTS when vector search is unavailable.
    }
  }

  const uniqueRelevant = [...new Map(relevant.map((row) => [row.id, row])).values()]
    .sort((a, b) => b.created_at - a.created_at).slice(0, 8);
  const relevantText = truncateTokens(
    [summaries, ...uniqueRelevant.map((row) => `${row.author_name}: ${row.content}`)].filter(Boolean).join("\n"),
    1200,
  );
  const memoryBlock = PROMPT_A
    .replace("{{SELF_MODEL}}", selfModel)
    .replace("{{USER_FACTS}}", factsText || "Nothing remembered yet.")
    .replace("{{RELEVANT_MEMORIES}}", relevantText || "No relevant memories.")
    .replace("{{RECENT_MESSAGES}}", recentText || "No recent messages.");

  return { personality, memoryBlock, estimatedTokens: estimatedTokens(`${personality}\n${memoryBlock}`) };
}
