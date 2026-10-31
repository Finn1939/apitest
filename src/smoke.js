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
};
logMessage(db, message);
const context = buildContext(db, { message, personalityPath: "personality.txt" });
if (!context.memoryBlock.includes("Testing memory")) throw new Error("Memory round-trip failed");
console.log(`Memory round-trip passed; RSS: ${process.memoryUsage().rss} bytes`);
db.close();
rmSync(directory, { recursive: true });
