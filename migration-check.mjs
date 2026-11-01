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
const id1 = old.prepare(
  "INSERT INTO messages(channel_id, author_id, author_name, content, created_at) VALUES (?, ?, ?, ?, ?)"
).run("chan-1", "111", "Marco", "we built the pc together", base).lastInsertRowid;
const id2 = old.prepare(
  "INSERT INTO messages(channel_id, author_id, author_name, content, created_at) VALUES (?, ?, ?, ?, ?)"
).run("chan-1", "111", "Marco", "and the pizza that night was unreal", base + 3_600_000).lastInsertRowid;
old.prepare("INSERT INTO facts(subject, fact, first_seen, last_seen) VALUES (?, ?, ?, ?)")
  .run("user:Marco", "Marco is building a new PC", base, base);
old.prepare("INSERT INTO vec_messages(message_id, embedding) VALUES (?, ?)")
  .run(id1, Buffer.from(new Float32Array(new Array(384).fill(0.11)).buffer));
old.prepare("INSERT INTO vec_messages(message_id, embedding) VALUES (?, ?)")
  .run(id2, Buffer.from(new Float32Array(new Array(384).fill(0.13)).buffer));
old.close();

// --- Open it with the patched bot: all migrations must run in place ---
const db = createMemoryDb(dbPath);
const columns = db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
if (!columns.includes("guild_id")) throw new Error("migration failed: guild_id missing");
if (!columns.includes("username")) throw new Error("migration failed: username missing");
if (!columns.includes("is_bot")) throw new Error("migration failed: is_bot missing");
const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_messages'").get();
if (legacyTable) throw new Error("migration failed: legacy vec_messages still present");
const vecCount = db.prepare("SELECT COUNT(*) AS c FROM vec_messages_v").get().c;
if (vecCount !== 2) throw new Error(`migration failed: expected 2 migrated vectors, got ${vecCount}`);
const rekeyed = db.prepare("SELECT subject FROM facts WHERE fact LIKE '%PC%'").get();
if (rekeyed?.subject !== "user:111") throw new Error(`migration failed: fact re-key produced ${rekeyed?.subject}`);
const version = db.pragma("user_version", { simple: true });
if (version !== 5) throw new Error(`migration failed: user_version = ${version}`);
if (!db.prepare("PRAGMA table_info(relationships)").all().some((c) => c.name === "last_interacted")) {
  throw new Error("migration failed: relationships.last_interacted missing");
}
console.log("Legacy DB migration: OK (guild_id + username added, 2 vectors moved, facts re-keyed to user:111, last_interacted added)");

// --- New message in the upgraded DB, then full hybrid retrieval ---
const newId = logMessage(db, {
  channelId: "chan-1", authorId: "111", authorName: "Marco", username: "marco_p",
  content: "do you remember that time with the pc build?", createdAt: Date.now(), guildId: "guild-1",
});
db.prepare("INSERT INTO vec_messages_v(message_id, embedding) VALUES (?, ?)")
  .run(BigInt(newId), Buffer.from(new Float32Array(new Array(384).fill(0.22)).buffer));
db.prepare("INSERT INTO relationships(user_id, affinity, last_interacted) VALUES (?, ?, ?)")
  .run("111", 0.8, Date.now() - 3 * 86_400_000);

const context = buildContext(db, {
  message: {
    channelId: "chan-1", authorId: "111", authorName: "Marco",
    content: "do you remember that time with the pc build?", guildId: "guild-1",
  },
  embedVector: new Array(384).fill(0.22),
  deepRecall: true,
  personalityPath: "personality.txt",
  botId: "bot-1",
});
if (!context.memoryBlock.includes("Marco is building a new PC")) throw new Error("retrieval failed: speaker fact not surfaced");
if (!context.memoryBlock.includes("Marco (@marco_p) is talking to you right now")) throw new Error("recognition failed: speaker identity not surfaced");
if (!context.memoryBlock.includes("(@marco_p)")) throw new Error("recognition failed: username handle not surfaced");
if (!context.memoryBlock.includes("pc together") && !context.memoryBlock.includes("pizza")) throw new Error("retrieval failed: old memories not surfaced");
console.log("Hybrid retrieval after migration: OK (facts + old semantic memories + roster surfaced)");
console.log(`Estimated context tokens: ${context.estimatedTokens}`);
db.close();
rmSync(directory, { recursive: true, force: true });
console.log("ALL MIGRATION CHECKS PASSED");
