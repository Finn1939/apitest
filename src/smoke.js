import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb } from "./db.js";
import { logMessage, buildContext } from "./memory.js";

const directory = join(tmpdir(), `apitest-smoke-${process.pid}`);
mkdirSync(directory, { recursive: true });
const db = createMemoryDb(join(directory, "memory.db"));
const message = {
  channelId: "smoke-channel",
  authorId: "smoke-user",
  authorName: "Smoke User",
  content: "Testing memory",
  guildId: "smoke-guild",
};
const loggedId = logMessage(db, message);

// Verify the vec0 virtual table accepts embeddings and answers KNN queries.
const fakeVector = Array.from({ length: 384 }, () => 0.1);
db.prepare("INSERT INTO vec_messages_v(message_id, embedding) VALUES (?, ?)")
  .run(BigInt(loggedId), Buffer.from(new Float32Array(fakeVector).buffer));
const knn = db.prepare("SELECT message_id, distance FROM vec_messages_v WHERE embedding MATCH ? AND k = 1")
  .all(Buffer.from(new Float32Array(fakeVector).buffer));
if (knn.length !== 1 || Number(knn[0].message_id) !== Number(loggedId)) {
  throw new Error("vec0 KNN round-trip failed");
}

const context = buildContext(db, { message, embedVector: fakeVector, personalityPath: "personality.txt" });
if (!context.memoryBlock.includes("Testing memory")) throw new Error("Memory round-trip failed");
console.log(`Memory + vector round-trip passed; RSS: ${process.memoryUsage().rss} bytes`);
db.close();
rmSync(directory, { recursive: true });
