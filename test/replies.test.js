import test from "node:test";
import assert from "node:assert/strict";
import {
  detectIntimacy,
  isAddressedToBot,
  isChannelRenameChallenge,
  isDuplicateReply,
  isGameCommand,
  isPointingAtBot,
  parseChannelRenameClaim,
  pickIdentityAnswer,
} from "../src/replies.js";

test("isAddressedToBot recognizes Capri name, username, and active follow-ups", () => {
  assert.equal(isAddressedToBot("hey capri what's good", { botUsername: "Capri" }), true);
  assert.equal(isAddressedToBot("yeah makes sense", { botUsername: "Capri", recentBotMessage: true }), true);
  assert.equal(isAddressedToBot("whl", { botUsername: "Capri", recentBotMessage: true }), false);
});

test("game command filter catches bot commands and lets normal conversation pass", () => {
  assert.equal(isGameCommand("owo hunt"), true);
  assert.equal(isGameCommand("kd"), true);
  assert.equal(isGameCommand("yo what did everyone eat today"), false);
});

test("rename follow-ups can be tied to the claimed channel and expected name", () => {
  assert.deepEqual(
    parseChannelRenameClaim("Channel's done. <#1567358193334493247> is now #dogpile."),
    { channelId: "1567358193334493247", newName: "dogpile" },
  );
  assert.deepEqual(
    parseChannelRenameClaim("Updated <#1567358193334493247>: renamed #woo -> #dogpile."),
    { channelId: "1567358193334493247", newName: "dogpile" },
  );
  assert.equal(isChannelRenameChallenge("still no"), true);
  assert.equal(isChannelRenameChallenge("it's still not dogpile"), true);
  assert.equal(isChannelRenameChallenge("thanks, that worked"), false);
  assert.equal(parseChannelRenameClaim("Channel renamed successfully."), null);
});

test("dedup catches near-identical long replies while allowing short reactions", () => {
  assert.equal(isDuplicateReply("ok", "ok"), false);
  assert.equal(
    isDuplicateReply("Yeah I already checked #general and nobody's posted since midnight", "yeah i already checked #general and nobody's posted since midnight!"),
    true,
  );
});

test("pointing and intimacy helpers work reliably", () => {
  assert.equal(isPointingAtBot("look at this"), true);
  assert.equal(isPointingAtBot("here's my plan for tonight"), false);
  assert.equal(detectIntimacy("love you capri")?.weight, 1);
  assert.equal(detectIntimacy("i love this song"), null);
  assert.match(pickIdentityAnswer({ authorName: "Alex", isSelf: false, content: "yo" }, "Capri"), /Alex/);
});
