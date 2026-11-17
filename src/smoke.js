import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb } from "./db.js";
import { buildContext, logMessage, upsertGuildMember } from "./memory.js";

const directory = join(tmpdir(), `capri-smoke-${process.pid}`);
mkdirSync(directory, { recursive: true });
const db = createMemoryDb(join(directory, "memory.db"));

upsertGuildMember(db, "smoke-guild", {
  id: "smoke-user",
  displayName: "Smoke User",
  nickname: "Smokey",
  user: { username: "smoke_user", globalName: "Smoke User", bot: false },
  roles: { cache: new Map([["r1", { id: "r1", name: "Netrunners" }]]) },
  joinedTimestamp: Date.now() - 86_400_000,
  voice: { channelId: "vc-1" },
});

const oldId = logMessage(db, {
  channelId: "smoke-channel",
  authorId: "smoke-user",
  authorName: "Smoke User",
  username: "smoke_user",
  content: "we built the rig together",
  createdAt: Date.now() - 40 * 86_400_000,
  guildId: "smoke-guild",
});
db.prepare("INSERT INTO vec_messages_v(message_id, embedding) VALUES (?, ?)")
  .run(BigInt(oldId), Buffer.from(new Float32Array(new Array(384).fill(0.22)).buffer));

db.prepare("INSERT INTO facts(subject, fact, first_seen, last_seen) VALUES (?, ?, ?, ?)")
  .run("user:smoke-user", "Smoke User is building a custom cyberdeck", Date.now(), Date.now());
db.prepare("INSERT INTO relationships(user_id, affinity, last_interacted) VALUES (?, ?, ?)")
  .run("smoke-user", 2.3, Date.now() - 2 * 86_400_000);

const context = buildContext(db, {
  message: {
    channelId: "smoke-channel",
    authorId: "smoke-user",
    authorName: "Smoke User",
    content: "do you remember the rig?",
    guildId: "smoke-guild",
  },
  embedVector: new Array(384).fill(0.22),
  deepRecall: true,
  personalityPath: "personality.txt",
  botId: "smoke-bot",
  replyTo: { authorName: "Other User", isSelf: false, content: "check the schematic", ageMs: 120_000 },
});

for (const needle of [
  "Smoke User (@smoke_user) is talking to you right now",
  "Netrunners",
  "custom cyberdeck",
  "built the rig together",
  "Other User's message",
]) {
  if (!context.memoryBlock.includes(needle)) {
    throw new Error(`Smoke test failed: missing "${needle}"`);
  }
}

console.log("Capri smoke test passed (memory + full server directory + context grounding).");
db.close();
rmSync(directory, { recursive: true, force: true });
