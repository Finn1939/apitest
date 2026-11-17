import { config } from "./config.js";
import { keyPool } from "./keys.js";

function retryAfterSeconds(error) {
  const raw = error?.headers?.get?.("retry-after") ?? error?.headers?.["retry-after"];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120) : 45;
}

export function toGeminiPayload(messages) {
  const systemParts = [];
  const contents = [];

  for (const msg of messages || []) {
    if (!msg) continue;
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content.trim()) {
        systemParts.push(msg.content);
      }
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];

    if (typeof msg.content === "string") {
      if (msg.content) parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (!item) continue;
        if (item.type === "text" && item.text) {
          parts.push({ text: item.text });
        } else if (item.type === "inline_data" && item.inlineData?.data) {
          parts.push({
            inlineData: {
              mimeType: item.inlineData.mimeType || "application/octet-stream",
              data: item.inlineData.data,
            },
          });
        } else if (item.type === "image_url" && item.image_url?.url) {
          const url = item.image_url.url;
          const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/s);
          if (dataMatch) {
            parts.push({
              inlineData: {
                mimeType: dataMatch[1],
                data: dataMatch[2],
              },
            });
          } else {
            parts.push({ text: `[Attached image URL: ${url}]` });
          }
        }
      }
    }

    if (parts.length) {
      contents.push({ role, parts });
    }
  }

  return {
    systemInstruction: systemParts.join("\n\n").trim() || undefined,
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "hi" }] }],
  };
}

export function toOpenAIMessages(messages) {
  return (messages || []).map((msg) => {
    if (!Array.isArray(msg?.content)) return msg;
    const filtered = msg.content.filter((part) => part?.type !== "inline_data");
    const mediaNotes = msg.content
      .filter((part) => part?.type === "inline_data")
      .map((part) => `[Attached binary media: ${part.inlineData?.mimeType || "file"}]`);
    if (mediaNotes.length) {
      const textPart = filtered.find((p) => p.type === "text");
      if (textPart) textPart.text = `${textPart.text}\n${mediaNotes.join(" ")}`.trim();
      else filtered.unshift({ type: "text", text: mediaNotes.join(" ") });
    }
    return { ...msg, content: filtered.length ? filtered : "" };
  });
}

export async function completeAI({
  messages,
  thinking = false,
  maxTokens = 1024,
  temperature = 0.85,
  topP = 0.95,
  responseMimeType,
}) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const entry = await keyPool.acquire();
    try {
      if (entry.provider === "gemini") {
        const { systemInstruction, contents } = toGeminiPayload(messages);
        const geminiConfig = {};
        if (systemInstruction) geminiConfig.systemInstruction = systemInstruction;
        if (responseMimeType) geminiConfig.responseMimeType = responseMimeType;
        const response = await entry.client.models.generateContent({
          model: config.geminiModel,
          contents,
          config: geminiConfig,
        });
        return response.text?.trim() || "";
      }

      const response = await entry.client.chat.completions.create({
        model: config.aiModel,
        messages: toOpenAIMessages(messages),
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        chat_template_kwargs: { enable_thinking: thinking },
      });
      return response.choices[0]?.message?.content?.trim() || "";
    } catch (error) {
      lastError = error;
      const status = error?.status ?? error?.code;
      if (status === 429) {
        keyPool.markRateLimited(entry, retryAfterSeconds(error));
        continue;
      }
      if (Number(status) >= 500) {
        keyPool.markRateLimited(entry, 0.5 * (2 ** attempt));
        continue;
      }
      if (status === 401 || status === 403) {
        keyPool.markDead(entry);
        if (keyPool.aliveCount() > 0) continue;
      }
      throw error;
    }
  }
  throw new Error(`AI API request failed after retries: ${lastError?.message ?? "unknown error"}`);
}

export async function askAI({ prompt, personality, systemContext = "", conversation = [] }) {
  const messages = [
    {
      role: "system",
      content: [
        `Your personality: ${personality}`,
        "Reply conversationally and naturally, like a real person in a Discord server.",
        "Use Discord-friendly formatting and keep replies punchy unless depth is needed.",
        systemContext,
      ].filter(Boolean).join("\n"),
    },
    ...conversation,
    { role: "user", content: prompt },
  ];
  const answer = await completeAI({ messages, thinking: false, maxTokens: 700 });
  if (!answer) throw new Error("AI API returned an empty response");
  return answer;
}
