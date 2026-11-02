import test from "node:test";
import assert from "node:assert/strict";
import { createThinkFilter, streamReply } from "../src/llm.js";
import { keyPool } from "../src/keys.js";
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

// --- filter.end(): what happens to held text when a stream finishes ----------
// A reply shorter than the 7-char classification threshold ("ok", "lol",
// "nya~") is still in the hold buffer when the stream ends. It used to be
// lost there and the whole reply looked like an empty stream.

test("a short reply held at stream end is released, not lost", () => {
  const filter = createThinkFilter();
  assert.equal(filter.push("ok"), "");
  assert.equal(filter.end(), "ok");
});

test("nya~ and lol survive too", () => {
  for (const reply of ["nya~", "lol", "haha"]) {
    const filter = createThinkFilter();
    filter.push(reply);
    assert.equal(filter.end(), reply);
  }
});

test("a truncated think tag at stream end stays suppressed", () => {
  const filter = createThinkFilter();
  assert.equal(filter.push("<th"), "");
  assert.equal(filter.end(), "");
});

test("whitespace-only holds release nothing", () => {
  const filter = createThinkFilter();
  filter.push("   ");
  assert.equal(filter.end(), "");
});

test("an unterminated think block still emits nothing at stream end", () => {
  const filter = createThinkFilter();
  filter.push("<think>reasoning that never got closed");
  assert.equal(filter.end(), "");
});

// --- streamReply: empty streams retry with escalation ------------------------
// A stream can complete with NOTHING user-visible: with thinking on, the
// reasoning can eat the whole max_tokens budget (finish_reason "length") or
// land entirely in a separate reasoning field. That must retry — and each
// retry escalates so it actually fixes the cause instead of repeating it.

// Builds a mock key-pool entry whose client streams the given chunk shapes.
// A chunk is { content } for visible text, { reasoning } for a separate
// reasoning field, and/or { finish } for finish_reason.
function mockPool(streamsPerAttempt) {
  const calls = [];
  let attempt = 0;
  const entry = {
    label: "test key",
    client: {
      chat: {
        completions: {
          async create(params) {
            calls.push(params);
            const chunks = streamsPerAttempt[Math.min(attempt, streamsPerAttempt.length - 1)];
            attempt += 1;
            let i = 0;
              return {
              async *[Symbol.asyncIterator]() {
                while (i < chunks.length) {
                  const chunk = chunks[i++];
                  yield {
                    choices: [{
                      delta: {
                        ...(chunk.content !== undefined ? { content: chunk.content } : {}),
                        ...(chunk.reasoning !== undefined ? { reasoning_content: chunk.reasoning } : {}),
                      },
                      ...(chunk.finish ? { finish_reason: chunk.finish } : {}),
                    }],
                  };
                }
              },
            };
          },
        },
      },
    },
  };
  const originalAcquire = keyPool.acquire;
  keyPool.acquire = async () => entry;
  return { calls, restore: () => { keyPool.acquire = originalAcquire; } };
}

test("a reasoning-only stream retries with a doubled budget and succeeds", async () => {
  const { calls, restore } = mockPool([
    // Attempt 0: everything in the reasoning field, budget exhausted.
    [{ reasoning: "analyzing the photo: it's a HighLow panel, card 9, streak 2..." }, { finish: "length" }],
    // Attempt 1: thinking fit, answer arrives.
    [{ reasoning: "shorter pass" }, { content: "That's a HighLow panel — card 9, streak 2. Cash out, the 1,131 is guaranteed." }, { finish: "stop" }],
  ]);
  try {
    const deltas = [];
    const answer = await streamReply({ messages: [], onDelta: (d) => deltas.push(d) });
    assert.equal(answer, "That's a HighLow panel — card 9, streak 2. Cash out, the 1,131 is guaranteed.");
    assert.ok(deltas.length >= 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].max_tokens, 1024); // configured default
    assert.equal(calls[0].chat_template_kwargs.enable_thinking, true);
    // First retry: budget doubled so thinking + answer both fit.
    assert.equal(calls[1].max_tokens, 2048);
    assert.equal(calls[1].chat_template_kwargs.enable_thinking, true);
  } finally {
    restore();
  }
});

test("two empty streams force a direct answer with thinking off", async () => {
  const { calls, restore } = mockPool([
    [{ reasoning: "starved again" }, { finish: "length" }],
    [{ reasoning: "still starved" }, { finish: "length" }],
    [{ content: "lmaooo ok fine, cash out" }, { finish: "stop" }],
  ]);
  try {
    const answer = await streamReply({ messages: [] });
    assert.equal(answer, "lmaooo ok fine, cash out");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].max_tokens, 3072); // doubled twice, capped
    assert.equal(calls[2].chat_template_kwargs.enable_thinking, false); // must answer directly
  } finally {
    restore();
  }
});

test("a configured large budget is never lowered by the ladder", async () => {
  const { calls, restore } = mockPool([
    [{ reasoning: "empty" }, { finish: "length" }],
    [{ content: "answer" }, { finish: "stop" }],
  ]);
  try {
    const answer = await streamReply({ messages: [], maxTokens: 4096 });
    assert.equal(answer, "answer");
    assert.equal(calls[0].max_tokens, 4096);
    assert.equal(calls[1].max_tokens, 4096); // max(4096, min(8192, 3072)) stays 4096
  } finally {
    restore();
  }
});

test("all attempts empty throws a descriptive retry error", async () => {
  const { calls, restore } = mockPool([
    [{ reasoning: "nothing" }, { finish: "length" }],
  ]);
  try {
    await assert.rejects(
      () => streamReply({ messages: [] }),
      (error) => {
        assert.match(error.message, /NVIDIA streaming failed after retries/);
        assert.match(error.message, /no visible content/);
        assert.match(error.message, /finish_reason=length/);
        return true;
      },
    );
    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});

test("a healthy stream still succeeds on the first attempt, untouched", async () => {
  const { calls, restore } = mockPool([
    [
      { reasoning: "odds check: cash out at 1,131 is clearly right" },
      { content: "Cash out now, that's 1,131 free shards." },
      { finish: "stop" },
    ],
  ]);
  try {
    const answer = await streamReply({ messages: [] });
    assert.equal(answer, "Cash out now, that's 1,131 free shards.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].max_tokens, 1024);
    assert.equal(calls[0].chat_template_kwargs.enable_thinking, true);
  } finally {
    restore();
  }
});

test("a stream whose only visible output is a short held reply does not retry", async () => {
  const { calls, restore } = mockPool([
    [{ content: "ok" }, { finish: "stop" }],
  ]);
  try {
    const answer = await streamReply({ messages: [] });
    assert.equal(answer, "ok"); // released by filter.end(), no retry needed
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("an aborted stream rethrows without retrying", async () => {
  const originalAcquire = keyPool.acquire;
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  let createCalls = 0;
  keyPool.acquire = async () => ({
    label: "test key",
    client: { chat: { completions: { async create() {
      createCalls += 1;
      throw abortError;
    } } } },
  });
  try {
    await assert.rejects(() => streamReply({ messages: [] }), (error) => error.name === "AbortError");
    assert.equal(createCalls, 1);
  } finally {
    keyPool.acquire = originalAcquire;
  }
});
