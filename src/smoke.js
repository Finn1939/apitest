// Offline round-trip: log → store → retrieve → build context. No network, no API keys.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb } from "./db.js";
import { logMessage, buildContext } from "./memory.js";

const directory = join(tmpdir(), `apitest-smoke-${process.pid}`);
mkdirSync(directory, { recursive: true });
const db = createMemoryDb(join(directory, "memory.db"));

const ids = [
  logMessage(db, {
    channelId: "smoke-channel", authorId: "smoke-user", authorName: "Smoke User", username: "smoke_user",
    content: "we built the pc together last month", createdAt: Date.now() - 3 * 86_400_000, guildId: "smoke-guild",
  }),
  logMessage(db, {
    channelId: "smoke-channel", authorId: "smoke-user", authorName: "Smoke User", username: "smoke_user",
    content: "do you remember the pc build?", createdAt: Date.now(), guildId: "smoke-guild",
  }),
  logMessage(db, {
    channelId: "smoke-channel", authorId: "other-user", authorName: "Other User", username: "other_user",
    content: "the zip wont load", createdAt: Date.now() - 120_000, guildId: "smoke-guild",
  }),
];
for (const id of ids) {
  db.prepare("INSERT INTO vec_messages_v(message_id, embedding) VALUES (?, ?)")
    .run(BigInt(id), Buffer.from(new Float32Array(new Array(384).fill(0.22)).buffer));
}
db.prepare("INSERT INTO facts(subject, fact, first_seen, last_seen) VALUES (?, ?, ?, ?)")
  .run("user:smoke-user", "Smoke User is building a new PC", Date.now(), Date.now());
db.prepare("INSERT INTO relationships(user_id, affinity, last_interacted) VALUES (?, ?, ?)")
  .run("smoke-user", 2.3, Date.now() - 2 * 86_400_000);

const context = buildContext(db, {
  message: {
    channelId: "smoke-channel", authorId: "smoke-user", authorName: "Smoke User",
    content: "do you remember the pc build?", guildId: "smoke-guild",
  },
  embedVector: new Array(384).fill(0.22),
  deepRecall: true,
  personalityPath: "personality.txt",
  botId: "smoke-bot",
  replyTo: { authorName: "Other User", isSelf: false, content: "the zip wont load", ageMs: 120_000 },
});
const needles = [
  "Smoke User (@smoke_user) is talking to you right now",   // speaker recognition + handle
  "a regular you are genuinely fond of",       // affinity tier
  "building a new PC",                         // speaker facts
  "pc together",                               // semantic recall of the old message
  "Other User's message",                      // Discord reply target resolved
  "most likely mean Other User",               // pronoun resolution hint
];
for (const needle of needles) {
  if (!context.memoryBlock.includes(needle)) throw new Error(`Memory round-trip failed: missing "${needle}"`);
}
console.log(`Memory round-trip passed (retrieval + recognition); RSS: ${process.memoryUsage().rss} bytes`);
db.close();
rmSync(directory, { recursive: true, force: true });
