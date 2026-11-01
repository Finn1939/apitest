import test from "node:test";
import assert from "node:assert/strict";
import { isReplyIdentityQuestion } from "../src/replies.js";

test("recognizes follow-up reply identity questions", () => {
  assert.equal(isReplyIdentityQuestion("how about now?"), true);
  assert.equal(isReplyIdentityQuestion("how bout now?"), true);
  assert.equal(isReplyIdentityQuestion("now who?"), true);
  assert.equal(isReplyIdentityQuestion("who am I replying to?"), true);
  assert.equal(isReplyIdentityQuestion("how about this one"), true);
  assert.equal(isReplyIdentityQuestion("how bout that one"), true);
  assert.equal(isReplyIdentityQuestion("and this one?"), true);
  assert.equal(isReplyIdentityQuestion("this one?"), true);
});
