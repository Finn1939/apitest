import PQueue from "p-queue";
import { pipeline } from "@huggingface/transformers";
import { completeAI } from "./ai.js";
import { PROMPT_B, PROMPT_C, PROMPT_D } from "./prompts.js";

let embedder;

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
  }
  return embedder;
}

export async function embedText(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data.slice(0, 384), Number);
}

export function createJobs(db) {
  const writeQueue = new PQueue({ concurrency: 1 });
  const backgroundQueue = new PQueue({ concurrency: 1 });

  async function embedMessage(messageId, content) {
    if (!content?.trim()) return;
    const vector = await embedText(content);
    const blob = Buffer.from(new Float32Array(vector).buffer);
    // vec0 primary keys require true INTEGER bindings; BigInt guarantees that
    // across better-sqlite3 versions (plain numbers can bind as REAL).
    const id = BigInt(messageId);
    db.prepare("DELETE FROM vec_messages_v WHERE message_id = ?").run(id);
    db.prepare("INSERT INTO vec_messages_v(message_id, embedding) VALUES (?, ?)").run(id, blob);
  }

  function enqueueEmbedding(messageId, content) {
    writeQueue.add(async () => {
      await embedMessage(messageId, content);
    }).catch((error) => {
      console.error("Embedding failed; message will be retried:", error);
      writeQueue.add(() => embedMessage(messageId, content));
    });
  }

  async function consolidate(channelId) {
    const pending = db.prepare(`
      SELECT id, author_id, author_name, content, created_at FROM messages
      WHERE channel_id = ? AND summarized = 0 ORDER BY id ASC LIMIT 100
    `).all(channelId);
    if (pending.length < 100) return;
    // Map display names from this batch to stable Discord IDs so facts never orphan.
    const roster = new Map(pending.map((entry) => [entry.author_name, entry.author_id]));
    const facts = db.prepare("SELECT subject, fact, confidence FROM facts ORDER BY last_seen DESC LIMIT 200").all();
    const prompt = PROMPT_B
      .replace("<existing_facts>", `<existing_facts>${facts.map((fact) => `${fact.subject}: ${fact.fact}`).join("\n")}</existing_facts>`)
      .replace("<messages>", `<messages>${pending.map((entry) => `${entry.author_name}: ${entry.content}`).join("\n")}</messages>`);
    let result = await completeAI({
      messages: [{ role: "system", content: prompt }],
      thinking: true,
      maxTokens: 1024,
      temperature: 0.7,
    });
    let parsed;
    try {
      parsed = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] || "{}");
    } catch (error) {
      console.error("Consolidation returned invalid JSON:", error.message);
      return;
    }
    const now = Date.now();
    db.transaction(() => {
      if (parsed.summary && parsed.summary.trim()) {
        db.prepare(`
          INSERT INTO summaries(channel_id, span_start, span_end, summary, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(channelId, pending[0].id, pending.at(-1).id, parsed.summary.trim(), now);
      }
      for (const fact of parsed.facts || []) {
        if (!fact?.fact || !fact?.subject) continue;
        const subject = fact.subject.startsWith("user:")
          ? `user:${roster.get(fact.subject.slice(5)) ?? fact.subject.slice(5)}`
          : fact.subject;
        const confidence = Math.min(1, Number(fact.confidence) || 0.9);
        const existing = db.prepare("SELECT id FROM facts WHERE subject = ? AND fact = ?").get(subject, fact.fact);
        if (existing) {
          // Reinforce instead of duplicating: refreshed facts never decay away.
          db.prepare("UPDATE facts SET hits = hits + 1, last_seen = ?, confidence = MAX(confidence, ?) WHERE id = ?")
            .run(now, confidence, existing.id);
        } else {
          db.prepare(`
            INSERT INTO facts(subject, fact, confidence, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?)
          `).run(subject, fact.fact, confidence, now, now);
        }
      }
      db.prepare("UPDATE messages SET summarized = 1 WHERE id BETWEEN ? AND ? AND channel_id = ?")
        .run(pending[0].id, pending.at(-1).id, channelId);
    })();
  }

  function reflect() {
    const model = db.prepare("SELECT persona FROM self_model WHERE id = 1").get()?.persona || "";
    const summaries = db.prepare("SELECT summary FROM summaries ORDER BY created_at DESC LIMIT 20").all();
    const facts = db.prepare("SELECT subject, fact FROM facts ORDER BY hits DESC LIMIT 50").all();
    const journal = db.prepare("SELECT entry FROM journal ORDER BY created_at DESC LIMIT 5").all();
    return completeAI({
      messages: [{
        role: "system",
        content: PROMPT_C.replace("{{SELF_MODEL}}", model)
          .replace("{{SUMMARIES}}", summaries.map((row) => row.summary).join("\n"))
          .replace("{{FACTS}}", facts.map((row) => `${row.subject}: ${row.fact}`).join("\n"))
          .replace("{{JOURNAL}}", journal.map((row) => row.entry).join("\n---\n")),
      }],
      thinking: true,
      maxTokens: 300,
    }).then((persona) => {
      if (!persona.trim()) return;
      db.transaction(() => {
        db.prepare("INSERT INTO self_model_history(persona, updated_at) VALUES (?, ?)")
          .run(model, Date.now());
        db.prepare("UPDATE self_model SET persona = ?, updated_at = ? WHERE id = 1")
          .run(persona.trim().slice(0, 900), Date.now());
      })();
    });
  }

  function decay() {
    const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE facts SET confidence = confidence * 0.8 WHERE last_seen < ?").run(cutoff);
    db.prepare("DELETE FROM facts WHERE confidence < 0.2").run();
  }

  // Nightly diary: how today felt, in her own voice. Feeds the weekly self-reflection.
  async function writeJournal() {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const summaries = db.prepare("SELECT summary FROM summaries WHERE created_at >= ? ORDER BY created_at ASC LIMIT 30")
      .all(since);
    if (!summaries.length) return;
    const facts = db.prepare("SELECT subject, fact FROM facts ORDER BY last_seen DESC LIMIT 30").all();
    const entry = await completeAI({
      messages: [{
        role: "system",
        content: PROMPT_D
          .replace("{{SUMMARIES}}", summaries.map((row) => row.summary).join("\n"))
          .replace("{{FACTS}}", facts.map((row) => `${row.subject}: ${row.fact}`).join("\n")),
      }],
      thinking: true,
      maxTokens: 220,
      temperature: 0.9,
    });
    const text = entry.trim();
    if (text) {
      db.prepare("INSERT INTO journal(entry, created_at) VALUES (?, ?)").run(text.slice(0, 1200), Date.now());
    }
  }

  return { writeQueue, backgroundQueue, enqueueEmbedding, consolidate, reflect, decay, writeJournal };
}
