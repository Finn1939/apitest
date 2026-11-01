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
  loadMemory,
  logMessage,
  parseRememberCommand,
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
