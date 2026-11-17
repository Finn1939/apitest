import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getLoadablePath } = require("sqlite-vec");

export function createMemoryDb(filePath) {
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
      guild_id TEXT NOT NULL DEFAULT '',
      is_bot INTEGER NOT NULL DEFAULT 0,
      discord_id TEXT NOT NULL DEFAULT ''
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
      last_interacted INTEGER NOT NULL DEFAULT 0,
      romance REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY,
      entry TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
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
      .run("wired into this server and getting a read on everyone here", Date.now());
  }

  if (db.pragma("user_version", { simple: true }) < 2) {
    const columns = db.prepare("PRAGMA table_info(messages)").all();
    if (!columns.some((column) => column.name === "guild_id")) {
      db.exec("ALTER TABLE messages ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''");
    }
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

  if (db.pragma("user_version", { simple: true }) < 5) {
    const msgColumns = db.prepare("PRAGMA table_info(messages)").all();
    if (!msgColumns.some((column) => column.name === "is_bot")) {
      db.exec("ALTER TABLE messages ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
    }
    db.pragma("user_version = 5");
  }

  if (db.pragma("user_version", { simple: true }) < 6) {
    const relColumns = db.prepare("PRAGMA table_info(relationships)").all();
    if (!relColumns.some((column) => column.name === "romance")) {
      db.exec("ALTER TABLE relationships ADD COLUMN romance REAL NOT NULL DEFAULT 0");
    }
    db.pragma("user_version = 6");
  }

  if (db.pragma("user_version", { simple: true }) < 7) {
    const msgColumns = db.prepare("PRAGMA table_info(messages)").all();
    if (!msgColumns.some((column) => column.name === "discord_id")) {
      db.exec("ALTER TABLE messages ADD COLUMN discord_id TEXT NOT NULL DEFAULT ''");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_discord_id ON messages(discord_id)");
    db.pragma("user_version = 7");
  }

  if (db.pragma("user_version", { simple: true }) < 8) {
    db.exec("CREATE TABLE IF NOT EXISTS learned_commands(command TEXT PRIMARY KEY, learned_at INTEGER NOT NULL)");
    db.pragma("user_version = 8");
  }

  // v9: Full server takeover directory (every member, roles, voice status, guild topology, autonomous mood).
  if (db.pragma("user_version", { simple: true }) < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_members (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        global_name TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        nickname TEXT NOT NULL DEFAULT '',
        roles_json TEXT NOT NULL DEFAULT '[]',
        joined_at INTEGER NOT NULL DEFAULT 0,
        is_bot INTEGER NOT NULL DEFAULT 0,
        in_voice_channel_id TEXT NOT NULL DEFAULT '',
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id, is_bot, last_seen_at);
      CREATE TABLE IF NOT EXISTS guild_state (
        guild_id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL DEFAULT '',
        member_count INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS autonomy_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        mood TEXT NOT NULL DEFAULT 'wired and observant',
        energy REAL NOT NULL DEFAULT 0.85,
        current_focus TEXT NOT NULL DEFAULT '',
        last_autonomous_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_discord_id ON messages(discord_id)");
    db.pragma("user_version = 9");
  }

  return db;
}
