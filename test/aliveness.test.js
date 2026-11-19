import test from "node:test";
import assert from "node:assert/strict";

import { splitDiscordMessage } from "../src/aliveness.js";

test("splitDiscordMessage preserves long replies while respecting Discord's limit", () => {
  const text = `first paragraph\n${"word ".repeat(600)}`;
  const chunks = splitDiscordMessage(text, 80);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
  assert.equal(chunks.join(""), text);
});

test("splitDiscordMessage handles unbroken text", () => {
  assert.deepEqual(splitDiscordMessage("x".repeat(25), 10), [
    "x".repeat(10),
    "x".repeat(10),
    "x".repeat(5),
  ]);
});
