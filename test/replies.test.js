import test from "node:test";
import assert from "node:assert/strict";
import { detectIntimacy, isAddressedToBot, isDuplicateReply, isGameCommand, isReplyIdentityQuestion, normalizeReplyForDup, pickIdentityAnswer, replyAuthorsAgree, shouldResolveReplyTarget, SPONTANEOUS_OPENERS } from "../src/replies.js";

test("recognizes follow-up reply identity questions", () => {
  assert.equal(isReplyIdentityQuestion("how about now?"), true);
  assert.equal(isReplyIdentityQuestion("how bout now?"), true);
  assert.equal(isReplyIdentityQuestion("now who?"), true);
  assert.equal(isReplyIdentityQuestion("who am I replying to?"), true);
  assert.equal(isReplyIdentityQuestion("who is dis"), true);
  assert.equal(isReplyIdentityQuestion("how about this one"), true);
  assert.equal(isReplyIdentityQuestion("how bout that one"), true);
  assert.equal(isReplyIdentityQuestion("and this one?"), true);
  assert.equal(isReplyIdentityQuestion("and this?"), true);
  assert.equal(isReplyIdentityQuestion("this one?"), true);
});

test("recognizes direct address without a mention or reply", () => {
  assert.equal(isAddressedToBot("Teacher-san, can you help me?", { botUsername: "teacher-san" }), true);
  assert.equal(isAddressedToBot("what do you think?", { botUsername: "teacher-san" }), true);
  assert.equal(isAddressedToBot("can you hear me?"), true);
  assert.equal(isAddressedToBot("sprite vodka is telling a story"), false);
  assert.equal(isAddressedToBot("and this one?", { recentBotMessage: true }), true);
  assert.equal(isAddressedToBot("what happened next", { recentBotMessage: true }), false);
});

test("refuses conflicting Discord reply authors", () => {
  assert.equal(replyAuthorsAgree(["user-a", "user-a"]), true);
  assert.equal(replyAuthorsAgree(["user-a", "user-b"]), false);
  assert.equal(replyAuthorsAgree([undefined, "user-a"]), true);
});

test("only resolves reply targets when it can change the outcome", () => {
  // Game-channel chatter: never pay the API cost.
  assert.equal(shouldResolveReplyTarget({ hasReference: true, mentioned: false, addressed: false, engaged: false, isCommand: false }), false);
  // Mention, heuristic address, or an ongoing conversation: worth resolving.
  assert.equal(shouldResolveReplyTarget({ hasReference: true, mentioned: true, addressed: false, engaged: false, isCommand: false }), true);
  assert.equal(shouldResolveReplyTarget({ hasReference: true, mentioned: false, addressed: true, engaged: false, isCommand: false }), true);
  assert.equal(shouldResolveReplyTarget({ hasReference: true, mentioned: false, addressed: false, engaged: true, isCommand: false }), true);
  // Prefix commands never use the reply target, and no reference means nothing to do.
  assert.equal(shouldResolveReplyTarget({ hasReference: true, mentioned: true, addressed: false, engaged: false, isCommand: true }), false);
  assert.equal(shouldResolveReplyTarget({ hasReference: false, mentioned: true, addressed: false, engaged: false, isCommand: false }), false);
});

test("identity answers use the live bot name and verified target only", () => {
  // Self-reply must use the real username, never a hardcoded persona name.
  for (let i = 0; i < 10; i += 1) {
    const self = pickIdentityAnswer({ isSelf: true, authorName: "teacher-san", content: "" }, "nightbot");
    assert.ok(self.includes("nightbot"), `self answer must contain the live username: ${self}`);
    assert.ok(!self.includes("Teacher-san"), `self answer must not hardcode a persona name: ${self}`);
  }
  // Other target: names the verified author, optionally quotes their message.
  const other = pickIdentityAnswer({ isSelf: false, authorName: "OwO", content: "you have 135,000 cowoncy" }, "nightbot");
  assert.ok(other.includes("OwO"));
  assert.ok(other.includes("cowoncy"));
  // Unknown target: admits it instead of guessing.
  const unknown = pickIdentityAnswer(null, "nightbot");
  assert.ok(/can't/i.test(unknown));
});

test("game commands are recognized across bot games", () => {
  // Karuta-style (existing behavior).
  assert.equal(isGameCommand("k"), true);
  assert.equal(isGameCommand("kl"), true);
  assert.equal(isGameCommand("daily"), true);
  assert.equal(isGameCommand("wishlist"), true);
  // OwO / Dank style seen live in the casino: bare commands and wagers.
  assert.equal(isGameCommand("balance"), true);
  assert.equal(isGameCommand("Balance."), true);
  assert.equal(isGameCommand("wcf 655"), true);
  assert.equal(isGameCommand("WCF 10000"), true);
  assert.equal(isGameCommand("bet all"), true);
  assert.equal(isGameCommand("cf 50"), true);
  assert.equal(isGameCommand("slot 10"), true);
  // Conversation that must NOT be swallowed by the game filter.
  assert.equal(isGameCommand("we hate you"), false);
  assert.equal(isGameCommand("we dont like you"), false);
  assert.equal(isGameCommand("how about my balance"), false);
  assert.equal(isGameCommand("can you help me with slots"), false);
  assert.equal(isGameCommand("bet you can't do it"), false);
});

test("verbatim repeats of her own last reply are flagged", () => {
  // The live failure: the same line re-sent to three consecutive @mentions.
  const first = "...really? 🐾 I just said I don't like that, c'mon.";
  const repeat = "...REALLY?? I just said I don't like that, c'mon!! (edited)";
  assert.equal(isDuplicateReply(repeat, first), true);
  assert.equal(isDuplicateReply(first, repeat), true);
  // Short reactions may repeat naturally; never flag them.
  assert.equal(isDuplicateReply("ok", "ok"), false);
  assert.equal(isDuplicateReply("lmao same tbh", "lmao same tbh"), false);
  // Genuinely different replies are not duplicates.
  assert.equal(isDuplicateReply("ugh why are you like this, seriously", first), false);
  assert.equal(isDuplicateReply(null, first), false);
  // Normalization strips punctuation, emoji and case.
  assert.equal(
    normalizeReplyForDup("...really? 🐾 I just said I DON'T like that, c'mon."),
    "really i just said i don t like that c mon",
  );
});

test("spontaneous openers give her distinct angles", () => {
  // Every opener used to be the same one-liner, so openings felt samey.
  assert.ok(SPONTANEOUS_OPENERS.length >= 4, "need at least four distinct opener angles");
  assert.equal(new Set(SPONTANEOUS_OPENERS).size, SPONTANEOUS_OPENERS.length, "openers must be distinct");
  for (const opener of SPONTANEOUS_OPENERS) {
    assert.ok(opener.length > 20 && opener.length < 160, `opener should be one short instruction: ${opener}`);
  }
});

test("intimacy signals are detected conservatively", () => {
  // Deep romantic signals aimed at her (English + Tagalog + emoji).
  for (const text of ["i love you", "ily", "labyu", "love you so muchhh", "mahal kita", "miss you na", "you're so cute", "cute mo", "ganda mo", "be my gf", "marry me pls", "❤️", "🥰", "mwah", "you're mine", "i need you"]) {
    const hit = detectIntimacy(text);
    assert.ok(hit, `should register as intimacy: ${text}`);
    assert.equal(hit.weight, 1, `should be a deep signal: ${text}`);
  }
  // Light emotional closeness.
  for (const text of ["you're the best", "ur amazing", "i trust you", "can i tell you something", "you always make me laugh", "i'm sad rn", "you're the only one who listens"]) {
    const hit = detectIntimacy(text);
    assert.ok(hit, `should register as intimacy: ${text}`);
    assert.equal(hit.weight, 0.4, `should be a light signal: ${text}`);
  }
  // Never romance: normal chat, game traffic, affection for other things.
  for (const text of ["we hate you", "wcf 655", "balance", "k", "i love this song", "family time", "gm guys", "idc", "how about my balance", "the lab you were in", "i need you to help me with this", "can you help me with slots"]) {
    assert.equal(detectIntimacy(text), null, `must NOT register as intimacy: ${text}`);
  }
});
