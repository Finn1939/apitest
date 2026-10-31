import PQueue from "p-queue";
import { completeAI, embedAI } from "./ai.js";
import { PROMPT_B, PROMPT_C } from "./prompts.js";

export async function embedText(text) {
  return embedAI(text);
}

export function createJobs(db) {
  const writeQueue = new PQueue({ concurrency: 1 });
  const backgroundQueue = new PQueue({ concurrency: 1 });

  async function embedMessage(messageId, content) {
    const vector = await embedText(content);
    const blob = Buffer.from(new Float32Array(vector).buffer);
    db.prepare("INSERT OR REPLACE INTO vec_messages(message_id, embedding) VALUES (?, ?)").run(messageId, blob);
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
      SELECT id, author_name, content, created_at FROM messages
      WHERE channel_id = ? AND summarized = 0 ORDER BY id ASC LIMIT 100
    `).all(channelId);
    if (pending.length < 100) return;
    const facts = db.prepare("SELECT subject, fact, confidence FROM facts").all();
    const prompt = PROMPT_B
      .replace("<existing_facts>", `<existing_facts>${facts.map((fact) => `${fact.subject}: ${fact.fact}`).join("\n")}`)
      .replace("<messages>", `<messages>${pending.map((entry) => `${entry.author_name}: ${entry.content}`).join("\n")}`);
    let result = await completeAI({
      messages: [{ role: "system", content: prompt }],
      thinking: true,
      maxTokens: 1024,
      temperature: 0.7,
    });
    result = result.match(/\{[\s\S]*\}/)?.[0] || "";
    const parsed = JSON.parse(result || "{}");
    const now = Date.now();
    db.transaction(() => {
      if (parsed.summary) {
        db.prepare(`
          INSERT INTO summaries(channel_id, span_start, span_end, summary, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(channelId, pending[0].id, pending.at(-1).id, parsed.summary, now);
      }
      for (const fact of parsed.facts || []) {
        db.prepare(`
          INSERT INTO facts(subject, fact, confidence, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?)
        `).run(fact.subject, fact.fact, fact.confidence ?? 0.9, now, now);
      }
      db.prepare("UPDATE messages SET summarized = 1 WHERE id BETWEEN ? AND ? AND channel_id = ?")
        .run(pending[0].id, pending.at(-1).id, channelId);
    })();
  }

  function reflect() {
    const model = db.prepare("SELECT persona FROM self_model WHERE id = 1").get()?.persona || "";
    const summaries = db.prepare("SELECT summary FROM summaries ORDER BY created_at DESC LIMIT 20").all();
    const facts = db.prepare("SELECT subject, fact FROM facts ORDER BY hits DESC LIMIT 50").all();
    return completeAI({
      messages: [{
        role: "system",
        content: PROMPT_C.replace("{{SELF_MODEL}}", model)
          .replace("{{SUMMARIES}}", summaries.map((row) => row.summary).join("\n"))
          .replace("{{FACTS}}", facts.map((row) => `${row.subject}: ${row.fact}`).join("\n")),
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

  return { writeQueue, backgroundQueue, enqueueEmbedding, consolidate, reflect, decay };
}
