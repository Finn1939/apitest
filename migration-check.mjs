// Integration test: upgrade an OLD database (pre-patch schema) in place.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createMemoryDb } from "./src/db.js";
import { logMessage, buildContext } from "./src/memory.js";

const directory = join(tmpdir(), `apitest-migrate-${process.pid}`);
mkdirSync(directory, { recursive: true });
const dbPath = join(directory, "memory.db");

// --- Build an OLD-schema database, exactly like the current bot creates ---
const old = new Database(dbPath);
old.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL,
    author_name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5, summarized INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE vec_messages (message_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL);
  CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, fact TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.9, hits INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
  CREATE TABLE summaries (id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE self_model (id INTEGER PRIMARY KEY CHECK(id = 1), persona TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE self_model_history (id INTEGER PRIMARY KEY, persona TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE relationships (user_id TEXT PRIMARY KEY, affinity REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '');
  CREATE VIRTUAL TABLE fts_messages USING fts5(content, content='messages', content_rowid='id');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO fts_messages(rowid, content) VALUES (new.id, new.content);
  END;
`);
const now = Date.now();
const insert = old.prepare("INSERT INTO messages(channel_id, author_id, author_name, content, created_at) VALUES (?, ?, ?, ?, ?)");
const msgId1 = insert.run("chan-1", "111", "Marco", "remember when we built the pc together", now - 86400000).lastInsertRowid;
const msgId2 = insert.run("chan-1", "111", "Marco", "also the pizza that night was unreal", now - 86000000).lastInsertRowid;
insert.run("chan-1", "222", "Kai", "miso finally learned to sit", now - 84000000);
old.prepare("INSERT INTO vec_messages(message_id, embedding) VALUES (?, ?)")
  .run(BigInt(msgId1), Buffer.from(new Float32Array(new Array(384).fill(0.2)).buffer));
old.prepare("INSERT INTO vec_messages(message_id, embedding) VALUES (?, ?)")
  .run(BigInt(msgId2), Buffer.from(new Float32Array(new Array(384).fill(0.25)).buffer));
// A fact keyed by display name, plus a junk half-length blob that must be dropped
old.prepare("INSERT INTO facts(subject, fact, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)")
  .run("user:Marco", "Marco is building a new PC", 0.9, now, now);
old.prepare("INSERT INTO vec_messages(message_id, embedding) VALUES (?, ?)")
  .run(999n, Buffer.from(new Float32Array(new Array(100).fill(0.5)).buffer));
old.prepare("INSERT INTO self_model(id, persona, updated_at) VALUES (1, ?, ?)").run("old persona", now);
old.close();

// --- Run createMemoryDb, which must migrate everything ---
const db = createMemoryDb(dbPath);
const columns = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!columns.includes("guild_id")) throw new Error("migration failed: guild_id missing");
const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_messages'").get();
if (legacyTable) throw new Error("migration failed: legacy vec_messages still present");
const vecCount = db.prepare("SELECT COUNT(*) AS c FROM vec_messages_v").get().c;
if (vecCount !== 2) throw new Error(`migration failed: expected 2 migrated vectors, got ${vecCount}`);
const rekeyed = db.prepare("SELECT subject FROM facts WHERE fact LIKE '%PC%'").get();
if (rekeyed?.subject !== "user:111") throw new Error(`migration failed: fact re-key produced ${rekeyed?.subject}`);
const version = db.pragma("user_version", { simple: true });
if (version !== 3) throw new Error(`migration failed: user_version = ${version}`);
if (!db.prepare("PRAGMA table_info(relationships)").all().some((c) => c.name === "last_interacted")) {
  throw new Error("migration failed: relationships.last_interacted missing");
}
console.log("Legacy DB migration: OK (guild_id added, 2 vectors moved, facts re-keyed to user:111, last_interacted added)");

// --- New message in the upgraded DB, then full hybrid retrieval ---
const newId = logMessage(db, {
  channelId: "chan-1", authorId: "111", authorName: "Marco",
  content: "do you remember that time with the pc build?", createdAt: Date.now(), guildId: "guild-1",
});
db.prepare("INSERT INTO vec_messages_v(message_id, embedding) VALUES (?, ?)")
  .run(BigInt(newId), Buffer.from(new Float32Array(new Array(384).fill(0.22)).buffer));

const context = buildContext(db, {
  message: {
    channelId: "chan-1", authorId: "111", authorName: "Marco",
    content: "do you remember that time with the pc build?", guildId: "guild-1",
  },
  embedVector: new Array(384).fill(0.22),
  deepRecall: true,
  personalityPath: "personality.txt",
});
if (!context.memoryBlock.includes("Marco is building a new PC")) throw new Error("retrieval failed: speaker fact not surfaced");
if (!context.memoryBlock.includes("Marco is talking to you right now")) throw new Error("recognition failed: speaker identity not surfaced");
if (!context.memoryBlock.includes("pc together") && !context.memoryBlock.includes("pizza")) throw new Error("retrieval failed: old memories not surfaced");
console.log("Hybrid retrieval after migration: OK (facts + old semantic memories surfaced)");
console.log(`Estimated context tokens: ${context.estimatedTokens}`);
db.close();
rmSync(directory, { recursive: true });
console.log("ALL MIGRATION CHECKS PASSED");
