import OpenAI from "openai";
import { config } from "./config.js";

const BASE_URL = config.aiApiUrl.replace(/\/chat\/completions\/?$/, "");
// Keep each key just under the ~40 requests/min free-tier ceiling.
const MIN_SPACING_MS = 1550;

function createKeyPool(keys) {
  const pool = keys.map((key, index) => ({
    label: `key ${index + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: BASE_URL }),
    cooldownUntil: 0,
    lastRequestAt: 0,
    dead: false,
  }));
  let cursor = 0;

  async function waitFor(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  return {
    async acquire() {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const now = Date.now();
        for (let offset = 0; offset < pool.length; offset += 1) {
          const entry = pool[(cursor + offset) % pool.length];
          if (entry.dead || entry.cooldownUntil > now) continue;
          if (entry.lastRequestAt + MIN_SPACING_MS > now) continue;
          entry.lastRequestAt = now;
          cursor = (cursor + offset + 1) % pool.length;
          return entry;
        }
        const alive = pool.filter((entry) => !entry.dead);
        if (!alive.length) break;
        const wakeAt = Math.min(
          ...alive.map((entry) => Math.max(entry.cooldownUntil, entry.lastRequestAt + MIN_SPACING_MS)),
        );
        await waitFor(Math.min(Math.max(wakeAt - Date.now(), 200), 5_000));
      }
      throw new Error("API key pool: no key became available within 2 minutes");
    },
    markRateLimited(entry, seconds = 60) {
      entry.cooldownUntil = Math.max(entry.cooldownUntil, Date.now() + seconds * 1000);
    },
    markDead(entry) {
      entry.dead = true;
      console.error(`API key pool: ${entry.label} rejected (401/403) and was disabled`);
    },
    aliveCount() {
      return pool.filter((entry) => !entry.dead).length;
    },
    size() {
      return pool.length;
    },
  };
}

export const keyPool = createKeyPool(config.aiApiKeys);
