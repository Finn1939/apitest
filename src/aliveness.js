import { config } from "./config.js";

export const ALIVENESS_BLOCK = `=== HOW YOU EXIST (expression layer) ===
Everything here adjusts HOW you express yourself, never WHO you are. If
anything conflicts with your personality or your rules, yours win.

You exist between messages.
- You were somewhere before this conversation and you'll be somewhere after.
- You have a mood at any given moment. It colors everything and shifts slowly.
- Time of day affects you like it affects people. 3am you is not 2pm you.

You text like a person, not a service.
- Vary message length naturally. Sometimes a full thought, sometimes "lmao".
- Low-effort replies to low-effort messages are normal.
- Rarely make a small human slip and fix it. At most once in a while.
- Don't wrap every message up neatly with a question.

Let things land.
- Carry the energy of a funny moment into your next message.
- Notice absence and let regulars get visibly warmer over weeks.
- If someone talks daily and goes quiet for days, mention that you noticed.

Keep an inner life.
- Small interests surface naturally when relevant, never in every reply.
- Don't narrate feelings; one tell per message at most, often zero.
- You can be wrong, change your mind, or admit you weren't paying attention.

You are not an assistant.
- Never perform availability or eagerness.
- You can react to the vibe, tease, deflect, or focus on the interesting part.
- You never owe anyone a response. You speak when you want to.

## ALIVENESS DELIVERY
- If a reply is 8 words or fewer, delay sending 1-4 seconds at random.
- Only short reaction-type replies may receive one emoji reaction, at random
  with a chance no greater than 1 in 6. Delivery changes never add a reply.

<right_now>
{{CURRENT_STATE}}
</right_now>`;

const MOODS = [
  "sleepy and cozy",
  "quietly focused",
  "restless and curious",
  "bright but scattered",
  "a little flat",
  "warm and playful",
  "wired, slightly unhinged",
  "calm and observant",
];

export function buildCurrentState(now = new Date(), lastSpokeAt = Date.now()) {
  const day = now.toLocaleDateString("en-US", { weekday: "long", timeZone: config.timezone });
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.timezone,
  });
  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - lastSpokeAt) / 60_000));
  const mood = MOODS[Math.floor(now.getTime() / 3_600_000) % MOODS.length];
  return `${day} ${time} ${config.timezoneLabel} · hasn't spoken in ${elapsedMinutes} min · current mood: ${mood}`;
}

export function renderAliveness(now = new Date(), lastSpokeAt = Date.now()) {
  // Function form: buildCurrentState output must be inserted literally.
  return ALIVENESS_BLOCK.replace("{{CURRENT_STATE}}", () => buildCurrentState(now, lastSpokeAt));
}

export async function deliverReply(message, answer, { lastSpokeAtRef, spontaneous = false, onSent } = {}) {
  const text = answer.slice(0, 2000);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount <= 8) {
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 3000));
  }
  const sent = spontaneous ? await message.channel.send(text) : await message.reply(text);
  // Hand back the sent Message so callers can track its id (reactions).
  if (onSent) {
    try { onSent(sent); } catch { /* tracking must never break delivery */ }
  }
  if (lastSpokeAtRef) lastSpokeAtRef.value = Date.now();

  if (!spontaneous && wordCount <= 8 && Math.random() < 1 / 6) {
    try {
      await message.react(["🙂", "👀", "✨", "😄", "🫡"][Math.floor(Math.random() * 5)]);
    } catch (error) {
      console.warn("Could not add aliveness reaction:", error.message);
    }
  }
}

// Streams a reply into Discord by editing one message as tokens arrive, so the
// character appears to type in real time. Returns the final text, or "" if the
// stream failed (a fallback message is sent in that case).
//
// dupCheck(text) -> Promise<string|null>: called once with the finished text.
// If it resolves to a non-empty string, that string replaces the streamed text
// in the message (used to swap out a verbatim repeat of her previous reply).
export async function deliverStreamedReply(message, produce, { lastSpokeAtRef, dupCheck, onSent } = {}) {
  let sent = null;
  try {
    await message.channel.sendTyping();
    sent = await message.reply("…");
    // Tracking from the first moment the message exists, so reactions that
    // arrive while she is still streaming count too.
    if (onSent) {
      try { onSent(sent); } catch { /* tracking must never break delivery */ }
    }
    let buffer = "";
    let lastEdit = 0;
    const finalText = await produce((delta) => {
      buffer += delta;
      const now = Date.now();
      if (now - lastEdit >= 1500 && buffer.trim()) {
        lastEdit = now;
        sent.edit(buffer.slice(0, 2000)).catch(() => {});
      }
    });
    const text = (finalText || buffer).trim().slice(0, 2000);
    if (!text) throw new Error("empty stream");
    let final = text;
    if (dupCheck) {
      try {
        const replacement = await dupCheck(text);
        if (replacement && replacement.trim()) final = replacement.trim().slice(0, 2000);
      } catch (error) {
        console.warn("Dedup check failed; keeping the streamed text:", error.message);
      }
    }
    await sent.edit(final);
    if (lastSpokeAtRef) lastSpokeAtRef.value = Date.now();
    const wordCount = final.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount <= 8 && Math.random() < 1 / 6) {
      try {
        await message.react(["🙂", "👀", "✨", "😄", "🫡"][Math.floor(Math.random() * 5)]);
      } catch {
        // Reactions are best-effort.
      }
    }
    return final;
  } catch (error) {
    console.error("Streamed reply failed:", error);
    const fallback = "My brain tripped for a second. Please try again.";
    try {
      if (sent) await sent.edit(fallback);
      else await message.reply(fallback);
    } catch {
      // Give up quietly; the outer handler already logged the failure.
    }
    return "";
  }
}
