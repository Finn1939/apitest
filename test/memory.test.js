import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACT_LIMIT,
  addFact,
  addHistory,
  buildContext,
  forgetFacts,
  loadMemory,
  logMessage,
  parseRememberCommand,
  relationshipSummary,
  saveMemory,
} from "../src/memory.js";
import { createMemoryDb } from "../src/db.js";

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

test("buildContext tells her who a Discord reply was aimed at", () => {
  // Replays the real failure: someone replied to Manu's message and asked
  // "tell me his user" — she used to ask "which 'him'?" because she never
  // saw the reply link.
  const directory = mkdtempSync(join(tmpdir(), "apitest-reply-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");
  logMessage(db, {
    channelId: "channel-1",
    authorId: "user-manu",
    authorName: "Manu",
    username: "manu",
    content: "Ayaw magloading ng zip",
    createdAt: Date.now() - 60_000,
    guildId: "guild-1",
  });

  const context = buildContext(db, {
    message: {
      channelId: "channel-1",
      authorId: "user-sprite",
      authorName: "sprite vodka",
      content: "tell me his user",
      guildId: "guild-1",
    },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
    replyTo: { authorName: "Manu", isSelf: false, content: "Ayaw magloading ng zip", ageMs: 60_000 },
  });

  assert.match(context.memoryBlock, /Manu's message/);
  assert.match(context.memoryBlock, /"Ayaw magloading ng zip"/);
  assert.match(context.memoryBlock, /most likely mean Manu/);
  // The roster must still be there so she can actually answer "his user".
  assert.match(context.memoryBlock, /Manu \(@manu\)/);
  rmSync(directory, { recursive: true, force: true });
});

test("buildContext without a reply stays silent about replies", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-noreply-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");
  const context = buildContext(db, {
    message: { channelId: "channel-1", authorId: "u1", authorName: "Alex", content: "hello there", guildId: "guild-1" },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
  });
  assert.doesNotMatch(context.memoryBlock, /Discord's reply/);
  assert.doesNotMatch(context.memoryBlock, /most likely mean/);
  rmSync(directory, { recursive: true, force: true });
});

test("dollar signs in memories never corrupt the memory block", () => {
  // String.replace interprets "$&", "$`", "$'" and "$$" in a replacement.
  // Facts and recent messages are injected as replacements, so a memory like
  // "sed 's/$&/x/'" used to silently mangle the whole block.
  const directory = mkdtempSync(join(tmpdir(), "apitest-dollars-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");
  const factText = "Alex pasted the command sed 's/$&/x/' and $$ prices";
  db.prepare("INSERT INTO facts(subject, fact, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)")
    .run("user:u1", factText, 0.9, Date.now(), Date.now());
  logMessage(db, {
    channelId: "channel-1", authorId: "u1", authorName: "Alex", username: "alex",
    content: "the $` backtick and $' quote broke it", createdAt: Date.now(), guildId: "guild-1",
  });

  const context = buildContext(db, {
    message: { channelId: "channel-1", authorId: "u1", authorName: "Alex", content: "what did I paste", guildId: "guild-1" },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
  });

  // The raw text must survive verbatim, exactly once — pattern expansion
  // would duplicate or mangle it.
  assert.equal(context.memoryBlock.split(factText).length - 1, 1, "fact text was corrupted or duplicated by replace() patterns");
  assert.ok(context.memoryBlock.includes("$` backtick"), "recent message was corrupted by replace() patterns");
  // ...and no template holes may appear.
  assert.ok(!context.memoryBlock.includes("{{"), "template placeholder leaked into the block");
  rmSync(directory, { recursive: true, force: true });
});

test("other bots appear in the roster and recent conversation, marked as bots", () => {
  // The "who is dis?" failure: TEST. posted a help dump, but bot messages
  // were never logged, so she had no way to know who "dis" was.
  const directory = mkdtempSync(join(tmpdir(), "apitest-bots-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");
  logMessage(db, {
    channelId: "channel-1", authorId: "bot-test", authorName: "TEST.", username: "TEST.",
    content: "Commands: bac, bal, bj, daily, help, hl, joinvc", createdAt: Date.now() - 30_000, guildId: "guild-1",
    isBot: true,
  });
  logMessage(db, {
    channelId: "channel-1", authorId: "bot-owo", authorName: "OwO", username: "OwO",
    content: "sprite vodka, you currently have 135,000 cowoncy!", createdAt: Date.now() - 20_000, guildId: "guild-1",
    isBot: true,
  });
  logMessage(db, {
    channelId: "channel-1", authorId: "human-1", authorName: "sprite vodka", username: "sprite_vodka",
    content: "who is dis", createdAt: Date.now() - 10_000, guildId: "guild-1",
  });

  const context = buildContext(db, {
    message: { channelId: "channel-1", authorId: "human-1", authorName: "sprite vodka", content: "who is dis", guildId: "guild-1" },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
  });

  // Roster: bots listed with a [a bot] marker, humans unmarked.
  assert.match(context.memoryBlock, /TEST\.[^\n]*\[a bot\]/);
  assert.match(context.memoryBlock, /OwO[^\n]*\[a bot\]/);
  assert.doesNotMatch(context.memoryBlock, /sprite vodka[^\n]*\[a bot\]/);
  // Recent conversation carries the bot output so "who is dis" is answerable.
  assert.ok(context.memoryBlock.includes("cowoncy"), "bot messages must surface in recent conversation");
  rmSync(directory, { recursive: true, force: true });
});

test("active conversation is stated in the speaker block", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-active-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");
  const context = buildContext(db, {
    message: { channelId: "channel-1", authorId: "u1", authorName: "Finn", content: "yeah exactly", guildId: "guild-1", activeConvo: true },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
  });
  assert.match(context.memoryBlock, /middle of an ongoing conversation/);

  const plain = buildContext(db, {
    message: { channelId: "channel-1", authorId: "u1", authorName: "Finn", content: "yeah exactly", guildId: "guild-1" },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
  });
  assert.doesNotMatch(plain.memoryBlock, /ongoing conversation/);
  rmSync(directory, { recursive: true, force: true });
});

test("buildContext caps large recent and relevant memory within a configured budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-large-context-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a concise Discord companion.");
  for (let index = 0; index < 500; index += 1) {
    logMessage(db, {
      channelId: "channel-large",
      authorId: "user-speaker",
      authorName: "Speaker",
      username: "speaker",
      content: `message ${index}: ${"long memory detail ".repeat(30)}`,
      createdAt: Date.now() - (500 - index) * 60_000,
      guildId: "guild-1",
    });
  }

  const context = buildContext(db, {
    message: {
      channelId: "channel-large",
      authorId: "user-speaker",
      authorName: "Speaker",
      content: "what do you remember?",
      guildId: "guild-1",
    },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
    memoryContextTokens: 6000,
  });

  assert.ok(context.estimatedTokens < 6000);
  rmSync(directory, { recursive: true, force: true });
});

test("buildContext identifies replies to the bot as self-replies", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-self-reply-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");

  const context = buildContext(db, {
    message: {
      channelId: "channel-1",
      authorId: "user-sprite",
      authorName: "sprite vodka",
      content: "how bout now?",
      guildId: "guild-1",
    },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
    replyTo: { authorName: "Teacher-san", isSelf: true, content: "karuta bby, newp", ageMs: 1_000 },
  });

  assert.match(context.memoryBlock, /your earlier message/);
  assert.match(context.memoryBlock, /user is replying to you, the bot/);
  rmSync(directory, { recursive: true, force: true });
});

test("buildContext names the exact author for a bot reply identity question", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-other-bot-reply-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");

  const context = buildContext(db, {
    message: {
      channelId: "channel-1",
      authorId: "user-sprite",
      authorName: "sprite vodka",
      content: "who's this",
      guildId: "guild-1",
    },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
    replyTo: { authorName: "CardCompanion", isSelf: false, content: "Tap to see message", ageMs: 1_000 },
  });

  assert.match(context.memoryBlock, /CardCompanion's message/);
  assert.match(context.memoryBlock, /the answer is CardCompanion/);
  assert.match(context.memoryBlock, /never guess a different bot or person/);
  // The instruction must stay conditional so it never leaks into her replies.
  assert.match(context.memoryBlock, /do not bring it up/);
  rmSync(directory, { recursive: true, force: true });
});

test("recent conversation labels her own lines and trims bot spam", () => {
  // The live failure: her own past replies sat in recent conversation as bare
  // "teacher-san: ..." lines, so the model re-sent them verbatim; and a game
  // channel's bot output buried every human line.
  const directory = mkdtempSync(join(tmpdir(), "apitest-recent-labels-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");

  logMessage(db, {
    channelId: "casino", authorId: "u1", authorName: "Ren", username: "ren",
    content: "balance", createdAt: Date.now() - 70_000, guildId: "guild-1",
  });
  logMessage(db, {
    channelId: "casino", authorId: "bot-1", authorName: "teacher-san", username: "teacher-san",
    content: "really? I just said I don't like that", createdAt: Date.now() - 60_000, guildId: "guild-1", isBot: true,
  });
  // Five OwO lines: only the newest three may survive in recent conversation.
  for (let index = 1; index <= 5; index += 1) {
    logMessage(db, {
      channelId: "casino", authorId: "bot-owo", authorName: "OwO", username: "owo",
      content: `owo line ${index}`, createdAt: Date.now() - (55 - index) * 1_000, guildId: "guild-1", isBot: true,
    });
  }
  logMessage(db, {
    channelId: "casino", authorId: "u1", authorName: "Ren", username: "ren",
    content: "wcf 655", createdAt: Date.now() - 5_000, guildId: "guild-1",
  });

  const context = buildContext(db, {
    message: { channelId: "casino", authorId: "u1", authorName: "Ren", content: "wcf 655", guildId: "guild-1" },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
  });

  const block = context.memoryBlock;
  // Her own line is labelled so the model knows what it already said.
  assert.match(block, /You: really\? I just said I don't like that/);
  // Humans stay unmarked.
  assert.match(block, /Ren: wcf 655/);
  // Other bots are marked and capped at the newest three lines.
  assert.match(block, /OwO \[bot\]: owo line 5/);
  assert.ok(!block.includes("owo line 1"), "oldest bot line must be dropped");
  assert.ok(!block.includes("owo line 2"), "second-oldest bot line must be dropped");
  const botLineCount = (block.match(/\[bot\]:/g) || []).length;
  assert.ok(botLineCount <= 3, `expected at most 3 bot lines in recent conversation, found ${botLineCount}`);
  rmSync(directory, { recursive: true, force: true });
});

test("closeness changes how she should talk, not just how she feels", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-affinity-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");
  logMessage(db, {
    channelId: "c1", authorId: "u9", authorName: "Ren", username: "ren",
    content: "sup", createdAt: Date.now(), guildId: "guild-1",
  });
  db.prepare("INSERT INTO relationships(user_id, affinity, last_interacted) VALUES (?, ?, ?)")
    .run("u9", 4.5, Date.now());
  const opts = {
    message: { channelId: "c1", authorId: "u9", authorName: "Ren", content: "sup", guildId: "guild-1" },
    personalityPath: join(directory, "personality.txt"),
    botId: "bot-1",
  };

  // A closest-tier regular (affinity 4.5) gets the relaxed, teasing register.
  const close = buildContext(db, opts);
  assert.match(close.memoryBlock, /fully relaxed/);

  // The same person after a reset (affinity 0.05) gets the guarded register.
  db.prepare("UPDATE relationships SET affinity = 0.05 WHERE user_id = ?").run("u9");
  const guarded = buildContext(db, opts);
  assert.match(guarded.memoryBlock, /slightly guarded/);
  assert.doesNotMatch(guarded.memoryBlock, /fully relaxed/);

  // A complete stranger (no relationship row) is told to stay reserved.
  const stranger = buildContext(db, {
    ...opts,
    message: { channelId: "c1", authorId: "u-new", authorName: "Newbie", content: "hi", guildId: "guild-1" },
  });
  assert.match(stranger.memoryBlock, /Stay polite, brief and a little reserved/);
  rmSync(directory, { recursive: true, force: true });
});

test("romance surfaces by depth and is gated by friendship", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-romance-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  writeFileSync(join(directory, "personality.txt"), "You are a playful Discord companion.");
  logMessage(db, {
    channelId: "c1", authorId: "u9", authorName: "Ren", username: "ren",
    content: "sup", createdAt: Date.now(), guildId: "guild-1",
  });
  const build = (affinity, romance) => {
    db.prepare("INSERT OR REPLACE INTO relationships(user_id, affinity, last_interacted, romance) VALUES (?, ?, ?, ?)")
      .run("u9", affinity, Date.now(), romance);
    return buildContext(db, {
      message: { channelId: "c1", authorId: "u9", authorName: "Ren", content: "sup", guildId: "guild-1" },
      personalityPath: join(directory, "personality.txt"),
      botId: "bot-1",
    }).memoryBlock;
  };

  // Real crush with a deep friendship behind it.
  assert.match(build(4.5, 2.5), /real crush/);
  // Fully in love, closest-tier friendship: the guardrails must ride along.
  const inLove = build(4.5, 4.2);
  assert.match(inLove, /in love with them/);
  assert.match(inLove, /non-explicit/);
  assert.match(inLove, /dial it back/);
  // Friendship gate: 4.2 stored but affinity only 0.5 → effective 1.5, so the
  // deepest it can feel today is a budding crush. Griefing cannot skip this.
  const gated = build(0.5, 4.2);
  assert.match(gated, /small crush/);
  assert.doesNotMatch(gated, /in love with them/);
  assert.doesNotMatch(gated, /falling for them/);
  // Below 1: invisible entirely — no feelings suggested where there are none.
  const dormant = build(4.5, 0.4);
  assert.doesNotMatch(dormant, /crush/);
  assert.doesNotMatch(dormant, /flustered/);
  rmSync(directory, { recursive: true, force: true });
});

test("relationshipSummary shows the same tiers the prompts use", () => {
  // Stranger-ish: no romance ever suggested.
  const stranger = relationshipSummary({ affinity: 0.05, romance: 0, lastInteracted: Date.now() });
  assert.equal(stranger.friendLabel, "someone she's still getting to know");
  assert.equal(stranger.romanceLabel, null);

  // Close friend with a deep, mutual bond.
  const closest = relationshipSummary({ affinity: 4.5, romance: 4.2, lastInteracted: Date.now() });
  assert.equal(closest.friendLabel, "one of her closest people");
  assert.match(closest.romanceLabel, /in love with you/);
  assert.equal(closest.daysSinceTalk, 0);

  // Friendship gate: 4.2 stored but they barely know each other, so the
  // /relationship display can never claim more than a budding crush.
  const gated = relationshipSummary({ affinity: 0.5, romance: 4.2, lastInteracted: Date.now() });
  assert.match(gated.romanceLabel, /tiny crush/);
  assert.ok(gated.effectiveRomance < 2);

  // Romance below 1 stays invisible in the display too.
  const quiet = relationshipSummary({ affinity: 3, romance: 0.9, lastInteracted: Date.now() });
  assert.equal(quiet.romanceLabel, null);

  // Days since last talk is derived for the footer line.
  const away = relationshipSummary({ affinity: 2, romance: 0, lastInteracted: Date.now() - 3 * 86_400_000 });
  assert.equal(away.daysSinceTalk, 3);

  // No row at all: defaults, no crash.
  const empty = relationshipSummary({});
  assert.equal(empty.friendLabel, "someone she's still getting to know");
  assert.equal(empty.romanceLabel, null);
  assert.equal(empty.daysSinceTalk, null);
});

test("forgetFacts removes only matching facts for one subject", () => {
  const directory = mkdtempSync(join(tmpdir(), "apitest-forgetfact-"));
  const db = createMemoryDb(join(directory, "memory.db"));
  const insert = db.prepare(
    "INSERT INTO facts(subject, fact, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("user:u1", "Ren lives in Cebu", 0.9, Date.now(), Date.now());
  insert.run("user:u1", "Ren plays Karuta daily", 0.9, Date.now(), Date.now());
  insert.run("user:u1", "Ren's dog is called Bantay", 0.9, Date.now(), Date.now());
  insert.run("user:u2", "Ren from the other server likes mangoes", 0.9, Date.now(), Date.now());

  // Substring match is case-insensitive and scoped to one subject.
  const removed = forgetFacts(db, "user:u1", "KARUTA");
  assert.deepEqual(removed, ["Ren plays Karuta daily"]);

  // Only the two remaining u1 facts survive; u2's Ren fact is untouched.
  const remaining = db.prepare("SELECT subject, fact FROM facts ORDER BY subject, fact").all();
  assert.deepEqual(remaining, [
    { subject: "user:u1", fact: "Ren lives in Cebu" },
    { subject: "user:u1", fact: "Ren's dog is called Bantay" },
    { subject: "user:u2", fact: "Ren from the other server likes mangoes" },
  ]);

  // LIKE wildcards in the query must be treated literally, not as patterns.
  assert.deepEqual(forgetFacts(db, "user:u1", "100%"), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM facts").get().count, 3);

  // Empty or missing queries never delete anything.
  assert.deepEqual(forgetFacts(db, "user:u1", "   "), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM facts").get().count, 3);
  rmSync(directory, { recursive: true, force: true });
});
