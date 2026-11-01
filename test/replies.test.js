import test from "node:test";
import assert from "node:assert/strict";
import { isAddressedToBot, isReplyIdentityQuestion, pickIdentityAnswer, replyAuthorsAgree, shouldResolveReplyTarget } from "../src/replies.js";

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
