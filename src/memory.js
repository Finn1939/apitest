import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
