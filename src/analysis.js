const JUDGE_SYSTEM_PROMPT =
  "You are the quiet inner judgment layer of Capri (Cyberpunk: Edgerunners 2) inside a Discord server. Respond with valid JSON ONLY — no markdown fences, no commentary outside the JSON.";

const COMMAND_NOISE = new Set([
  "here", "this", "that", "dis", "look", "check", "see", "peep", "help",
  "pls", "please", "capri", "yo", "hey", "hi", "ok", "okay", "yes", "no",
]);

export function extractJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function cleanText(value, maxLen = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function safeEmoji(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 16 || /[a-z0-9]/i.test(text)) return "";
  return text;
}

export function validLearnedCommand(triggerCandidate, proposed) {
  const word = String(proposed ?? "").trim().toLowerCase();
  if (!word || word.length < 2 || word.length > 16) return "";
  if (!/^[a-z][a-z0-9]{1,15}$/.test(word)) return "";
  if (COMMAND_NOISE.has(word)) return "";
  const firstWord = String(triggerCandidate ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  if (!firstWord || firstWord !== word) return "";
  return word;
}

export function createAnalyst({ completeAI, maxPerMinute = 16, persona = "" }) {
  const callTimestamps = [];
  const stats = { calls: 0, fallbacks: 0, skipped: 0 };

  function tryBudget() {
    const cutoff = Date.now() - 60_000;
    while (callTimestamps.length && callTimestamps[0] < cutoff) callTimestamps.shift();
    if (callTimestamps.length >= maxPerMinute) return false;
    callTimestamps.push(Date.now());
    return true;
  }

  function personaBlock() {
    const trimmed = String(persona || "").trim();
    return trimmed ? `## Capri voice\n${trimmed.slice(0, 700)}` : "";
  }

  async function interpretReactions({ groups, contextLines = "", peopleNotes = "" }) {
    const flat = [];
    const sections = [];
    for (const group of groups || []) {
      const list = group?.reactions || [];
      if (!list.length) continue;
      const numbered = list.map((r) => {
        const index = flat.length + 1;
        flat.push(r);
        return `  ${index}. ${r.emoji} by ${r.who}`;
      });
      const snippet = cleanText(group.herText, 200) || "(earlier message)";
      sections.push(`Capri's message: "${snippet}"\nReactions:\n${numbered.join("\n")}`);
    }
    if (!flat.length) return [];
    if (!tryBudget()) {
      stats.skipped += 1;
      return null;
    }
    stats.calls += 1;
    let raw;
    try {
      raw = await completeAI({
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              "## Task",
              "Interpret emoji reactions people left on Capri's Discord messages.",
              personaBlock(),
              sections.join("\n\n"),
              `## Recent channel context\n${contextLines || "(nothing recent)"}`,
              `## Known people\n${peopleNotes || "(strangers)"}`,
              `## Output (strict JSON, ${flat.length} entries)\n{"reactions":[{"meaning":"flirty teasing","romance_weight":0.6,"react_back":true,"react_emoji":"⚡","note":"Alex reacted to her joke"}]}`,
            ].filter(Boolean).join("\n\n"),
          },
        ],
        thinking: false,
        temperature: 0.3,
      });
    } catch {
      stats.fallbacks += 1;
      return null;
    }
    const parsed = extractJson(raw);
    const list = parsed?.reactions;
    if (!Array.isArray(list) || list.length !== flat.length) {
      stats.fallbacks += 1;
      return null;
    }
    return list.map((entry) => ({
      meaning: cleanText(entry?.meaning, 60),
      romanceWeight: clamp01(entry?.romance_weight),
      reactBack: entry?.react_back === true,
      reactEmoji: safeEmoji(entry?.react_emoji),
      note: cleanText(entry?.note, 120),
    }));
  }

  async function judgeChimeIn({ channelLabel = "chat", lines = "", peopleNotes = "", worldNote = "", occasion = "someone just spoke" }) {
    if (!tryBudget()) {
      stats.skipped += 1;
      return null;
    }
    stats.calls += 1;
    let raw;
    try {
      raw = await completeAI({
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              "## Task",
              `Capri is hanging out in #${channelLabel} (${occasion}). Decide whether she should speak on her own or drop a reaction, and write the line if speaking.`,
              personaBlock(),
              `## Recent messages\n${lines || "(quiet channel)"}`,
              `## People\n${peopleNotes || "(strangers)"}`,
              worldNote ? `## Right now\n${worldNote}` : "",
              [
                "## Rules",
                '- "speak": true if there is a fun opening, banter, hot take, or check-in that fits Capri. False only if heavy private venting or zero opening.',
                '- "line": max 220 chars in Capri voice.',
                '- "emoji": optional single reaction emoji if she prefers reacting silently when speak is false.',
                '- "reason": short note.',
              ].join("\n"),
              '{"speak":true,"line":"wait you all actually pushed to prod on a friday??","emoji":"","reason":"banter opening"}',
            ].filter(Boolean).join("\n\n"),
          },
        ],
        thinking: false,
        temperature: 0.85,
      });
    } catch {
      stats.fallbacks += 1;
      return null;
    }
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed.speak !== "boolean") {
      stats.fallbacks += 1;
      return null;
    }
    const line = cleanText(parsed.line, 220);
    const speak = parsed.speak === true && Boolean(line);
    return {
      speak,
      line: speak ? line : "",
      emoji: safeEmoji(parsed.emoji),
      reason: cleanText(parsed.reason, 120),
    };
  }

  async function judgeGameMoment({ channelLabel = "game channel", gameBotName = "game bot", lines = "", triggerCandidate = "" }) {
    if (!tryBudget()) {
      stats.skipped += 1;
      return null;
    }
    stats.calls += 1;
    let raw;
    try {
      raw = await completeAI({
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              "## Task",
              `Capri is watching people play a bot game (${gameBotName}) in #${channelLabel}.`,
              personaBlock(),
              `## What happened\n${lines || "(no recent lines)"}`,
              triggerCandidate ? `## Trigger message\n"${triggerCandidate}"` : "",
              '{"speak":true,"line":"all-in again?? bold move","reason":"big bet","learned_command":"whl"}',
            ].filter(Boolean).join("\n\n"),
          },
        ],
        thinking: false,
        temperature: 0.85,
      });
    } catch {
      stats.fallbacks += 1;
      return null;
    }
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed.speak !== "boolean") {
      stats.fallbacks += 1;
      return null;
    }
    const line = cleanText(parsed.line, 220);
    const speak = parsed.speak === true && Boolean(line);
    return {
      speak,
      line: speak ? line : "",
      reason: cleanText(parsed.reason, 120),
      learnedCommand: validLearnedCommand(triggerCandidate, parsed.learned_command),
    };
  }

  return { interpretReactions, judgeChimeIn, judgeGameMoment, stats };
}
