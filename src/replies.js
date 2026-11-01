export function isReplyIdentityQuestion(prompt) {
  const normalized = prompt.toLowerCase().trim();
  return /^(?:who(?:'s|s|\s+is|\s+are)?\s+(?:this|that|now)|who(?:\s+am)?\s+i(?:'m)?\s+replying\s+to|which\s+(?:message|person|bot)\s+(?:am\s+i\s+)?replying\s+to)\s*[?!.]?$/.test(normalized)
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
