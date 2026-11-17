import test from "node:test";
import assert from "node:assert/strict";
import {
  pickAutonomousReaction,
  pickCurrentMood,
  shouldConsiderAutonomousReaction,
} from "../src/autonomy.js";

test("autonomous mood and reaction heuristics adapt naturally", () => {
  const mood = pickCurrentMood(new Date("2026-11-17T03:00:00Z"));
  assert.equal(typeof mood, "string");
  assert.ok(mood.length > 0);
  assert.equal(pickAutonomousReaction("bro that play was insane fire"), "🔥");
  assert.equal(pickAutonomousReaction("lmao i am dead"), "💀");
});

test("shouldConsiderAutonomousReaction skips bots, game commands, and tiny messages", () => {
  assert.equal(shouldConsiderAutonomousReaction({ isBot: true, isGameCmd: false, contentLength: 50, chance: 1, roll: 0 }), false);
  assert.equal(shouldConsiderAutonomousReaction({ isBot: false, isGameCmd: true, contentLength: 50, chance: 1, roll: 0 }), false);
  assert.equal(shouldConsiderAutonomousReaction({ isBot: false, isGameCmd: false, contentLength: 3, chance: 1, roll: 0 }), false);
  assert.equal(shouldConsiderAutonomousReaction({ isBot: false, isGameCmd: false, contentLength: 24, chance: 0.25, roll: 0.1 }), true);
});
