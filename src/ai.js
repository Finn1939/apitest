import OpenAI from "openai";
import { config } from "./config.js";

function createClient() {
  return new OpenAI({
    apiKey: config.aiApiKey,
    baseURL: config.aiApiUrl.replace(/\/chat\/completions\/?$/, ""),
  });
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function completeAI({
  messages,
  thinking = false,
  maxTokens = 512,
  temperature = 1,
  topP = 0.95,
}) {
  const client = createClient();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model: config.aiModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        chat_template_kwargs: { enable_thinking: thinking },
      });
      return response.choices[0]?.message?.content?.trim() || "";
    } catch (error) {
      if (error.status === 429 || error.status >= 500) {
        await wait((500 * (2 ** attempt)) + Math.floor(Math.random() * 250));
        continue;
      }
      throw error;
    }
  }
  throw new Error("NVIDIA API rate limit: retries exhausted");
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
  const answer = await completeAI({ messages, thinking: true, maxTokens: 16_384 });
  if (!answer) throw new Error("NVIDIA API returned an empty response");
  return answer;
}
