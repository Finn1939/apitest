import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";

export function createMemoryDb(filePath) {
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
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      summarized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vec_messages (
      message_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL
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
      notes TEXT NOT NULL DEFAULT ''
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
  return db;
}
