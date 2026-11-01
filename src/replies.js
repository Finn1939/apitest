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
