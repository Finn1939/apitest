import test from "node:test";
import assert from "node:assert/strict";
import { FACT_LIMIT, addFact, addHistory, parseRememberCommand } from "../src/memory.js";

test("limits channel history to the newest entries", () => {
  const history = Array.from({ length: 35 }, (_, index) => ({ role: "user", content: String(index) }));
  assert.deepEqual(addHistory(history, { role: "assistant", content: "new" }), [
    ...Array.from({ length: 29 }, (_, index) => ({ role: "user", content: String(index + 6) })),
    { role: "assistant", content: "new" },
  ]);
});

test("deduplicates and limits remembered facts", () => {
  const facts = Array.from({ length: FACT_LIMIT }, (_, index) => `fact ${index}`);
  assert.deepEqual(addFact(facts, "fact 19"), facts);

  const expanded = addFact(facts, "fact 20");
  assert.equal(expanded.length, FACT_LIMIT);
  assert.equal(expanded.at(-1), "fact 20");
});

test("parses explicit remember commands", () => {
  assert.equal(parseRememberCommand("remember that Alex likes the banana joke"), "Alex likes the banana joke");
  assert.equal(parseRememberCommand("remember: Mike always says no worries"), "Mike always says no worries");
});
