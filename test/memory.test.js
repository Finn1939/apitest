import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACT_LIMIT,
  addFact,
  addHistory,
  loadMemory,
  parseRememberCommand,
  saveMemory,
} from "../src/memory.js";

test("limits channel history to the newest entries", () => {
  const history = Array.from({ length: 35 }, (_, index) => ({ role: "user", content: String(index) }));
  assert.deepEqual(addHistory(history, { role: "assistant", content: "new" }), [
    ...Array.from({ length: 29 }, (_, index) => ({ role: "user", content: String(index + 6) })),
    { role: "assistant", content: "new" },
  ]);
});

test("deduplicates and limits remembered facts", () => {
  const facts = Array.from({ length: FACT_LIMIT }, (_, index) => `fact ${index}`);
  assert.deepEqual(addFact(facts, "fact 99"), facts);

  const expanded = addFact(facts, "fact 100");
  assert.equal(expanded.length, FACT_LIMIT);
  assert.equal(expanded.at(-1), "fact 100");
});

test("parses explicit remember commands", () => {
  assert.equal(parseRememberCommand("remember that Alex likes the banana joke"), "Alex likes the banana joke");
  assert.equal(parseRememberCommand("remember: Mike always says no worries"), "Mike always says no worries");
});

test("persists conversation history and facts across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-memory-"));
  const filePath = join(directory, "memory.json");
  const conversations = new Map([["channel-1", [{ role: "user", content: "hello" }]]]);
  const facts = new Map([["channel-1", ["Alex likes banana jokes"]]]);

  saveMemory(conversations, facts, filePath);
  const restored = loadMemory(filePath);

  assert.deepEqual(restored.conversations.get("channel-1"), [{ role: "user", content: "hello" }]);
  assert.deepEqual(restored.facts.get("channel-1"), ["Alex likes banana jokes"]);
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).facts["channel-1"], ["Alex likes banana jokes"]);
  rmSync(directory, { recursive: true });
});
