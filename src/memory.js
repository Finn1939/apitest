export const HISTORY_LIMIT = 30;
export const FACT_LIMIT = 20;

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
