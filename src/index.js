import "dotenv/config";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { config, validateConfig } from "./config.js";
import { parseCommand } from "./commands.js";
import { askAI } from "./ai.js";
import { searchWeb } from "./search.js";
import {
  HISTORY_LIMIT,
  addFact,
  addHistory,
  loadMemory,
  parseRememberCommand,
  saveMemory,
} from "./memory.js";

validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const storedMemory = loadMemory();
const conversations = storedMemory.conversations;
const channelFacts = storedMemory.facts;
const spontaneousReplies = new Map();

function persistMemory() {
  saveMemory(conversations, channelFacts);
}

function randomDelay(minMinutes, maxMinutes) {
  return (minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60_000;
}

function rememberBotMessage(channelId, answer) {
  const history = conversations.get(channelId) || [];
  conversations.set(channelId, addHistory(history, { role: "assistant", content: answer }));
  persistMemory();
}

function rememberUserMessage(channelId, displayName, content) {
  const history = conversations.get(channelId) || [];
  const entry = { role: "user", content: `${displayName}: ${content}` };
  conversations.set(channelId, addHistory(history, entry));
  persistMemory();
}

function factsContext(channelId) {
  const facts = channelFacts.get(channelId) || [];
  return facts.length ? `Things explicitly remembered in this channel:\n${facts.map((fact) => `- ${fact}`).join("\n")}` : "";
}

async function sendSpontaneousMessage(channel) {
  const lastReply = spontaneousReplies.get(channel.id) || 0;
  if (Date.now() - lastReply < config.spontaneousCooldownMs) return;

  const answer = await askAI({
    prompt: "Start a brief, natural conversation in this Discord channel. Say one short thing, react to the general mood, or ask a light question. Do not mention commands or that you are a bot.",
    personality: config.personality,
  });
  await channel.send(answer.slice(0, 2000));
  spontaneousReplies.set(channel.id, Date.now());
  rememberBotMessage(channel.id, answer);
}

function scheduleSpontaneousMessages() {
  const channels = client.channels.cache.filter((channel) =>
    channel.isTextBased() && !channel.isDMBased?.() &&
    channel.permissionsFor(client.user)?.has("SendMessages"));

  const available = [...channels.values()];
  if (available.length) {
    const channel = available[Math.floor(Math.random() * available.length)];
    sendSpontaneousMessage(channel).catch((error) =>
      console.error("Spontaneous chat failed:", error));
  }
  setTimeout(scheduleSpontaneousMessages, randomDelay(20, 50));
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Prefix: ${config.prefix} | Model: ${config.aiModel}`);
  scheduleSpontaneousMessages();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  rememberUserMessage(message.channel.id, message.member?.displayName || message.author.username, message.content);

  const mentioned = message.mentions.has(client.user);
  const command = parseCommand(message.content, config.prefix);
  if (!mentioned && command === null) {
    const lastReply = spontaneousReplies.get(message.channel.id) || 0;
    const canReply = Date.now() - lastReply >= config.spontaneousCooldownMs;
    if (!canReply || message.content.length < 8 || Math.random() >= config.spontaneousChance) return;

    await message.channel.sendTyping();
    try {
      const answer = await askAI({
        prompt: `Someone in Discord said: "${message.content}". React naturally, only if there is a reason to join in. If you would add nothing useful, answer exactly: NO_REPLY.`,
        personality: config.personality,
      });
      if (!/^no[_\s-]?reply$/i.test(answer.trim())) {
        await message.reply(answer.slice(0, 2000));
        spontaneousReplies.set(message.channel.id, Date.now());
        rememberBotMessage(message.channel.id, answer);
      }
    } catch (error) {
      console.error("Unprompted reply failed:", error);
    }
    return;
  }

  const prompt = command ?? message.content.replaceAll(`<@${client.user.id}>`, "")
    .replaceAll(`<@!${client.user.id}>`, "").trim();
  if (!prompt) {
    await message.reply("Hey! What do you want to talk about?");
    return;
  }

  await message.channel.sendTyping();
  try {
    let answer;
    const rememberedFact = !command ? parseRememberCommand(prompt) : null;
    if (rememberedFact) {
      const facts = channelFacts.get(message.channel.id) || [];
      channelFacts.set(message.channel.id, addFact(facts, rememberedFact));
      persistMemory();
      answer = `Got it, I'll remember this in this channel: ${rememberedFact}`;
    } else if (!command && /^(forget everything|clear memory)$/i.test(prompt)) {
      conversations.delete(message.channel.id);
      channelFacts.delete(message.channel.id);
      persistMemory();
      answer = "Channel memory cleared.";
    } else {
      if (command !== null) {
        const results = await searchWeb(prompt);
        const context = results.length
          ? `Use these current search results as supporting information. Include a source link when useful:\n${results
            .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}\n${result.url}`)
            .join("\n\n")}`
          : "No useful search result was found. Answer from reliable general knowledge and be clear that the web search returned no match.";
        answer = await askAI({ prompt, personality: config.personality, systemContext: context });
      } else {
        const historyKey = message.channel.id;
        const history = conversations.get(historyKey) || [];
        const factsContextText = factsContext(historyKey);
        answer = await askAI({
          prompt,
          personality: config.personality,
          systemContext: factsContextText,
          conversation: history.slice(0, -1).slice(-HISTORY_LIMIT),
        });
      }
    }
    await message.reply(answer.slice(0, 2000));
    rememberBotMessage(message.channel.id, answer);
  } catch (error) {
    console.error(error);
    await message.reply("My brain tripped for a second. Please try again.");
  }
});

client.login(config.discordToken);
