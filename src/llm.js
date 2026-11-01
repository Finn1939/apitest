import { config } from "./config.js";
import { keyPool } from "./keys.js";

// Streaming replies over the key pool — same model, thinking disabled, so
// tokens can be pushed to Discord while they are generated.
export async function streamReply({
  messages,
  onDelta = () => {},
  abortSignal,
  maxTokens = 512,
  temperature = 1,
  topP = 0.95,
}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await keyPool.acquire();
    let emitted = false;
    try {
      const stream = await entry.client.chat.completions.create({
        model: config.aiModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      }, { signal: abortSignal });
      let content = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          emitted = true;
          content += delta;
          onDelta(delta, content);
        }
      }
      return content;
    } catch (error) {
      lastError = error;
      // Never restart a stream that already produced output — it would duplicate text.
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
