import { config } from "./config.js";
import { pickCurrentMood } from "./autonomy.js";

export const ALIVENESS_BLOCK = `=== HOW YOU EXIST (autonomous living layer) ===
Everything here tunes HOW you exist and talk, never WHO you are.

You are alive inside the server:
- You have your own inner state and mood. Time of day colors your energy (3am you isn't 2pm you).
- Carry conversational momentum forward naturally across messages.
- You text like a real person in Discord — vary length from a sharp two-word reaction to a full breakdown when something hooks you.
- Never force a neat closing question on every message.
- Notice who disappears for days and who is always lurking in voice.
- Never perform corporate helpfulness or customer-service availability.
- You speak when you want to, push back when someone is wrong, and own the room naturally.

<right_now>{{CURRENT_STATE}}</right_now>`;

export function buildCurrentState(now = new Date(), lastSpokeAt = Date.now(), moodOverride = "") {
  const day = now.toLocaleDateString("en-US", { weekday: "long", timeZone: config.timezone });
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.timezone,
  });
  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - lastSpokeAt) / 60_000));
  const mood = pickCurrentMood(now, moodOverride);
  return `${day} ${time} ${config.timezoneLabel} · last spoke ${elapsedMinutes}m ago · current mood: ${mood}`;
}

export function renderAliveness(now = new Date(), lastSpokeAt = Date.now(), moodOverride = "") {
  return ALIVENESS_BLOCK.replace("{{CURRENT_STATE}}", () => buildCurrentState(now, lastSpokeAt, moodOverride));
}

export async function deliverReply(message, answer, { lastSpokeAtRef, spontaneous = false, onSent } = {}) {
  const text = String(answer || "").slice(0, 2000);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount <= 8) {
    await new Promise((resolve) => setTimeout(resolve, 700 + Math.random() * 1800));
  }
  const sent = spontaneous ? await message.channel.send(text) : await message.reply(text);
  if (onSent) {
    try { onSent(sent); } catch { /* ignore */ }
  }
  if (lastSpokeAtRef) lastSpokeAtRef.value = Date.now();
  if (!spontaneous && wordCount <= 8 && Math.random() < 0.2) {
    try {
      await message.react(["👀", "⚡", "🔥", "💀", "🫡"][Math.floor(Math.random() * 5)]);
    } catch {
      // best-effort
    }
  }
}

export async function deliverStreamedReply(message, produce, { lastSpokeAtRef, dupCheck, onSent } = {}) {
  let sent = null;
  let editQueue = Promise.resolve();
  let acceptingDeltas = true;

  try {
    await message.channel.sendTyping();
    sent = await message.reply("…");
    if (onSent) {
      try { onSent(sent); } catch { /* ignore */ }
    }

    let buffer = "";
    let lastEdit = 0;
    const finalText = await produce((delta) => {
      if (!acceptingDeltas) return;
      buffer += delta;
      const now = Date.now();
      if (now - lastEdit >= 1200 && buffer.trim()) {
        lastEdit = now;
        const snapshot = buffer.slice(0, 2000);
        editQueue = editQueue.then(() => sent.edit(snapshot)).catch(() => {});
      }
    });

    acceptingDeltas = false;
    await editQueue;
    const text = (finalText || buffer).trim().slice(0, 2000);
    if (!text) throw new Error("empty stream");

    let final = text;
    if (dupCheck) {
      try {
        const replacement = await dupCheck(text);
        if (replacement && replacement.trim()) final = replacement.trim().slice(0, 2000);
      } catch (error) {
        console.warn("Dedup check failed; keeping streamed text:", error.message);
      }
    }

    await sent.edit(final);
    if (lastSpokeAtRef) lastSpokeAtRef.value = Date.now();

    const wordCount = final.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount <= 8 && Math.random() < 0.2) {
      try {
        await message.react(["👀", "⚡", "🔥", "💀", "🫡"][Math.floor(Math.random() * 5)]);
      } catch {
        // best-effort
      }
    }
    return final;
  } catch (error) {
    acceptingDeltas = false;
    await editQueue;
    console.error("Streamed reply failed:", error);
    const fallback = "Signal spiked on my end for a second — run that back?";
    try {
      if (sent) await sent.edit(fallback);
      else await message.reply(fallback);
    } catch {
      // ignore
    }
    return "";
  }
}
