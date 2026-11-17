import { config } from "./config.js";
import { keyPool } from "./keys.js";
import { toGeminiPayload, toOpenAIMessages } from "./ai.js";

export function createThinkFilter() {
  let state = "deciding";
  let held = "";

  return {
    push(piece) {
      held += piece;
      if (state === "deciding") {
        const lead = held.replace(/^\s+/, "");
        if (lead.startsWith("<think>")) {
          state = "skipping";
          held = held.slice(held.indexOf("<think>") + 7);
        } else if (lead.length >= 7) {
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

    end() {
      if (state === "deciding") {
        const lead = held.replace(/^\s+/, "");
        if (!lead || "<think>".startsWith(lead)) return "";
        state = "passing";
        const out = held;
        held = "";
        return out;
      }
      if (state === "skipping") return "";
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
  let emptyRetries = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await keyPool.acquire();
    const filter = createThinkFilter();
    let emitted = false;

    const attemptMaxTokens = emptyRetries === 0
      ? maxTokens
      : Math.max(maxTokens, Math.min(maxTokens * 2 ** emptyRetries, 3072));
    const attemptThinking = emptyRetries >= 2 ? false : thinking;

    try {
      let content = "";
      let finishReason = null;

      if (entry.provider === "gemini") {
        const { systemInstruction, contents } = toGeminiPayload(messages);
        const geminiConfig = {};
        if (systemInstruction) geminiConfig.systemInstruction = systemInstruction;
        const stream = await entry.client.models.generateContentStream({
          model: config.geminiModel,
          contents,
          config: geminiConfig,
        });

        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;
          const delta = chunk.text;
          if (delta) {
            const visible = filter.push(delta);
            if (visible) {
              emitted = true;
              content += visible;
              onDelta(visible, content);
            }
          }
        }
      } else {
        const stream = await entry.client.chat.completions.create({
          model: config.aiModel,
          messages: toOpenAIMessages(messages),
          max_tokens: attemptMaxTokens,
          temperature,
          top_p: topP,
          stream: true,
          chat_template_kwargs: { enable_thinking: attemptThinking },
        }, { signal: abortSignal });

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
      }

      const tail = filter.end();
      if (tail) {
        emitted = true;
        content += tail;
        onDelta(tail, content);
      }

      if (content.trim()) return content;

      lastError = new Error(
        `stream produced no visible content (finish_reason=${finishReason ?? "unknown"}, thinking=${attemptThinking}, max_tokens=${attemptMaxTokens})`,
      );
      emptyRetries += 1;
    } catch (error) {
      lastError = error;
      if (emitted || error?.name === "AbortError") throw error;
      const status = error?.status ?? error?.code;
      if (status === 429) {
        keyPool.markRateLimited(entry, 45);
        continue;
      }
      if (Number(status) >= 500) {
        keyPool.markRateLimited(entry, 0.5 * (2 ** attempt));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`AI streaming failed after retries: ${lastError?.message ?? "unknown error"}`);
}
