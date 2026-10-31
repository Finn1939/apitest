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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetch(
      process.env.AI_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY || process.env.AI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || "z-ai/glm-5.3-flash",
          messages,
          max_tokens: 350,
          temperature: 0.8,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AI request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const answer = message?.content?.trim() || message?.reasoning_content?.trim();
    if (!answer) throw new Error("AI provider returned an empty response");
    return answer;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("NVIDIA API timed out after 180 seconds");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
