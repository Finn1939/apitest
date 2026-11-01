import test from "node:test";
import assert from "node:assert/strict";
import { isAddressedToBot, isReplyIdentityQuestion, replyAuthorsAgree } from "../src/replies.js";

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
