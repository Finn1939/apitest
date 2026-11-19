const MOODS = [
  "wired and observant",
  "mischievous and restless",
  "quietly locked in",
  "sharp and amused",
  "playful, zero filter",
  "night-city alert",
  "low-key protective",
  "curious, itching for chaos",
];

const AUTONOMOUS_REACTIONS = ["👀", "💀", "🔥", "⚡", "😭", "🫡", "✨", "😈"];

export function pickCurrentMood(now = new Date(), overrideMood = "") {
  if (overrideMood) return overrideMood;
  return MOODS[Math.floor(now.getTime() / 3_600_000) % MOODS.length];
}

export function pickAutonomousReaction(content = "") {
  const text = String(content || "").toLowerCase();
  if (/lmao|dead|bruh|ain't no way|💀/.test(text)) return "💀";
  if (/fire|clean|preem|insane|\bw\b|clutch|peak/.test(text)) return "🔥";
  if (/wait|what|huh|really|seriously|leak|drama/.test(text)) return "👀";
  if (/rip|pain|sad|tired|cooked/.test(text)) return "😭";
  return AUTONOMOUS_REACTIONS[Math.floor(Math.random() * AUTONOMOUS_REACTIONS.length)];
}

export function shouldConsiderAutonomousReaction({
  isBot = false,
  isGameCmd = false,
  contentLength = 0,
  chance = 0.22,
  roll = Math.random(),
}) {
  if (isBot || isGameCmd || contentLength < 8) return false;
  return roll < chance;
}

export function createAutonomyEngine({ db, completeAI, persona }) {
  function getState() {
    if (!db) {
      return { mood: pickCurrentMood(), energy: 0.85, currentFocus: "", lastAutonomousAt: 0 };
    }
    const row = db.prepare("SELECT mood, energy, current_focus, last_autonomous_at FROM autonomy_state WHERE id = 1").get();
    if (!row) {
      const initial = { mood: pickCurrentMood(), energy: 0.85, currentFocus: "", lastAutonomousAt: 0 };
      db.prepare("INSERT OR REPLACE INTO autonomy_state(id, mood, energy, current_focus, last_autonomous_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)")
        .run(initial.mood, initial.energy, initial.currentFocus, 0, Date.now());
      return initial;
    }
    return {
      mood: row.mood || pickCurrentMood(),
      energy: row.energy ?? 0.85,
      currentFocus: row.current_focus || "",
      lastAutonomousAt: row.last_autonomous_at || 0,
    };
  }

  function setState(patch = {}) {
    const current = getState();
    const next = {
      mood: patch.mood ?? current.mood,
      energy: patch.energy ?? current.energy,
      currentFocus: patch.currentFocus ?? current.currentFocus,
      lastAutonomousAt: patch.lastAutonomousAt ?? current.lastAutonomousAt,
    };
    if (db) {
      db.prepare(`
        INSERT OR REPLACE INTO autonomy_state(id, mood, energy, current_focus, last_autonomous_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
      `).run(next.mood, next.energy, next.currentFocus, next.lastAutonomousAt, Date.now());
    }
    return next;
  }

  async function decideAutonomousAction({ channelLabel, recentLines, peopleNotes, worldNote, occasion }) {
    const state = getState();
    const raw = await completeAI({
      messages: [
        {
          role: "system",
          content: "You are the inner mind of Capri (Cyberpunk: Edgerunners 2) deciding whether to act autonomously in Discord without being pinged. Return ONLY valid JSON.",
        },
        {
          role: "user",
          content: [
            `Persona snapshot: ${String(persona || "").slice(0, 700)}`,
            `Current mood: ${state.mood} | Energy: ${state.energy.toFixed(2)} | World: ${worldNote}`,
            `Channel: #${channelLabel} | Occasion: ${occasion}`,
            `Recent conversation:\n${recentLines || "(quiet)"}`,
            `Known people:\n${peopleNotes || "(none)"}`,
            [
              "Decide like a real person hanging out in Discord:",
              '- "action": "speak" | "react" | "silent"',
              '- Use "speak" when you genuinely have something sharp, funny, curious, or caring to add without sounding needy.',
              '- Use "react" when you just want to drop an emoji reaction and keep lurking.',
              '- Use "silent" when nothing calls for you (e.g. heavy private venting or zero opening).',
              '- "line": max 220 chars in Capri voice (only when action == "speak").',
              '- "emoji": single unicode emoji (only when action == "react").',
              '- "next_mood": optional short mood label.',
              'JSON format: {"action":"speak","line":"...","emoji":"","next_mood":"wired and amused"}',
            ].join("\n"),
          ].join("\n\n"),
        },
      ],
      thinking: false,
      temperature: 0.9,
    });

    const match = String(raw || "").match(/\{[\s\S]*\}/);
    if (!match) return { action: "silent", line: "", emoji: "" };
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.next_mood) {
        setState({ mood: String(parsed.next_mood).slice(0, 60), lastAutonomousAt: Date.now() });
      }
      const action = ["speak", "react", "silent"].includes(parsed.action) ? parsed.action : "silent";
      return {
        action,
        line: action === "speak" ? String(parsed.line || "").trim().slice(0, 240) : "",
        emoji: action === "react" ? String(parsed.emoji || "👀").trim().slice(0, 8) : "",
      };
    } catch {
      return { action: "silent", line: "", emoji: "" };
    }
  }

  return { getState, setState, decideAutonomousAction };
}
