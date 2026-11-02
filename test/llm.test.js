import test from "node:test";
import assert from "node:assert/strict";
import { createThinkFilter } from "../src/llm.js";
import { config } from "../src/config.js";

// Feeds a list of chunks through a fresh filter and returns everything it
// emitted, concatenated — what Discord would have shown.
function stream(chunks) {
  const filter = createThinkFilter();
  return chunks.map((c) => filter.push(c)).join("");
}

test("plain replies pass through untouched once the opening is long enough", () => {
  assert.equal(stream(["Cash out now, that's 1,131 free shards."]),
    "Cash out now, that's 1,131 free shards.");
});

test("short openings are held until the stream can be classified", () => {
  // "Hi!" is under the threshold: the first push emits nothing, the second
  // decides it is a normal answer and releases everything.
  assert.equal(stream(["Hi!"]), "");
  assert.equal(stream(["Hi!", " what's up?"]), "Hi! what's up?");
});

test("a leading think block is stripped and never shown", () => {
  // One push containing the whole think block, answer in the next push.
  const shown = stream([
    "<think>Mild reasoning first, card is a 9, streak 2, they should cash out.</think>",
    "Cash out now, that's 1,131 free shards.",
  ]);
  assert.equal(shown, "Cash out now, that's 1,131 free shards.");
});

test("think tags split across chunk boundaries are still handled", () => {
  // The opening tag itself is split, and so is the closing tag.
  const shown = stream([
    "<th", "ink>should she go higher? no, cash out is clearly right",
    "</th", "ink>take the cash out — 1,131 up front beats the gamble.",
  ]);
  assert.equal(shown, "take the cash out — 1,131 up front beats the gamble.");
});

test("whitespace around reasoning is not leaked", () => {
  const shown = stream([
    "  <think>  \n\nCard analysis: streak 2 is the sweet spot.  </think>\n\n",
    "Cash out now, that's 1,131 free shards.\n",
  ]);
  assert.equal(shown, "Cash out now, that's 1,131 free shards.\n");
});

test("an unterminated think block emits nothing at all", () => {
  // Truncated mid-reasoning: better silence on Discord than inner monologue.
  assert.equal(stream(["<think> she wanted the higher payout but the odds say cash out"]), "");
});

test("normal text that merely contains the word think passes through", () => {
  // Deep in the message, past the opening: never re-entered skip mode.
  assert.equal(
    stream(["I think you should cash out, the multiplier is already great."]),
    "I think you should cash out, the multiplier is already great.",
  );
});

test("reply quality knobs exist with sane defaults", () => {
  assert.equal(config.replyThinking, true);
  assert.equal(config.replyTemperature, 0.7);
  assert.equal(config.replyMaxTokens, 1024);
});
