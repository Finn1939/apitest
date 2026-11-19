import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROMPT_A } from "./prompts.js";

export const HISTORY_LIMIT = 40;
export const FACT_LIMIT = 150;
export const MEMORY_FILE = resolve(process.env.MEMORY_FILE || "data/channel-memory.json");

export function addHistory(history, entry, limit = HISTORY_LIMIT) {
  return [...history, entry].slice(-limit);
}

export function addFact(facts, fact) {
  if (!fact || facts.includes(fact)) return facts;
  return [...facts, fact].slice(-FACT_LIMIT);
}

export function parseRememberCommand(prompt) {
  const match = prompt.match(/^remember(?:\s+that)?\s*[:\-]?\s*(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function loadMemory(filePath = MEMORY_FILE) {
  try {
    const stored = JSON.parse(readFileSync(filePath, "utf8"));
    return {
      conversations: new Map(Object.entries(stored.conversations || {})),
      facts: new Map(Object.entries(stored.facts || {})),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { conversations: new Map(), facts: new Map() };
    }
    throw new Error(`Failed to load memory from ${filePath}: ${error.message}`);
  }
}

export function saveMemory(conversations, facts, filePath = MEMORY_FILE) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.tmp`;
  const stored = {
    conversations: Object.fromEntries(conversations),
    facts: Object.fromEntries(facts),
  };
  writeFileSync(temporaryFile, `${JSON.stringify(stored, null, 2)}\n`);
  renameSync(temporaryFile, filePath);
}

const estimatedTokens = (text) => Math.ceil(String(text).length / 4);

function affinityTier(affinity) {
  if (affinity >= 4) return "one of your closest people in this server";
  if (affinity >= 1.5) return "a regular you are genuinely fond of";
  if (affinity >= 0.5) return "a familiar face you like talking to";
  if (affinity >= 0.2) return "an acquaintance you are starting to know";
  return "someone you barely know yet";
}

function affinityBehavior(affinity) {
  if (affinity >= 4) return "With them: fully relaxed — inside jokes, sharp teasing, warm shorthand, zero formalities.";
  if (affinity >= 1.5) return "With them: warm and casual, like texting a good friend.";
  if (affinity >= 0.5) return "With them: friendly, curious, natural.";
  if (affinity >= 0.2) return "With them: casual and observant; still feeling out their vibe.";
  return "With them: confident, sharp, briefly sizing them up.";
}

function romanceLevelLine(romance) {
  if (romance >= 4) {
    return "You are deeply attached to them — softer around the edges with them while keeping your voice. Never force a formal confession; keep it sweet and non-explicit.";
  }
  if (romance >= 3) {
    return "You are genuinely falling for them — softer, honest warmth slipping through your teasing. Keep it sweet and non-explicit.";
  }
  if (romance >= 2) {
    return "You have a real crush on them — lighter when they show up, noticing when they're quiet. Keep it subtle, sweet, and non-explicit.";
  }
  if (romance >= 1) {
    return "A small spark might be budding — just a bit of extra warmth when they talk.";
  }
  return "";
}

export function relationshipSummary({ affinity = 0, romance = 0, lastInteracted = 0 } = {}) {
  const friendLabel = affinity >= 4 ? "one of her closest people"
    : affinity >= 1.5 ? "a regular she's genuinely fond of"
    : affinity >= 0.5 ? "a familiar face she likes talking to"
    : affinity >= 0.2 ? "an acquaintance she's starting to know"
    : "someone she's still getting to know";
  const effectiveRomance = Math.min(romance, affinity + 1);
  const romanceLabel = effectiveRomance >= 4 ? "is in love with you — the real, quiet kind"
    : effectiveRomance >= 3 ? "is genuinely falling for you"
    : effectiveRomance >= 2 ? "has a real crush on you"
    : effectiveRomance >= 1 ? "might have a tiny crush on you"
    : null;
  const days = lastInteracted > 0 ? Math.floor((Date.now() - lastInteracted) / 86_400_000) : null;
  return { friendLabel, romanceLabel, effectiveRomance, daysSinceTalk: days };
}

export function forgetFacts(db, subject, query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`);
  const rows = db.prepare(
    "SELECT id, fact FROM facts WHERE subject = ? AND fact LIKE ? ESCAPE '\\' LIMIT 20",
  ).all(subject, `%${escaped}%`);
  if (!rows.length) return [];
  const removal = db.prepare("DELETE FROM facts WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) removal.run(row.id);
  })();
  return rows.map((row) => row.fact);
}

export function upsertGuildMember(db, guildId, member) {
  if (!guildId || !member?.id) return;
  const user = member.user || {};
  const roles = [...(member.roles?.cache?.values?.() || [])]
    .filter((r) => r && r.id !== guildId)
    .map((r) => r.name);
  db.prepare(`
    INSERT INTO guild_members(
      guild_id, user_id, username, global_name, display_name, nickname,
      roles_json, joined_at, is_bot, in_voice_channel_id, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      username = excluded.username,
      global_name = excluded.global_name,
      display_name = excluded.display_name,
      nickname = excluded.nickname,
      roles_json = excluded.roles_json,
      joined_at = COALESCE(NULLIF(excluded.joined_at, 0), guild_members.joined_at),
      is_bot = excluded.is_bot,
      in_voice_channel_id = excluded.in_voice_channel_id,
      last_seen_at = MAX(guild_members.last_seen_at, excluded.last_seen_at)
  `).run(
    guildId,
    member.id,
    user.username || member.username || "",
    user.globalName || "",
    member.displayName || user.globalName || user.username || member.id,
    member.nickname || "",
    JSON.stringify(roles),
    member.joinedTimestamp || 0,
    user.bot ? 1 : 0,
    member.voice?.channelId || "",
    Date.now(),
  );
}

export function removeGuildMember(db, guildId, userId) {
  if (!guildId || !userId) return;
  db.prepare("DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
}

export function updateMemberVoiceState(db, guildId, userId, voiceChannelId = "") {
  if (!guildId || !userId) return;
  db.prepare("UPDATE guild_members SET in_voice_channel_id = ?, last_seen_at = ? WHERE guild_id = ? AND user_id = ?")
    .run(voiceChannelId || "", Date.now(), guildId, userId);
}

export async function syncGuildDirectory(db, guild) {
  if (!guild?.id) return { memberCount: 0, channelCount: 0, roleCount: 0 };
  let members = [];
  try {
    const fetched = await guild.members.fetch();
    members = [...fetched.values()];
  } catch {
    members = [...(guild.members?.cache?.values?.() || [])];
  }

  let channels = [];
  try {
    const fetchedChannels = await guild.channels.fetch();
    channels = [...fetchedChannels.values()].filter(Boolean);
  } catch {
    channels = [...(guild.channels?.cache?.values?.() || [])];
  }

  let roles = [];
  try {
    const fetchedRoles = await guild.roles.fetch();
    roles = [...fetchedRoles.values()].filter((r) => r && r.id !== guild.id);
  } catch {
    roles = [...(guild.roles?.cache?.values?.() || [])].filter((r) => r && r.id !== guild.id);
  }

  const now = Date.now();
  db.transaction(() => {
    for (const member of members) {
      upsertGuildMember(db, guild.id, member);
    }
    const snapshot = {
      channels: channels.slice(0, 60).map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId || null })),
      roles: roles.sort((a, b) => b.position - a.position).slice(0, 40).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
    };
    db.prepare(`
      INSERT INTO guild_state(guild_id, name, owner_id, member_count, snapshot_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        name = excluded.name,
        owner_id = excluded.owner_id,
        member_count = excluded.member_count,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(guild.id, guild.name || "", guild.ownerId || "", guild.memberCount || members.length, JSON.stringify(snapshot), now);
  })();

  return { memberCount: members.length, channelCount: channels.length, roleCount: roles.length };
}

export function getServerKnowledgeSummary(db, guildId, queryText = "") {
  if (!guildId) return "Direct Message context (no server directory).";
  const state = db.prepare("SELECT name, owner_id, member_count, snapshot_json FROM guild_state WHERE guild_id = ?").get(guildId);
  const allMembers = db.prepare(`
    SELECT user_id, username, display_name, roles_json, is_bot, in_voice_channel_id
    FROM guild_members
    WHERE guild_id = ?
    ORDER BY is_bot ASC, last_seen_at DESC
  `).all(guildId);

  const lines = [];
  if (state) {
    lines.push(`Server: ${state.name} (${state.member_count || allMembers.length} members, owner ID ${state.owner_id})`);
    try {
      const snap = JSON.parse(state.snapshot_json || "{}");
      if (Array.isArray(snap.channels) && snap.channels.length) {
        lines.push(`Channels (${snap.channels.length}): ${snap.channels.slice(0, 30).map((c) => `#${c.name}`).join(", ")}`);
      }
      if (Array.isArray(snap.roles) && snap.roles.length) {
        lines.push(`Roles (${snap.roles.length}): ${snap.roles.slice(0, 25).map((r) => r.name).join(", ")}`);
      }
    } catch {
      // ignore malformed snapshot
    }
  }

  const inVoice = allMembers.filter((m) => m.in_voice_channel_id);
  if (inVoice.length) {
    lines.push(`Currently in voice: ${inVoice.map((m) => `${m.display_name} (<#${m.in_voice_channel_id}>)`).join(", ")}`);
  }

  if (allMembers.length) {
    const queryLower = String(queryText || "").toLowerCase();
    const highlighted = allMembers.filter((m) =>
      queryLower && (
        queryLower.includes(m.display_name.toLowerCase()) ||
        queryLower.includes(m.username.toLowerCase()) ||
        queryLower.includes(m.user_id)
      ),
    );
    const sample = [...new Map([...highlighted, ...allMembers.slice(0, 35)].map((m) => [m.user_id, m])).values()].slice(0, 40);
    lines.push(`Synced Server Members (${allMembers.length} known):`);
    for (const m of sample) {
      let rolesList = [];
      try { rolesList = JSON.parse(m.roles_json || "[]"); } catch { rolesList = []; }
      const roleBit = rolesList.length ? ` [${rolesList.slice(0, 4).join(", ")}]` : "";
      const botBit = m.is_bot ? " [bot]" : "";
      lines.push(`- ${m.display_name}${m.username && m.username !== m.display_name ? ` (@${m.username})` : ""} (id:${m.user_id})${roleBit}${botBit}`);
    }
  }

  return lines.join("\n") || "Server directory syncing...";
}

function timeAgo(timestamp) {
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function buildContext(db, {
  message,
  embedVector,
  deepRecall = false,
  personalityPath = "personality.txt",
  personality: providedPersonality,
  botId,
  replyTo,
}) {
  const personality = providedPersonality ?? readFileSync(personalityPath, "utf8").trim();
  const selfModel = db.prepare("SELECT persona FROM self_model WHERE id = 1").get()?.persona || "";
  const rel = db.prepare("SELECT affinity, romance, last_interacted FROM relationships WHERE user_id = ?").get(message.authorId);

  const nowTs = Date.now();
  const speakerRow = db.prepare(`
    SELECT COALESCE(NULLIF(author_name, ''), ?) AS display_name,
           NULLIF(username, '') AS handle
    FROM messages WHERE author_id = ? ORDER BY id DESC LIMIT 1
  `).get(message.authorName, message.authorId);
  const speakerName = speakerRow?.display_name || message.authorName;
  const speakerHandle = speakerRow?.handle ? ` (@${speakerRow.handle})` : "";

  const speakerLines = [`${speakerName}${speakerHandle} is talking to you right now (Discord user ID: ${message.authorId}).`];
  if (message.channelName) {
    speakerLines.push(`You are currently speaking inside live channel #${message.channelName} (channel ID: ${message.channelId}${message.channelTopic ? `, topic: "${message.channelTopic}"` : ""}).`);
  }
  if (rel) {
    const daysSince = rel.last_interacted > 0 ? (nowTs - rel.last_interacted) / 86_400_000 : 0;
    speakerLines.push(`You see them as ${affinityTier(rel.affinity)}. ${affinityBehavior(rel.affinity)}`);
    if (rel.last_interacted > 0 && daysSince >= 3 && rel.affinity >= 0.5) {
      speakerLines.push(`You haven't talked in ${Math.floor(daysSince)} days.`);
    }
    const effectiveRomance = Math.min(rel.romance ?? 0, rel.affinity + 1);
    const romanceLine = romanceLevelLine(effectiveRomance);
    if (romanceLine) speakerLines.push(romanceLine);
  } else {
    speakerLines.push(`This is your first real interaction with ${speakerName} — treat them like someone new in the server.`);
  }

  if (replyTo) {
    const quoted = replyTo.content ? ` ("${replyTo.content}")` : "";
    const recency = replyTo.ageMs >= 60 * 60_000
      ? ` from ${Math.floor(replyTo.ageMs / (60 * 60_000))} hours ago`
      : "";
    const target = replyTo.isSelf ? "your earlier message" : `${replyTo.authorName}'s message`;
    speakerLines.push(`They sent this as a Discord reply to ${target}${quoted}${recency}.`);
    if (replyTo.isSelf) {
      speakerLines.push('Their reply is addressed directly to you. Pronouns such as "you" and "your" refer to you; pronouns such as "I" and "me" refer to the replying user.');
    } else {
      speakerLines.push(`When they say "he", "him" or "his", they most likely mean ${replyTo.authorName}.`);
      speakerLines.push(`Only if they directly ask who they are replying to: the answer is ${replyTo.authorName}.`);
    }
  }

  if (message.pointingAtBot) {
    speakerLines.push(
      `Their message is pointing at ${message.pointingAtBot}'s message above — read that message in the recent conversation to see what they mean.`,
    );
  }

  if (message.reactionsSeen) {
    speakerLines.push(`Reactions people recently left on your messages: ${message.reactionsSeen}.`);
  }

  const speakerText = speakerLines.join(" ");

  const rosterRows = db.prepare(`
    SELECT author_id, author_name, is_bot,
           COALESCE(NULLIF(username, ''), NULLIF(author_name, ''), author_id) AS handle,
           MAX(created_at) AS last_active
    FROM messages
    WHERE created_at >= ? AND author_id != ? AND (guild_id = ? OR guild_id = '')
    GROUP BY author_id
    ORDER BY is_bot ASC, last_active DESC
    LIMIT 20
  `).all(Date.now() - 30 * 86_400_000, botId || "", message.guildId || "");

  const rosterText = rosterRows.length
    ? rosterRows.map((row) => {
        const hasHandle = row.handle !== row.author_name;
        return `- ${row.author_name}${hasHandle ? ` (@${row.handle})` : ""}${row.is_bot ? " [a bot]" : ""} — last spoke ${timeAgo(row.last_active)}`;
      }).join("\n")
    : "";

  const serverKnowledge = getServerKnowledgeSummary(db, message.guildId || "", message.content);

  const speakerFacts = db.prepare(`
    SELECT fact, confidence FROM facts
    WHERE subject = ?
    ORDER BY hits DESC, last_seen DESC
  `).all(`user:${message.authorId}`);
  const factsText = speakerFacts.length
    ? `What you know about ${speakerName}:\n${speakerFacts.map(({ fact, confidence }) =>
      `- [${confidence.toFixed(2)}] ${fact}`).join("\n")}`
    : "";

  const recent = db.prepare(`
    SELECT author_id, author_name, content, is_bot FROM messages
    WHERE channel_id = ?
    ORDER BY id DESC LIMIT 500
  `).all(message.channelId).reverse();

  const MAX_OTHER_BOT_LINES = 4;
  const keepBotLine = new Set();
  let keptBots = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const row = recent[index];
    if (row.is_bot && row.author_id !== botId) {
      if (keptBots < MAX_OTHER_BOT_LINES) {
        keepBotLine.add(index);
        keptBots += 1;
      }
    }
  }

  const recentText = recent.map((entry, index) => {
    if (botId && entry.author_id === botId) return `You: ${entry.content}`;
    if (entry.is_bot) {
      return keepBotLine.has(index) ? `${entry.author_name} [bot]: ${entry.content}` : null;
    }
    return `${entry.author_name}: ${entry.content}`;
  }).filter(Boolean).join("\n");

  const summaries = db.prepare(`
    SELECT summary FROM summaries WHERE channel_id = ? ORDER BY created_at DESC LIMIT 3
  `).all(message.channelId).map(({ summary }) => summary).join("\n");

  const relevantColumns = "m.id, m.author_name, m.content, m.importance, m.created_at, m.guild_id";
  const guildClause = message.guildId ? "AND (m.guild_id = ? OR m.guild_id = '')" : "";
  const ranked = new Map();
  const addRanked = (rows) => rows.forEach((row, rank) => {
    const entry = ranked.get(row.id);
    if (entry) entry.score += 1 / (60 + rank + 1);
    else ranked.set(row.id, { row, score: 1 / (60 + rank + 1) });
  });

  const terms = [...new Set((String(message.content || "").toLowerCase().match(/[a-z0-9']{4,}/g) || []))].slice(0, 8);
  if (terms.length) {
    try {
      const ftsQuery = terms.map((term) => `"${term}"`).join(" OR ");
      const ftsSql = `
        SELECT ${relevantColumns}
        FROM fts_messages
        JOIN messages m ON m.id = fts_messages.rowid
        WHERE fts_messages MATCH ? ${guildClause}
        LIMIT 12
      `;
      const ftsRows = message.guildId
        ? db.prepare(ftsSql).all(ftsQuery, message.guildId)
        : db.prepare(ftsSql).all(ftsQuery);
      addRanked(ftsRows);
    } catch {
      // ignore FTS syntax edge cases
    }
  }

  if (embedVector?.length === 384) {
    try {
      const k = deepRecall ? 24 : 12;
      const vecRows = db.prepare(`
        SELECT ${relevantColumns}
        FROM (SELECT message_id, distance FROM vec_messages_v WHERE embedding MATCH ? AND k = ${k}) v
        JOIN messages m ON m.id = v.message_id
      `).all(Buffer.from(new Float32Array(embedVector).buffer));
      addRanked(vecRows);
    } catch {
      // fallback to FTS only
    }
  }

  const now = Date.now();
  const uniqueRelevant = [...ranked.values()]
    .filter(({ row }) => !message.guildId || !row.guild_id || row.guild_id === message.guildId)
    .map(({ row, score }) => ({
      row,
      score: score * 0.7
        + 0.2 * Math.exp(-(now - row.created_at) / (30 * 24 * 60 * 60 * 1000))
        + 0.1 * (row.importance ?? 0.5),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, deepRecall ? 32 : 24)
    .map(({ row }) => row);

  const relevantText = [summaries, ...uniqueRelevant.map((row) => `${row.author_name}: ${row.content}`)]
    .filter(Boolean)
    .join("\n");

  const memoryBlock = PROMPT_A
    .replace("{{SELF_MODEL}}", () => selfModel)
    .replace("{{SERVER_KNOWLEDGE}}", () => serverKnowledge)
    .replace("{{SPEAKER}}", () => speakerText)
    .replace("{{ROSTER}}", () => rosterText || "No recent speakers recorded yet.")
    .replace("{{USER_FACTS}}", () => factsText || `You know nothing specific about ${speakerName} yet.`)
    .replace("{{RELEVANT_MEMORIES}}", () => relevantText || "No relevant memories.")
    .replace("{{RECENT_MESSAGES}}", () => recentText || "No recent messages.");

  return {
    personality,
    memoryBlock,
    estimatedTokens: estimatedTokens(`${personality}\n${memoryBlock}`),
  };
}

export function logMessage(db, message) {
  return db.prepare(`
    INSERT INTO messages(channel_id, author_id, author_name, username, content, created_at, importance, guild_id, is_bot, discord_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.channelId,
    message.authorId,
    message.authorName,
    message.username || "",
    message.content.slice(0, 2000),
    message.createdAt,
    message.importance ?? 0.5,
    message.guildId || "",
    message.isBot ? 1 : 0,
    message.discordId || "",
  ).lastInsertRowid;
}

export function updateMessageContentByDiscordId(db, discordId, content) {
  if (!discordId) return false;
  const info = db.prepare("UPDATE messages SET content = ? WHERE discord_id = ?")
    .run(String(content || "").slice(0, 2000), discordId);
  return info.changes > 0;
}

export function softDeleteMessageByDiscordId(db, discordId) {
  if (!discordId) return false;
  const row = db.prepare("SELECT content FROM messages WHERE discord_id = ?").get(discordId);
  if (!row || !row.content || /\(deleted\)\s*$/.test(row.content)) return false;
  db.prepare("UPDATE messages SET content = ? WHERE discord_id = ?")
    .run(`${row.content} (deleted)`, discordId);
  return true;
}
