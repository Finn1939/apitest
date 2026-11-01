import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyst, extractJson, validLearnedCommand } from "../src/analysis.js";
import { formatReactionSummary, isGameCommand, learnedGameCommands } from "../src/replies.js";

// Fake completeAI: pops one prepared answer per call (a string, an Error to
// throw, or a function of the request). Records every call for assertions.
function fakeCompleter(responses) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(request);
    return next ?? "";
  };
  fn.calls = calls;
  return fn;
}

const VALID_REACTION = { meaning: "warm thanks", romance_weight: 0.4, react_back: false, react_emoji: "", note: "" };

test("extractJson parses plain, fenced, and dirty JSON answers", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure thing!\n{"a":{"b":2}}\nHope that helps.'), { a: { b: 2 } });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("{broken"), null);
  assert.equal(extractJson("[1,2,3]"), null); // objects only — that is the contract
});

test("reaction interpretation aligns results, clamps weights, sanitizes emoji", async () => {
  const completeAI = fakeCompleter([JSON.stringify({
    reactions: [
      { meaning: "flirty teasing", romance_weight: 0.9, react_back: true, react_emoji: "💜", note: "Ren flirts right after her rent joke" },
      { meaning: "friendly laugh", romance_weight: "0.2", react_back: false, react_emoji: "<:bloblove:123456>", note: "" },
      { meaning: "mock outrage", romance_weight: 7, react_back: false, react_emoji: "", note: "" },
    ],
  })]);
  const analyst = createAnalyst({ completeAI, maxPerMinute: 10, persona: "a teasing teacher" });
  const results = await analyst.interpretReactions({
    groups: [
      { herText: "don't gamble your rent money 💀", reactions: [{ emoji: "❤️", who: "Ren" }, { emoji: "😂", who: "sprite vodka" }] },
      { herText: "", reactions: [{ emoji: "💀", who: "Ren" }] },
    ],
    contextLines: "Ren: whl 500\nOwO: [HighLow]",
    peopleNotes: "- Ren: friendship — a regular she's genuinely fond of",
  });
  assert.equal(results.length, 3);
  assert.equal(results[0].romanceWeight, 0.9);
  assert.equal(results[0].reactBack, true);
  assert.equal(results[0].reactEmoji, "💜");
  assert.ok(results[0].note.includes("rent"));
  assert.equal(results[1].romanceWeight, 0.2); // numeric string coerces
  assert.equal(results[1].reactEmoji, null); // custom Discord emoji rejected
  assert.equal(results[2].romanceWeight, 1); // out-of-range clamps
  // The prompt must carry her message text, the channel context and the bonds.
  const prompt = completeAI.calls[0].messages.map((m) => m.content).join("\n");
  assert.ok(prompt.includes("don't gamble your rent money"));
  assert.ok(prompt.includes("whl 500"));
  assert.ok(prompt.includes("genuinely fond of"));
  assert.ok(prompt.includes("exactly 3 entries"));
});

test("broken judgment output falls back to the deterministic rule", async () => {
  const payload = { groups: [{ herText: "hi", reactions: [{ emoji: "❤️", who: "Ren" }] }] };
  // Response has 1 entry for 2 reactions — misaligned, must fall back.
  const twoReactions = { groups: [{ herText: "hi", reactions: [{ emoji: "❤️", who: "Ren" }, { emoji: "😂", who: "sprite" }] }] };
  const wrongLength = createAnalyst({ completeAI: fakeCompleter(['{"reactions":[{"meaning":"x"}]}']), maxPerMinute: 10 });
  assert.equal(await wrongLength.interpretReactions(twoReactions), null);
  const throwing = createAnalyst({ completeAI: fakeCompleter([new Error("API down")]), maxPerMinute: 10 });
  assert.equal(await throwing.interpretReactions(payload), null);
  const chatty = createAnalyst({ completeAI: fakeCompleter(["I'd rather just chat!"]), maxPerMinute: 10 });
  assert.equal(await chatty.interpretReactions(payload), null);
  assert.equal(throwing.stats.fallbacks, 1);
});

test("judgment calls obey their own per-minute budget", async () => {
  let now = 1_000_000;
  const completeAI = fakeCompleter([
    JSON.stringify({ reactions: [VALID_REACTION] }),
    JSON.stringify({ reactions: [VALID_REACTION] }),
    JSON.stringify({ reactions: [VALID_REACTION] }),
  ]);
  const analyst = createAnalyst({ completeAI, maxPerMinute: 2, now: () => now });
  const payload = { groups: [{ herText: "hi", reactions: [{ emoji: "❤️", who: "Ren" }] }] };
  assert.ok(await analyst.interpretReactions(payload));
  assert.ok(await analyst.interpretReactions(payload));
  assert.equal(await analyst.interpretReactions(payload), null); // budget spent
  assert.equal(completeAI.calls.length, 2);
  assert.equal(analyst.stats.skipped, 1);
  now += 61_000; // window slides
  assert.ok(await analyst.interpretReactions(payload));
  assert.equal(completeAI.calls.length, 3);
});

test("game moments are judged with a speakable line or silence", async () => {
  const completeAI = fakeCompleter([JSON.stringify({
    speak: true,
    line: "ren just bet the whole paycheck again 💀",
    reason: "all-in after a losing streak",
    learned_command: "whl",
  })]);
  const analyst = createAnalyst({ completeAI, maxPerMinute: 10, persona: "a teasing catgirl teacher" });
  const verdict = await analyst.judgeGameMoment({
    channelLabel: "casino",
    gameBotName: "OwO",
    lines: "Ren: whl 500\nOwO [bot]: [HighLow — pick your poison! — choices: A / B / C]",
    triggerCandidate: "whl 500",
  });
  assert.equal(verdict.speak, true);
  assert.ok(verdict.line.includes("paycheck"));
  assert.equal(verdict.learnedCommand, "whl");
  const prompt = completeAI.calls[0].messages.map((m) => m.content).join("\n");
  assert.ok(prompt.includes("catgirl")); // her voice, for the line
  assert.ok(prompt.includes("whl 500")); // the trigger candidate
});

test("speak=true without a usable line stays silent", async () => {
  const analyst = createAnalyst({
    completeAI: fakeCompleter([JSON.stringify({ speak: true, line: "", reason: "" })]),
    maxPerMinute: 10,
  });
  const verdict = await analyst.judgeGameMoment({ channelLabel: "c", gameBotName: "OwO", lines: "x", triggerCandidate: "" });
  assert.equal(verdict.speak, false);
  assert.equal(verdict.line, "");
});

test("unparseable game judgments return null instead of nonsense", async () => {
  const broken = createAnalyst({ completeAI: fakeCompleter(["nope"]), maxPerMinute: 10 });
  assert.equal(await broken.judgeGameMoment({ channelLabel: "c", gameBotName: "OwO", lines: "x", triggerCandidate: "" }), null);
  const down = createAnalyst({ completeAI: fakeCompleter([new Error("timeout")]), maxPerMinute: 10 });
  assert.equal(await down.judgeGameMoment({ channelLabel: "c", gameBotName: "OwO", lines: "x", triggerCandidate: "" }), null);
  // speak not a boolean → treat as invalid
  const weird = createAnalyst({ completeAI: fakeCompleter(['{"speak":"yes","line":"hi"}']), maxPerMinute: 10 });
  assert.equal(await weird.judgeGameMoment({ channelLabel: "c", gameBotName: "OwO", lines: "x", triggerCandidate: "" }), null);
});

test("chime-in judgment approves a natural opening and writes the line", async () => {
  const completeAI = fakeCompleter([JSON.stringify({
    speak: true,
    line: "wait you guys finished the whole series without me?? 💀",
    reason: "left out of the watch party",
  })]);
  const analyst = createAnalyst({ completeAI, maxPerMinute: 10, persona: "a teasing teacher" });
  const verdict = await analyst.judgeChimeIn({
    channelLabel: "general",
    lines: "Ren: we started the new season last night\nsprite: ep 3 was insane",
    peopleNotes: "- Ren: friendship — close friends",
    worldNote: "It is 9:12 PM PHT.",
    occasion: "someone just said something she overheard",
  });
  assert.equal(verdict.speak, true);
  assert.ok(verdict.line.includes("series"));
  assert.ok(verdict.reason.includes("watch party"));
  const prompt = completeAI.calls[0].messages.map((m) => m.content).join("\n");
  assert.ok(prompt.includes("ep 3 was insane")); // the conversation she overheard
  assert.ok(prompt.includes("close friends")); // her bonds with the speakers
  assert.ok(prompt.includes("teasing teacher")); // her voice for the line
  assert.ok(prompt.includes("9:12 PM")); // time of day
  assert.ok(prompt.includes("someone just said something she overheard"));
});

test("chime-in judgment can veto the dice roll", async () => {
  const analyst = createAnalyst({
    completeAI: fakeCompleter([JSON.stringify({ speak: false, line: "", reason: "private argument" })]),
    maxPerMinute: 10,
  });
  const verdict = await analyst.judgeChimeIn({ channelLabel: "general", lines: "Ren: whatever\nsprite: fine." });
  assert.equal(verdict.speak, false);
  assert.equal(verdict.line, "");
});

test("chime-in speak=true without a usable line stays silent", async () => {
  const analyst = createAnalyst({
    completeAI: fakeCompleter([JSON.stringify({ speak: true, line: "   ", reason: "" })]),
    maxPerMinute: 10,
  });
  const verdict = await analyst.judgeChimeIn({ channelLabel: "c", lines: "x" });
  assert.equal(verdict.speak, false);
  assert.equal(verdict.line, "");
});

test("unparseable chime-in judgments return null instead of nonsense", async () => {
  const payload = { channelLabel: "c", lines: "x" };
  const broken = createAnalyst({ completeAI: fakeCompleter(["nope"]), maxPerMinute: 10 });
  assert.equal(await broken.judgeChimeIn(payload), null);
  const down = createAnalyst({ completeAI: fakeCompleter([new Error("timeout")]), maxPerMinute: 10 });
  assert.equal(await down.judgeChimeIn(payload), null);
  const weird = createAnalyst({ completeAI: fakeCompleter(['{"speak":"yes","line":"hi"}']), maxPerMinute: 10 });
  assert.equal(await weird.judgeChimeIn(payload), null);
  assert.equal(down.stats.fallbacks, 1);
});

test("chime-in judgments share the same per-minute budget", async () => {
  let now = 5_000_000;
  const verdict = JSON.stringify({ speak: false, line: "", reason: "" });
  const completeAI = fakeCompleter([verdict, verdict]);
  const analyst = createAnalyst({ completeAI, maxPerMinute: 1, now: () => now });
  assert.ok(await analyst.judgeChimeIn({ channelLabel: "c", lines: "x" }));
  assert.equal(await analyst.judgeChimeIn({ channelLabel: "c", lines: "x" }), null); // budget spent
  assert.equal(analyst.stats.skipped, 1);
  now += 61_000;
  assert.ok(await analyst.judgeChimeIn({ channelLabel: "c", lines: "x" }));
  assert.equal(completeAI.calls.length, 2);
});

test("learned commands are validated against the trigger message", () => {
  assert.equal(validLearnedCommand("whl 500", "whl"), "whl");
  assert.equal(validLearnedCommand("gacha", "gacha"), "gacha");
  assert.equal(validLearnedCommand("whl all", "whl"), "whl");
  // Deictic pointers and filler must never become commands.
  assert.equal(validLearnedCommand("here @OwO", "here"), null);
  assert.equal(validLearnedCommand("this", "this"), null);
  // The word must actually be the start of the candidate.
  assert.equal(validLearnedCommand("daily", "whl"), null);
  assert.equal(validLearnedCommand("", "whl"), null);
  assert.equal(validLearnedCommand("whl 500", ""), null);
  // Junk is rejected: SQL, long words, punctuation, spaces.
  assert.equal(validLearnedCommand("drop table users;", "drop table users;"), null);
  assert.equal(validLearnedCommand("supercalifragilistic", "supercalifragilistic"), null);
  assert.equal(validLearnedCommand("whl!!", "whl!!"), null);
  // The candidate itself must look like a bare command or command+wager.
  assert.equal(validLearnedCommand("hey can someone help me choose", "hey"), null);
  assert.equal(validLearnedCommand("gacha 500 500", "gacha"), null);
});

test("reaction summaries show AI meanings inline and collapse duplicates", () => {
  const text = formatReactionSummary([
    { emoji: "❤️", userName: "Ren", meaning: "flirty teasing" },
    { emoji: "❤️", userName: "Ren", meaning: "flirty teasing" }, // same moment, twice
    { emoji: "😂", userName: "sprite vodka", meaning: "" },
  ]);
  assert.ok(text.includes("❤️ from Ren — flirty teasing"));
  assert.ok(text.includes("😂 from sprite vodka"));
  assert.equal(text.split("; ").length, 2); // the duplicate heart collapsed
});

test("learned game commands extend the conversation filter safely", () => {
  assert.equal(isGameCommand("gacha"), false);
  learnedGameCommands.add("gacha");
  try {
    assert.equal(isGameCommand("gacha"), true);
    assert.equal(isGameCommand("GACHA."), true); // normalization still applies
    assert.equal(isGameCommand("gacha 500"), true); // learned command + wager
    assert.equal(isGameCommand("gacha all"), true);
    assert.equal(isGameCommand("gacha time everyone"), false); // conversation stays conversation
    assert.equal(isGameCommand("i love gacha"), false);
  } finally {
    learnedGameCommands.delete("gacha");
  }
  assert.equal(isGameCommand("gacha"), false); // removal restores old behavior
});
