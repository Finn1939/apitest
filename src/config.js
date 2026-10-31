export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  aiApiKey: process.env.NVIDIA_API_KEY || process.env.AI_API_KEY,
  aiApiUrl: process.env.AI_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
  aiModel: process.env.AI_MODEL || "z-ai/glm-5.3-flash",
  personality: process.env.BOT_PERSONALITY ||
    "Friendly, witty, curious, and supportive. Speak naturally, like a real person.",
  prefix: (process.env.BOT_PREFIX || "t").trim(),
  spontaneousChance: Number(process.env.SPONTANEOUS_CHANCE || 0.04),
  spontaneousCooldownMs: Number(process.env.SPONTANEOUS_COOLDOWN_MINUTES || 15) * 60_000,
};

export function validateConfig() {
  const missing = [];
  if (!config.discordToken) missing.push("DISCORD_TOKEN");
  if (!config.aiApiKey) missing.push("NVIDIA_API_KEY");
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
