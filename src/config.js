import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCommandUserIds } from "./command-auth.js";

const personalityPath = resolve(process.env.PERSONALITY_PATH || "personality.txt");

const geminiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const openAiKeys = (process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY || process.env.AI_API_KEY || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const requestedProvider = String(process.env.AI_PROVIDER || "auto").trim().toLowerCase();
const aiProvider = requestedProvider === "gemini"
  ? "gemini"
  : requestedProvider === "openai"
    ? "openai"
    : (geminiKeys.length > 0 ? "gemini" : "openai");

let personality = process.env.BOT_PERSONALITY || "";
try {
  personality = readFileSync(personalityPath, "utf8").trim();
} catch (error) {
  if (!personality) throw new Error(`Could not read personality file ${personalityPath}: ${error.message}`);
}

const autonomyLevel = String(process.env.AUTONOMY_LEVEL || "high").trim().toLowerCase();
const defaultSpontaneousChance = autonomyLevel === "high" ? 0.14 : autonomyLevel === "low" ? 0.03 : 0.08;
const defaultCooldownMinutes = autonomyLevel === "high" ? 4 : autonomyLevel === "low" ? 18 : 8;
const defaultReactChance = autonomyLevel === "high" ? 0.22 : autonomyLevel === "low" ? 0.05 : 0.12;

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  commandUserIds: parseCommandUserIds(process.env.COMMAND_USER_IDS),
  allowGuildAdmins: process.env.ALLOW_GUILD_ADMINS !== "false",
  commandTrustLevel: String(process.env.COMMAND_TRUST_LEVEL || "full").toLowerCase() === "mirror_actor"
    ? "mirror_actor"
    : "full",
  aiProvider,
  geminiApiKeys: geminiKeys,
  geminiModel: process.env.GEMINI_MODEL || "gemini-4-hydrogen",
  aiApiKeys: openAiKeys,
  aiApiKey: openAiKeys[0],
  aiApiUrl: process.env.AI_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
  aiModel: aiProvider === "gemini"
    ? (process.env.GEMINI_MODEL || "gemini-4-hydrogen")
    : (process.env.AI_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b"),
  personality,
  personalityPath,
  dbPath: process.env.DB_PATH || "memory.db",
  adminUserIds: new Set(
    (process.env.ADMIN_USER_IDS || process.env.COMMAND_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ),
  prefix: (process.env.BOT_PREFIX || "t").trim(),
  autonomyLevel,
  spontaneousChance: Number(process.env.SPONTANEOUS_CHANCE || defaultSpontaneousChance),
  spontaneousCooldownMs: Number(process.env.SPONTANEOUS_COOLDOWN_MINUTES || defaultCooldownMinutes) * 60_000,
  autonomousReactChance: Number(process.env.AUTONOMOUS_REACT_CHANCE || defaultReactChance),
  welcomeNewMembers: process.env.WELCOME_NEW_MEMBERS !== "false",
  fullServerSync: process.env.FULL_SERVER_SYNC !== "false",
  convoEngageMs: Math.max(1, Number(process.env.CONVO_ENGAGE_MINUTES || 15)) * 60_000,
  timezone: process.env.TIMEZONE || "Asia/Manila",
  timezoneLabel: process.env.TIMEZONE_LABEL || "PHT",
  memoryContextTokens: Math.max(4000, Number(process.env.MEMORY_CONTEXT_TOKENS || 48000)),
  analysisEnabled: process.env.ANALYSIS_ENABLED !== "false",
  analysisMaxPerMinute: Math.max(1, Number(process.env.ANALYSIS_MAX_PER_MIN || 16)),
  reactionFlushMs: Math.max(20, Number(process.env.REACTION_FLUSH_MINUTES || 2) * 60_000),
  gameWatchChance: Number(process.env.GAME_WATCH_CHANCE || 0.25),
  gameWatchCooldownMs: Math.max(5, Number(process.env.GAME_WATCH_COOLDOWN_MINUTES || 30)) * 60_000,
  replyThinking: process.env.REPLY_THINKING === "true",
  replyTemperature: Math.min(2, Math.max(0, Number(process.env.REPLY_TEMPERATURE || 0.85))),
  replyMaxTokens: Math.max(256, Number(process.env.REPLY_MAX_TOKENS || 1200)),
  visionTransport: String(process.env.VISION_TRANSPORT || "base64").toLowerCase() === "url" ? "url" : "base64",
};

export function validateConfig() {
  const missing = [];
  if (!config.discordToken) missing.push("DISCORD_TOKEN");
  if (config.aiProvider === "gemini" && !config.geminiApiKeys.length && !config.aiApiKeys.length) {
    missing.push("GEMINI_API_KEY (or NVIDIA_API_KEY)");
  } else if (config.aiProvider === "openai" && !config.aiApiKeys.length) {
    missing.push("NVIDIA_API_KEY / AI_API_KEY (or GEMINI_API_KEY)");
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
