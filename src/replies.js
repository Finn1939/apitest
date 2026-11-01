export function isReplyIdentityQuestion(prompt) {
  const normalized = prompt.toLowerCase().trim();
  return /^(?:who(?:'s|s|\s+is|\s+are)?\s+(?:this|that|now)|who(?:\s+am)?\s+i(?:'m)?\s+replying\s+to|which\s+(?:message|person|bot)\s+(?:am\s+i\s+)?replying\s+to)\s*[?!.]?$/.test(normalized)
    || /^now\s+who\s*[?!.]?$/.test(normalized)
    || /^how(?:\s+about| bout)?\s+now\s*[?!.]?$/.test(normalized);
}
