import { config } from "./config.js";
import { keyPool } from "./keys.js";

// Streaming replies over the key pool.
//
// Thinking is ON by default (REPLY_THINKING): the model reasons privately
// before it answers, which is what keeps her grounded in the context she was
// handed instead of guessing — the difference between "which one?" when the
// options are right in front of her and actually reading them out.
// Reasoning never reaches Discord: models that inline it as a leading <think>
// block are stripped by createThinkFilter() (including anything still held
// when the stream ends), and reasoning delivered in a separate protocol field
// is ignored by the delta?.content check. While the model thinks, Discord
// just sees her typing indicator.
export function createThinkFilter() {
  let state = "deciding"; // deciding -> skipping -> passing
  let held = "";
  return {
    push(piece) {
      held += piece;
      // Not yet sure whether the stream opens with a think block.
      if (state === "deciding") {
        const lead = held.replace(/^\s+/, "");
        if (lead.startsWith("<think>")) {
          state = "skipping";
          held = held.slice(held.indexOf("<think>") + 7);
        } else if (lead.length >= 7) {
          // Enough text to know this is a normal answer, not a think block.
          state = "passing";
          const out = held;
          held = "";
          return out;
        }
        return "";
      }
      if (state === "skipping") {
        const end = held.indexOf("</think>");
        if (end === -1) {
          // The closing tag may still arrive split across chunks — hold back
          // its length and discard everything before it as thinking.
          held = held.slice(-8);
          return "";
        }
        state = "passing";
        const out = held.slice(end + 8).replace(/^\s+/, "");
        held = "";
        return out;
      }
      const out = held;
      held = "";
      return out;
    },
    // Called once when the stream ends. A reply shorter than the
    // classification threshold ("ok", "lol", "nya~") is still sitting in
    // the hold buffer — without this it would be lost and the whole reply
    // would look like an empty stream. Released, unless what's held looks
    // like a truncated think block (better silence than inner monologue).
    end() {
      if (state === "deciding") {
        const lead = held.replace(/^\s+/, "");
        if (!lead || "<think>".startsWith(lead)) return "";
        state = "passing";
        const out = held;
        held = "";
        return out;
      }
      if (state === "skipping") return ""; // unterminated think block
      const out = held;
      held = "";
      return out;
    },
  };
}

export async function streamReply({
  messages,
  onDelta = () => {},
  abortSignal,
  maxTokens = config.replyMaxTokens,
  temperature = config.replyTemperature,
  topP = 0.95,
  thinking = config.replyThinking,
}) {
  let lastError;
  // How many completed-but-empty streams we've already retried. Each one
  // escalates the next attempt instead of repeating the same call that just
  // starved. Rate-limit and 5xx retries do NOT escalate — those are
  // transient, the request itself was fine.
  let emptyRetries = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await keyPool.acquire();
    // One filter per attempt: a retried stream starts clean.
    const filter = createThinkFilter();
    let emitted = false;
    // Escalation ladder for streams that finish with nothing visible — the
    // classic case is a photo message: the model reasons about the image,
    // the reasoning eats the whole max_tokens budget (finish_reason
    // "length"), and the answer never starts. First retry doubles the
    // budget so thinking + answer both fit; second retry drops thinking
    // entirely so the model must answer directly.
    const attemptMaxTokens = emptyRetries === 0
      ? maxTokens
      : Math.max(maxTokens, Math.min(maxTokens * 2 ** emptyRetries, 3072));
    const attemptThinking = emptyRetries >= 2 ? false : thinking;
    try {
      const stream = await entry.client.chat.completions.create({
        model: config.aiModel,
        messages,
        max_tokens: attemptMaxTokens,
        temperature,
        top_p: topP,
        stream: true,
        chat_template_kwargs: { enable_thinking: attemptThinking },
      }, { signal: abortSignal });
      let content = "";
      let finishReason = null;
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta) {
          const visible = filter.push(delta);
          if (visible) {
            emitted = true;
            content += visible;
            onDelta(visible, content);
          }
        }
      }
      // A short-but-valid reply ("ok", "lol") can still be sitting in the
      // filter's hold buffer when the stream ends — release it now so it
      // isn't mistaken for an empty stream.
      const tail = filter.end();
      if (tail) {
        emitted = true;
        content += tail;
        onDelta(tail, content);
      }
      if (content.trim()) return content;
      // Completed, but nothing user-visible came out: retryable. Nothing was
      // shown to Discord, so restarting cannot duplicate text.
      lastError = new Error(
        `stream produced no visible content (finish_reason=${finishReason ?? "unknown"}, thinking=${attemptThinking}, max_tokens=${attemptMaxTokens})`,
      );
      emptyRetries += 1;
      if (attempt < 2) {
        console.warn(`[teacher-san] ${lastError.message}; retrying with ${emptyRetries >= 2 ? "thinking off" : "a larger token budget"}`);
      }
      continue;
    } catch (error) {
      lastError = error;
      // Never restart a stream that already produced output — it would
      // duplicate text. Thinking-only output is safe to retry: nothing was
      // shown, so `emitted` is still false.
      if (emitted || error?.name === "AbortError") throw error;
      if (error?.status === 429) {
        keyPool.markRateLimited(entry, 60);
        continue;
      }
      if (error?.status >= 500) {
        keyPool.markRateLimited(entry, 0.5 * (2 ** attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`NVIDIA streaming failed after retries: ${lastError?.message ?? "unknown error"}`);
}
