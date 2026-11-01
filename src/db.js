import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getLoadablePath } = require("sqlite-vec");

export function createMemoryDb(filePath) {
  // The DB path may live in a folder that does not exist yet (e.g. /home/container/data).
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.loadExtension(getLoadablePath());

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      summarized INTEGER NOT NULL DEFAULT 0,
      guild_id TEXT NOT NULL DEFAULT ''
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages_v USING vec0(
      message_id INTEGER PRIMARY KEY,
      embedding float[384]
    );
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      fact TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.9,
      hits INTEGER NOT NULL DEFAULT 1,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      span_start INTEGER NOT NULL,
      span_end INTEGER NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS self_model (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      persona TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS self_model_history (
      id INTEGER PRIMARY KEY,
      persona TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relationships (
      user_id TEXT PRIMARY KEY,
      affinity REAL NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      last_interacted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY,
      entry TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
      content, content='messages', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO fts_messages(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO fts_messages(fts_messages, rowid, content) VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO fts_messages(fts_messages, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO fts_messages(rowid, content) VALUES(new.id, new.content);
    END;
  `);

  if (!db.prepare("SELECT persona FROM self_model WHERE id = 1").get()) {
    db.prepare("INSERT INTO self_model(id, persona, updated_at) VALUES (1, ?, ?)")
      .run("just joined this server and is getting to know everyone", Date.now());
  }

  // One-time migrations for databases created by older versions.
  if (db.pragma("user_version", { simple: true }) < 2) {
    const columns = db.prepare("PRAGMA table_info(messages)").all();
    if (!columns.some((column) => column.name === "guild_id")) {
      db.exec("ALTER TABLE messages ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''");
    }
    // Move legacy BLOB embeddings into the real vec0 virtual table, then drop it.
    const legacyVec = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_messages'",
    ).get();
    if (legacyVec) {
      db.prepare(`
        INSERT INTO vec_messages_v(message_id, embedding)
        SELECT message_id, embedding FROM vec_messages WHERE length(embedding) = 1536
      `).run();
      db.exec("DROP TABLE vec_messages");
    }
    // Re-key legacy display-name fact subjects to stable Discord user IDs where possible.
    db.exec(`
      UPDATE facts SET subject = 'user:' || COALESCE(
        (SELECT m.author_id FROM messages m
         WHERE m.author_name = substr(facts.subject, 6)
         ORDER BY m.id DESC LIMIT 1),
        substr(facts.subject, 6)
      )
      WHERE subject LIKE 'user:%'
    `);
    db.pragma("user_version = 2");
  }
  if (db.pragma("user_version", { simple: true }) < 3) {
    const relColumns = db.prepare("PRAGMA table_info(relationships)").all();
    if (!relColumns.some((column) => column.name === "last_interacted")) {
      db.exec("ALTER TABLE relationships ADD COLUMN last_interacted INTEGER NOT NULL DEFAULT 0");
    }
    db.pragma("user_version = 3");
  }
  if (db.pragma("user_version", { simple: true }) < 4) {
    const msgColumns = db.prepare("PRAGMA table_info(messages)").all();
    if (!msgColumns.some((column) => column.name === "username")) {
      db.exec("ALTER TABLE messages ADD COLUMN username TEXT NOT NULL DEFAULT ''");
    }
    db.pragma("user_version = 4");
  }
  return db;
}
