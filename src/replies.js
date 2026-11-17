const GAME_COMMAND_PREFIXES = /^(?:owo|o|w|k|kd|kc|kl|kv|kt|ku|kci|kwi|km|kmt|ktc|pls|m|mudae|wa|wg|wh|wx|ha|hg|hx|ma|mg|mx|tu|dk|rt|daily|claim|roll|rolls|flip|cf|coinflip|bj|blackjack|hl|highlow|slots|hunt|battle|pray|curse|sell|shop|inv|inventory|bal|balance|cash|profile|p|lb|leaderboard|quest|quests|checklist|cl|vote|pet|zoo|fish|mine|work|beg|dig|crime|rob|heist|steal|gamble|bet|duel|b|fight|attack|train|upgrade|whl)\b/i;

export const learnedGameCommands = new Set();

export function isGameCommand(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed || trimmed.length > 48) return false;
  if (GAME_COMMAND_PREFIXES.test(trimmed)) return true;
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() || "";
  return learnedGameCommands.has(firstWord);
}

export function isAddressedToBot(content, { botUsername = "", recentBotMessage = false } = {}) {
  const text = String(content || "").trim();
  if (!text) return false;
  if (/\bcapri\b/i.test(text)) return true;
  if (botUsername && new RegExp(`\\b${botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
    return true;
  }
  if (recentBotMessage && text.length >= 4 && !isGameCommand(text)) return true;
  return false;
}

export function parseChannelRenameClaim(content) {
  const text = String(content || "");
  const channelId = text.match(/<#(\d{17,20})>/)?.[1];
  const newName = text.match(/(?:->|\bis now\b|\brenamed\s+to\b|\bchanged\s+to\b)\s*#?([a-z0-9][a-z0-9_-]{0,99})/i)?.[1];
  if (!channelId || !newName || !/\b(?:rename|renamed|is now|changed to)\b/i.test(text)) return null;
  return { channelId, newName };
}

export function isChannelRenameChallenge(content) {
  return /\b(?:still\s+(?:no|not)\b|didn['’]?t\s+(?:change|work|rename)\b|did\s+not\s+(?:change|work|rename)\b|hasn['’]?t\s+changed\b|not\s+changed\b|not\s+working\b)/i.test(String(content || ""));
}

export function formatReactionSummary(entries) {
  const seen = new Set();
  const parts = [];
  for (const entry of entries || []) {
    if (!entry?.emoji || !entry?.userName) continue;
    const key = `${entry.emoji}|${entry.userName}|${entry.meaning || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (parts.length < 8) {
      parts.push(entry.meaning
        ? `${entry.emoji} from ${entry.userName} — ${entry.meaning}`
        : `${entry.emoji} from ${entry.userName}`);
    }
  }
  return parts.join("; ");
}

export function normalizeReplyForDup(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDuplicateReply(candidate, previous) {
  const a = normalizeReplyForDup(candidate);
  const b = normalizeReplyForDup(previous);
  if (!a || !b) return false;
  if (a.length < 20 || b.length < 20) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const extra = (long.length - short.length) / short.length;
  return extra <= 0.2 && (long.startsWith(short) || long.endsWith(short));
}

export const SPONTANEOUS_OPENERS = [
  "React to the general vibe of the channel right now.",
  "Drop a sharp, curious question to see who is actually awake.",
  "Follow up on something someone brought up earlier.",
  "Share a quick passing thought like a real friend texting the group chat.",
  "Tease the room lightly about whatever they were last arguing or joking about.",
  "Drop a random hot take and see who takes the bait.",
];

export const CONTEXT_GROUNDING = [
  "Before answering, ground yourself in what you were just given, in this order:",
  "1. If they replied to or pointed at a specific message, THAT message is the topic. Read attached images, audio, video, files, embeds, or game panels directly.",
  "2. <server_knowledge> and the live channel snapshot are real-time ground truth — use them directly for members, roles, channels, and voice presence.",
  "3. Your memory block is real knowledge — recall people, facts, and past context naturally.",
  "4. If server actions were just executed for this message, ground your reply strictly in the verified execution outcomes — never claim unexecuted steps succeeded.",
  "5. NEVER tell anyone to click 'Run these actions' or claim a confirmation button was sent when replying in normal chat — buttons are only attached by the deletion gate.",
].join("\n");

const INTIMACY_DEEP = [
  /\b(?:i\s+)?(?:really\s+|so\s+)?(?:love|luv)\s*(?:you|u|ya)\b/i,
  /\b(?:labyu|ilabyu|lab\s*u|labyou|ily)\b/i,
  /\bmiss\s*(?:you|u|kita|na\s*kita)\b/i,
  /\byou'?re\s+(?:so\s+|really\s+|very\s+)?(?:cute|pretty|beautiful|gorgeous|adorable)\b/i,
  /\b(?:cute|ganda)\s+mo\b/i,
  /\b(?:be\s+my|my)\s+(?:gf|girlfriend|waifu|wife)\b/i,
  /\bmarry\s+me\b/i,
  /❤|💕|💖|💗|💓|💘|🥰|😍|💌|😘|mwah|xoxo/i,
  /\bmahal\s+(?:kita|na\s*kita)\b/i,
];

const INTIMACY_LIGHT = [
  /\b(?:you'?re|ur)\s+(?:the\s+best|amazing|my\s+(?:favorite|favourite))\b/i,
  /\bi\s+trust\s+(?:you|u)\b/i,
  /\bcan\s+i\s+(?:tell\s+you|confess)\b/i,
  /\byou\s+(?:always\s+)?(?:make|made)\s+me\s+(?:smile|laugh|happy)\b/i,
  /\b(?:stay\s+with\s+me|don'?t\s+leave\s+me)\b/i,
  /\bi'?m\s+(?:sad|lonely|down|not\s+okay|not\s+ok)\b/i,
];

export function detectIntimacy(text) {
  const value = String(text || "");
  if (!value.trim()) return null;
  for (const pattern of INTIMACY_DEEP) {
    const match = value.match(pattern);
    if (match) return { weight: 1, signal: match[0] };
  }
  for (const pattern of INTIMACY_LIGHT) {
    const match = value.match(pattern);
    if (match) return { weight: 0.4, signal: match[0] };
  }
  return null;
}

const POINTING_RE = /^(?:here|this|that|dis|look(?:\s+at)?|check\s+(?:this|that|dis)|see\s+(?:this|that)|peep\s+(?:this|that|dis))\b(?!['’])/i;
export function isPointingAtBot(content) {
  const text = String(content || "").toLowerCase().trim();
  return text.length <= 80 && POINTING_RE.test(text);
}

export function shouldResolveReplyTarget({ hasReference, mentioned, addressed, engaged, isCommand }) {
  if (!hasReference || isCommand) return false;
  return Boolean(mentioned || addressed || engaged);
}

export function pickIdentityAnswer(replyTarget, selfName = "Capri") {
  if (!replyTarget) {
    return "I can't see that message anymore — might have been wiped.";
  }
  if (replyTarget.isSelf) {
    return `That one's mine. You're replying to ${selfName}.`;
  }
  const name = replyTarget.authorName || "someone";
  const withContent = replyTarget.content ? ` — the one that said "${replyTarget.content.slice(0, 80)}"` : "";
  return `You're replying to ${name}${withContent}.`;
}
