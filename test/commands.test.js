import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/commands.js";

test("parses the configured prefix", () => {
  assert.equal(parseCommand("t hey whats the definition of tweak?", "t"), "hey whats the definition of tweak?");
});

test("does not parse unrelated text", () => {
  assert.equal(parseCommand("what does tweak mean?", "t"), null);
});

test("accepts a prefix with whitespace", () => {
  assert.equal(parseCommand("task hi there", "task"), "hi there");
});
