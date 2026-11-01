// --- AI judgment layer --------------------------------------------------------
// Small, structured analysis calls that make her decisions smarter than
// regexes: what an emoji reaction really meant, whether a game-channel moment
// is worth one comment, which word triggered a game bot's panel.
//
// Design rules that keep this safe next to live replies:
// 1. Budget: judgment calls get their own sliding-window cap (default 10/min
//    out of the pool's 120/min). When the cap is hit, callers fall back to the
//    old deterministic rules — replies always keep priority.
// 2. Batching: reaction events accumulate in the caller and are interpreted
//    in ONE call, not per reaction.
// 3. Fallback: any failure (API down, unparsable JSON, wrong shape) returns
//    null and the caller applies the pre-existing behavior. Analysis enhances,
//    never gates.

const JUDGE_SYSTEM_PROMPT = [
  "You are the private judgment module of a Discord character bot.",
  "You analyze social signals and chat moments to tune her behavior.",
  "You never talk to users directly and never produce chat messages unless asked for one.",
  "Output STRICT JSON only — no markdown fences, no commentary, nothing outside the JSON.",
].join(" ");

// Strictly a single unicode emoji (pictographs, variation selectors, ZWJ).
// Custom Discord emoji ("<:name:123>") and words are rejected — she mirrors
// with plain unicode only.
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+$/u;

// Words that must never be learned as game commands: deictic pointers at bot
// messages, agreements, filler — anything a human says near a game panel that
// is clearly not the command that triggered it.
const LEARNED_COMMAND_STOP = new Set([
  "here", "this", "that", "dis", "dat", "look", "check", "see", "peep",
  "yes", "no", "yeah", "yea", "yep", "nope", "ok", "okay", "k", "kk",
  "lol", "lmao", "wow", "nice", "gg", "omg", "wtf", "pls", "please",
  "help", "me", "you", "u", "my", "the", "a", "i", "im", "he", "she",
  "they", "what", "who", "why", "how", "when", "where", "again", "more",
  "go", "stop", "wait", "hi", "hey", "yo", "omg", "bruh", "bro", "dude",
]);

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

function safeEmoji(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 16) return null;
  return EMOJI_ONLY_RE.test(text) ? text : null;
}

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Pulls the JSON object out of a model answer that may be fenced or surrounded
// by chatter. Returns the parsed object or null — never throws.
export function extractJson(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A learned command is only accepted when the AI's word is provably the first
// word of the short human message that preceded the bot panel, and that
// message looks like a bare command or command+wager ("whl", "whl 500").
// Everything else — pointers like "here", SQL, sentences — is rejected.
export function validLearnedCommand(triggerCandidate, learnedCommand) {
  const token = String(learnedCommand || "").trim().toLowerCase();
  if (!/^[a-z0-9]{2,12}$/.test(token)) return null;
  if (LEARNED_COMMAND_STOP.has(token)) return null;
  const candidate = String(triggerCandidate || "").trim().toLowerCase();
  if (!candidate) return null;
  if (!/^[a-z0-9]+(?:\s+(?:\d+|all|half|quarter|max))?$/.test(candidate)) return null;
  return candidate.startsWith(token) ? token : null;
}

export function createAnalyst({ completeAI, maxPerMinute = 10, persona = "", now = Date.now }) {
  if (typeof completeAI !== "function") {
    throw new Error("createAnalyst requires a completeAI function");
  }
  const stats = { calls: 0, fallbacks: 0, skipped: 0 };
  const callTimes = [];

  // Sliding one-minute window, separate from the reply path's key rotation:
  // even at full burst, judgments consume at most ~8% of a 3-key pool.
  function tryBudget() {
    const cutoff = now() - 60_000;
    while (callTimes.length && callTimes[0] <= cutoff) callTimes.shift();
    if (callTimes.length >= maxPerMinute) return false;
    callTimes.push(now());
    return true;
  }

  function personaBlock() {
    return persona.trim() ? `## Who she is\n${persona.trim()}` : "";
  }

  // groups: [{ herText, reactions: [{ emoji, who }] }] — reactions across all
  // groups are numbered in one flat sequence. Returns one sanitized result per
  // reaction (same order), or null when anything went wrong (caller falls back
  // to the deterministic heart rule).
  async function interpretReactions({ groups, contextLines = "", peopleNotes = "" }) {
    const flat = [];
    const sections = [];
    for (const group of groups || []) {
      const herText = String(group?.herText || "").trim()
        ? `"${String(group.herText).trim().slice(0, 280)}"`
        : "(her message text is no longer available)";
      const lines = (group?.reactions || []).map((reaction) => {
        flat.push({ emoji: reaction.emoji, who: reaction.who });
        return `${flat.length}. ${reaction.emoji} by ${reaction.who}`;
      }).join("\n");
      if (lines) sections.push(`### Her message that got reactions\n${herText}\n\n### Reactions on it\n${lines}`);
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
              "Interpret the emoji reactions people left on her Discord messages. She never sees this judgment — it tunes how the reaction makes her feel and what she remembers about the person.",
              personaBlock(),
              sections.join("\n\n"),
              `## Recent conversation in that channel (oldest first)\n${contextLines || "(nothing recent)"}`,
              `## What she knows about who reacted\n${peopleNotes || "(all strangers so far)"}`,
              [
                "## Rules",
                '- "meaning": 3-8 words for what the reaction really means in context (e.g. "flirty teasing", "genuine gratitude", "mock outrage").',
                '- "romance_weight": 0 to 1 — how much romantic affection the reaction carries IN CONTEXT. 0 when it is friendly, ironic or thanks for help. A heart on her flirty joke is not a heart on a homework answer.',
                '- "react_back": true only when this reaction deserves a small mirrored emoji added to her own message — a sweet or flirty moment, not every reaction.',
                '- "react_emoji": the single unicode emoji to mirror (e.g. "💜"), only when react_back is true, otherwise "".',
                '- "note": one short third-person sentence (max 100 chars) recording what this meant between her and the person, or "" when unremarkable.',
              ].join("\n"),
              `## Output (strict JSON, exactly ${flat.length} entries, same order as the numbered reactions)`,
              '{"reactions":[{"meaning":"flirty teasing","romance_weight":0.6,"react_back":true,"react_emoji":"💜","note":"Ren flirts right after her joke"}]}',
            ].filter(Boolean).join("\n\n"),
          },
        ],
        thinking: false,
        maxTokens: 400,
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

  // Decides whether she should send ONE spectator comment about a bot-game
  // moment (someone won/lost/bet big), and optionally which word triggered the
  // game bot's panel. Returns { speak, line, reason, learnedCommand } or null.
  async function judgeGameMoment({ channelLabel = "game channel", gameBotName = "the game bot", lines = "", triggerCandidate = "" }) {
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
              `She is watching people play a Discord bot game (${gameBotName}). Decide whether she should send ONE short spectator comment about what just happened.`,
              personaBlock(),
              `## Channel\n#${channelLabel} — a bot-game channel`,
              `## What just happened (oldest first)\n${lines || "(no recent lines)"}`,
              triggerCandidate
                ? `## The human message sent right before the game bot's panel\n"${triggerCandidate}"`
                : "",
              [
                "## Rules",
                '- "speak": true ONLY if there is a genuinely fun moment worth one comment — a big win, an epic loss, someone going all-in, playful drama between the players. When in doubt, false. She does not play, does not run commands, does not offer advice.',
                '- "line": the one comment, max 200 characters, first person, in her own voice. Teasing, warm, human. At most one emoji. Never a game command, never advice, never mention being an AI.',
                '- "reason": max 80 chars, why she should or should not speak.',
                '- "learned_command": if the human message right before the game panel was clearly the command that triggered it (like "whl" or "daily"), output that exact command word. Otherwise "".',
              ].join("\n"),
              '## Output (strict JSON)\n{"speak":true,"line":"ren just bet the whole paycheck again 💀","reason":"all-in after a losing streak","learned_command":"whl"}',
            ].filter(Boolean).join("\n\n"),
          },
        ],
        thinking: false,
        maxTokens: 300,
        temperature: 0.8,
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
    const line = cleanText(parsed.line, 200);
    const speak = parsed.speak === true && Boolean(line);
    return {
      speak,
      line: speak ? line : "",
      reason: cleanText(parsed.reason, 120),
      learnedCommand: validLearnedCommand(triggerCandidate, parsed.learned_command),
    };
  }

  return { interpretReactions, judgeGameMoment, stats };
}
