import { readFileSync } from "node:fs";

const personalityPath = process.env.PERSONALITY_PATH || "personality.txt";
let personality = process.env.BOT_PERSONALITY || "";
try {
  personality = readFileSync(personalityPath, "utf8").trim();
} catch (error) {
  if (!personality) throw new Error(`Could not read personality file ${personalityPath}: ${error.message}`);
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  aiApiKey: process.env.NVIDIA_API_KEY || process.env.AI_API_KEY,
  aiApiUrl: process.env.AI_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
  aiModel: process.env.AI_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b",
  personality,
  personalityPath,
  dbPath: process.env.DB_PATH || "memory.db",
  adminUserIds: new Set((process.env.ADMIN_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean)),
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
