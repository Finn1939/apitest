import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createMemoryDb } from "./src/db.js";
import { logMessage, buildContext } from "./src/memory.js";

const directory = join(tmpdir(), `capri-migrate-${process.pid}`);
mkdirSync(directory, { recursive: true });
const dbPath = join(directory, "memory.db");

const old = new Database(dbPath);
old.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL,
    author_name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5, summarized INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE facts (
    id INTEGER PRIMARY KEY, subject TEXT NOT NULL, fact TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.9, hits INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE TABLE summaries (
    id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE self_model (id INTEGER PRIMARY KEY, persona TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE relationships (user_id TEXT PRIMARY KEY, affinity REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '');
  CREATE TABLE vec_messages (message_id INTEGER PRIMARY KEY, embedding BLOB);
`);
const base = Date.now() - 5 * 86_400_000;
const id1 = old.prepare("INSERT INTO messages(channel_id, author_id, author_name, content, created_at) VALUES (?, ?, ?, ?, ?)")
  .run("chan-1", "111", "Marco", "we built the pc together", base).lastInsertRowid;
old.prepare("INSERT INTO facts(subject, fact, first_seen, last_seen) VALUES (?, ?, ?, ?)")
  .run("user:Marco", "Marco is building a new PC", base, base);
old.prepare("INSERT INTO vec_messages(message_id, embedding) VALUES (?, ?)")
  .run(id1, Buffer.from(new Float32Array(new Array(384).fill(0.11)).buffer));
old.close();

const db = createMemoryDb(dbPath);
const version = db.pragma("user_version", { simple: true });
if (version !== 9) throw new Error(`Expected user_version 9, got ${version}`);

const guildMembersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guild_members'").get();
if (!guildMembersTable) throw new Error("guild_members table missing after migration");

const newId = logMessage(db, {
  channelId: "chan-1",
  authorId: "111",
  authorName: "Marco",
  username: "marco_p",
  content: "remember the pc build?",
  createdAt: Date.now(),
  guildId: "guild-1",
});
db.prepare("INSERT INTO vec_messages_v(message_id, embedding) VALUES (?, ?)")
  .run(BigInt(newId), Buffer.from(new Float32Array(new Array(384).fill(0.22)).buffer));

const ctx = buildContext(db, {
  message: { channelId: "chan-1", authorId: "111", authorName: "Marco", content: "remember the pc build?", guildId: "guild-1" },
  embedVector: new Array(384).fill(0.22),
  deepRecall: true,
  personalityPath: "personality.txt",
  botId: "bot-1",
});
if (!ctx.memoryBlock.includes("Marco is building a new PC")) throw new Error("fact recall failed after migration");

console.log("ALL MIGRATION CHECKS PASSED (v1 -> v9)");
db.close();
rmSync(directory, { recursive: true, force: true });
