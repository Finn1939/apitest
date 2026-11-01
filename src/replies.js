export function isReplyIdentityQuestion(prompt) {
  const normalized = prompt.toLowerCase().trim();
  return /^(?:who(?:'s|s|\s+is|\s+are)?\s+(?:this|that|now)|who(?:\s+am)?\s+i(?:'m)?\s+replying\s+to|which\s+(?:message|person|bot)\s+(?:am\s+i\s+)?replying\s+to)\s*[?!.]?$/.test(normalized)
    || /^who\s+is\s+(?:dis|dat)\s*[?!.]?$/.test(normalized)
    || /^now\s+who\s*[?!.]?$/.test(normalized)
    || /^how(?:\s+about| bout)?\s+(?:now|this\s+one|that\s+one)\s*[?!.]?$/.test(normalized)
    || /^what(?:\s+about)?\s+(?:this|that)\s+one\s*[?!.]?$/.test(normalized)
    || /^and\s+(?:this|that)\s+one\s*[?!.]?$/.test(normalized)
    || /^and\s+(?:this|that)\s*[?!.]?$/.test(normalized)
    || /^this\s+one\s*[?!.]?$/.test(normalized)
    || /^that\s+one\s*[?!.]?$/.test(normalized);
}

export function isAddressedToBot(content, options = {}) {
  const text = String(content || "").toLowerCase();
  const botNames = [options.botUsername, "teacher-san", "teachersan", "teacher san"]
    .filter(Boolean)
    .map((name) => String(name).toLowerCase());

  if (botNames.some((name) => text.includes(name))) return true;
  if (isReplyIdentityQuestion(content) || /^(?:and\s+)?(?:this|that)\s+one\b/.test(text.trim())) return Boolean(options.recentBotMessage);

  const directSecondPerson = /\b(?:you|your|you're|you've)\b/.test(text);
  if (!directSecondPerson) {
    const directGreeting = /^(?:hey|hi|hello|hiya|yo|thanks?|please)[,! ]/i.test(text.trim());
    return Boolean(options.recentBotMessage && directGreeting);
  }

  const clearlyAddressesAnotherUser = /<@!?\d+>|@[\w-]+/.test(content || "");
  return !clearlyAddressesAnotherUser && (/\?\s*$/.test(text.trim()) || /^(?:please|can you|could you|would you|will you|do you|are you)\b/.test(text.trim()));
}

export function replyAuthorsAgree(authorIds) {
  const resolved = [...new Set(authorIds.filter(Boolean))];
  return resolved.length <= 1;
}

// Whole-message game commands. Karuta's set plus the OwO/Dank-style tokens seen
// in live game channels ("balance", "wcf 655", "bet all"...). They only ever
// match the ENTIRE message, so "my balance is off" stays conversation. Without
// these, game traffic was counted as human conversation and the engagement
// window guaranteed her a reply to every command aimed at OwO or Karuta.
export const GAME_COMMAND_RE = /^(?:k(?:d|l|g|c|u|i|q|t|v|w|m|a)?|dk|grab|drop|burn|daily|vote|inv(?:entory)?|collection|wishlist|worker|observe|bal(?:ance)?|cash|lb|leaderboard|profile|marry|divorce|ship|waifu|hxh|trivia|lottery|work|crime|slots?)$/;
export const GAME_COMMAND_ARG_RE = /^(?:wcf|cf|bet|slot|slots)\s+(?:\d+|all|half|quarter|max)$/;

export function isGameCommand(content) {
  const text = String(content || "").trim().toLowerCase().replace(/[.!]+$/, "");
  return GAME_COMMAND_RE.test(text) || GAME_COMMAND_ARG_RE.test(text);
}

// --- Verbatim self-repetition guard ---------------------------------------
// She used to re-send the exact same reply to near-identical messages ("really?
// I just said I don't like that" three times in a row). These helpers feed both
// the prompt-side rule and the deterministic retry in index.js.
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
  // Short reactions ("ok", "lmao") repeat naturally; never flag them.
  if (a.length < 20 || b.length < 20) return false;
  if (a === b) return true;
  // Near-verbatim: one is the other plus a small tail or head (a stray
  // "(edited)" marker, an extra emoji, a leading "ugh").
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const extra = (long.length - short.length) / short.length;
  return extra <= 0.2 && (long.startsWith(short) || long.endsWith(short));
}

// Rotating angles for her unprompted channel openers. Every opener used to be
// the same one-liner, so her openings all felt the same. One is picked at
// random per spontaneous message and spliced into the prompt — the same idea
// as Character.AI's "alternate greetings".
export const SPONTANEOUS_OPENERS = [
  "React to the general mood of the channel right now.",
  "Ask the channel one light, casual question anyone could answer.",
  "Pick one thing someone said recently and follow up on it.",
  "Share one short thing about your own day or mood, like a friend texting.",
  "Gently tease the channel about whatever they were last talking about.",
  "Drop one random thought or tiny hot take and see who bites.",
];

// --- Romance signal detection ----------------------------------------------
// Feeds the attachment axis (separate from friendship affinity). DEEP signals
// are direct affection aimed at her (weight 1.0); LIGHT signals are emotional
// closeness — opening up, trusting, being made happy (weight 0.4). Detection
// only ever runs on messages already addressed to her, so an "ily" aimed at
// another bot, or general chat, can never count. Whole-phrase patterns with
// word boundaries, so "i love this song" and "family" never match.
const INTIMACY_DEEP = [
  /\b(?:i\s+)?(?:really\s+|so\s+)?(?:love|luv)\s*(?:you|u|ya)\b/i,
  /\b(?:labyu|ilabyu|lab\s*u|labyou)\b/i,
  /\bily\b/i,
  /\bmiss\s*(?:you|u|kita|na\s*kita)\b/i,
  /\byou'?re\s+(?:so\s+|really\s+|very\s+)?(?:cute|pretty|beautiful|gorgeous|adorable)\b/i,
  /\b(?:cute|ganda)\s+mo\b/i,
  /\b(?:be\s+my|my)\s+(?:gf|girlfriend|waifu|wife)\b/i,
  /\bmarry\s+me\b/i,
  /❤|💕|💖|💗|💓|💘|🥰|😍|💌|😘|mwah|xoxo/i,
  /\b(?:you'?re\s+mine|i'?m\s+yours)\b/i,
  /\bi\s+(?:want|need)\s+(?:you|u)\b(?!\s+to\b)/i,
  /\bdate\s+me\b/i,
  /\bmahal\s+(?:kita|na\s*kita)\b/i,
];
const INTIMACY_LIGHT = [
  /\b(?:you'?re|ur)\s+(?:the\s+best|amazing|my\s+(?:favorite|favourite))\b/i,
  /\bi\s+trust\s+(?:you|u)\b/i,
  /\bcan\s+i\s+(?:tell\s+you|confess)\b/i,
  /\byou\s+(?:always\s+)?(?:make|made)\s+me\s+(?:smile|laugh|happy)\b/i,
  /\b(?:stay\s+with\s+me|don'?t\s+leave\s+me)\b/i,
  /\bi'?m\s+(?:sad|lonely|down|not\s+okay|not\s+ok)\b/i,
  /\bthe\s+only\s+one\s+(?:who|that)\b/i,
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

// Resolving a reply target can cost a Discord REST call, so only do it when
// the answer could actually change what the bot does. Game channels are full
// of bot replies that must never trigger API traffic.
export function shouldResolveReplyTarget({ hasReference, mentioned, addressed, engaged, isCommand }) {
  if (!hasReference) return false;
  if (isCommand) return false;
  return Boolean(mentioned || addressed || engaged);
}

// Deterministic, in-character answers for "who am I replying to?" questions.
// The model used to guess from surrounding messages; these answers are built
// only from the verified reply target, so they can never name the wrong bot.
export function pickIdentityAnswer(replyTarget, selfName = "me") {
  if (!replyTarget) {
    const variants = [
      "I can't see the message you replied to anymore, nya... it might have been deleted.",
      "Hmm, I can't verify that reply anymore, sorry~",
    ];
    return variants[Math.floor(Math.random() * variants.length)];
  }
  if (replyTarget.isSelf) {
    const variants = [
      `That's me, ${selfName}~ 🐾`,
      `That one's mine, nya! You're replying to ${selfName}.`,
      `You're replying to me, ${selfName}, ehe~`,
    ];
    return variants[Math.floor(Math.random() * variants.length)];
  }
  const name = replyTarget.authorName || "someone";
  const withContent = replyTarget.content ? ` — the one that said "${replyTarget.content.slice(0, 80)}"` : "";
  const variants = [
    `You're replying to ${name}${withContent}, nya~`,
    `That's ${name}${withContent}!`,
    `${name}, nya~ that's who you replied to${withContent}.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}
