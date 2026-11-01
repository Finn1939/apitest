import { config } from "./config.js";
import { keyPool } from "./keys.js";

function retryAfterSeconds(error) {
  const retryAfter = Number(error?.headers?.["retry-after"]);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
}

export async function completeAI({
  messages,
  thinking = false,
  maxTokens = 512,
  temperature = 1,
  topP = 0.95,
}) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const entry = await keyPool.acquire();
    try {
      const response = await entry.client.chat.completions.create({
        model: config.aiModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        chat_template_kwargs: { enable_thinking: thinking },
      });
      return response.choices[0]?.message?.content?.trim() || "";
    } catch (error) {
      lastError = error;
      if (error?.status === 429) {
        keyPool.markRateLimited(entry, retryAfterSeconds(error));
        continue;
      }
      if (error?.status >= 500) {
        // Transient server error: cool this key briefly, next attempt uses another key.
        keyPool.markRateLimited(entry, 0.5 * (2 ** attempt));
        continue;
      }
      if (error?.status === 401 || error?.status === 403) {
        keyPool.markDead(entry);
        if (keyPool.aliveCount() > 0) continue;
      }
      throw error;
    }
  }
  throw new Error(`NVIDIA API request failed after retries: ${lastError?.message ?? "unknown error"}`);
}

export async function askAI({ prompt, personality, systemContext = "", conversation = [] }) {
  const messages = [
    {
      role: "system",
      content: [
        `Your personality: ${personality}`,
        "Reply conversationally and naturally, like chatting with a friend on Discord.",
        "Use Discord-friendly formatting and keep replies concise.",
        systemContext,
      ].filter(Boolean).join("\n"),
    },
    ...conversation,
    { role: "user", content: prompt },
  ];
  // Live replies: thinking OFF and a sane token cap — same model, much faster.
  const answer = await completeAI({ messages, thinking: false, maxTokens: 512 });
  if (!answer) throw new Error("NVIDIA API returned an empty response");
  return answer;
}
