import { config } from "./config.js";
import { keyPool } from "./keys.js";

// Streaming replies over the key pool.
//
// Thinking is ON by default (REPLY_THINKING): the model reasons privately
// before it answers, which is what keeps her grounded in the context she was
// handed instead of guessing — the difference between "which one?" when the
// options are right in front of her and actually reading them out. Reasoning
// never reaches Discord: models that inline it as a leading <think> block are
// stripped by createThinkFilter(), and reasoning delivered in a separate
// protocol field is ignored by the delta?.content check. While the model
// thinks, Discord just sees her typing indicator.
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await keyPool.acquire();
    // One filter per attempt: a retried stream starts clean, and a stream that
    // only ever produced thinking (nothing user-visible) stays retryable.
    const filter = createThinkFilter();
    let emitted = false;
    try {
      const stream = await entry.client.chat.completions.create({
        model: config.aiModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        stream: true,
        chat_template_kwargs: { enable_thinking: thinking },
      }, { signal: abortSignal });
      let content = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          const visible = filter.push(delta);
          if (visible) {
            emitted = true;
            content += visible;
            onDelta(visible, content);
          }
        }
      }
      return content;
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
