// Turns raw Discord mention markup into readable text for the AI and her memory.
// <@123> → @Display name, <@&456> → @Role, <#789> → #channel.
// Unresolvable IDs are left untouched. The bot's own mention is handled in index.js.
export function renderDiscordMentions(content, { users, roles, channels } = {}) {
  const userMap = users ?? new Map();
  const roleMap = roles ?? new Map();
  const channelMap = channels ?? new Map();
  return String(content ?? "")
    .replace(/<@!?(\d+)>/g, (original, id) => {
      const user = userMap.get(id);
      if (!user) return original;
      const name = String(user.displayName || user.globalName || user.username || id).replace(/^@+/, "");
      return `@${name}`;
    })
    .replace(/<@&(\d+)>/g, (original, id) => {
      const role = roleMap.get(id);
      return role ? `@${String(role.name).replace(/^@+/, "")}` : original;
    })
    .replace(/<#(\d+)>/g, (original, id) => {
      const channel = channelMap.get(id);
      return channel ? `#${String(channel.name).replace(/^#+/, "")}` : original;
    });
}

// Game bots (OwO, Karuta, gambling bots) put their whole message in EMBEDS —
// OwO's HighLow panel has an empty message.content. Without rendering them,
// she was blind to the game the user was asking her to help decide on. Flattens
// title/description/fields/footer of up to two embeds into one bracketed line.
export function renderEmbeds(embeds, { maxLength = 280 } = {}) {
  if (!Array.isArray(embeds)) return "";
  const parts = [];
  for (const embed of embeds.slice(0, 2)) {
    if (!embed) continue;
    const fields = Array.isArray(embed.fields) ? embed.fields : [];
    const bits = [
      embed.title,
      embed.description,
      ...fields.map((field) => [field?.name, field?.value].filter(Boolean).join(": ")),
      embed.footer?.text,
    ].filter((text) => typeof text === "string" && text.trim());
    if (bits.length) parts.push(bits.join(" | "));
  }
  const text = parts.join(" || ").replace(/\s+/g, " ").trim().slice(0, maxLength);
  return text ? `[${text}]` : "";
}

// The clickable choices on a bot panel (HighLow's Higher/Lower/Same/Cash Out)
// live in components, not embeds. Render their labels so she knows the options
// and payouts the user is choosing between.
export function renderButtons(components, { maxButtons = 8 } = {}) {
  if (!Array.isArray(components)) return "";
  const labels = [];
  for (const row of components) {
    for (const child of row?.components || []) {
      const label = typeof child?.label === "string" ? child.label.replace(/\s+/g, " ").trim() : "";
      if (label) labels.push(label);
    }
  }
  const shown = labels.slice(0, maxButtons).join(" / ");
  return shown ? `[choices: ${shown}]` : "";
}

// --- Media awareness ---------------------------------------------------------
// She cannot watch videos or listen to voice messages, but she CAN know they
// exist: "Ren: listen to this [attached: voice message (audio, 14s)]" is a
// completely different conversation than a blank stare.

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function renderAttachments(attachments, { maxAttachments = 4 } = {}) {
  const list = [...(attachments?.values?.() || attachments || [])].filter(Boolean);
  if (!list.length) return "";
  const rendered = list.slice(0, maxAttachments).map((attachment) => {
    const type = String(attachment.contentType || "").split(";")[0] || "file";
    const bits = [type];
    const size = humanFileSize(attachment.size);
    if (size) bits.push(size);
    if (attachment.width && attachment.height) bits.push(`${attachment.width}×${attachment.height}`);
    if (attachment.duration) bits.push(`${Math.round(attachment.duration)}s`);
    const name = String(attachment.name || "").replace(/\s+/g, " ").trim();
    const label = /voice|audio/i.test(type) && !name ? "voice message" : (name || "file");
    return `${label} (${bits.join(", ")})`;
  });
  const more = list.length > maxAttachments ? `, +${list.length - maxAttachments} more` : "";
  return `[attached: ${rendered.join(", ")}${more}]`;
}

export function renderStickers(stickers, { maxStickers = 3 } = {}) {
  const list = [...(stickers?.values?.() || stickers || [])].filter(Boolean);
  const names = list.slice(0, maxStickers).map((sticker) => String(sticker?.name || "").trim()).filter(Boolean);
  if (!names.length) return "";
  return `[sticker: ${names.join(", ")}]`;
}

export function renderPoll(poll) {
  if (!poll?.question?.text) return "";
  const answers = [...(poll.answers?.values?.() || poll.answers || [])]
    .map((answer) => String(answer?.text || "").trim()).filter(Boolean).slice(0, 6);
  return `[poll: ${String(poll.question.text).replace(/\s+/g, " ").trim()}${answers.length ? ` — options: ${answers.join(", ")}` : ""}]`;
}

// All media annotations for one message, as a single trailing note.
export function renderMediaExtras(message) {
  const parts = [
    renderAttachments(message?.attachments),
    renderStickers(message?.stickers),
    renderPoll(message?.poll),
  ].filter(Boolean);
  return parts.join(" ");
}

// A live snapshot of a channel's last messages — the view she gets when
// someone talks to her inside a bot-game channel. Learned game channels log
// no bot traffic (Karuta/OwO spam would bury the DB), so the panel someone
// is asking about is NOT in her persistent memory; this snapshot fetched at
// reply time is the only place she sees it. Bot messages include their
// rendered embeds and buttons (the HighLow card, cash-out values), her own
// messages are skipped (already in her context), mentions become names.
export function renderChannelSnapshot(messages, selfId) {
  return [...(messages || [])]
    .filter(Boolean)
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .map((msg) => {
      if (!msg.author || msg.author.id === selfId) return null;
      const content = renderDiscordMentions(msg.content || "", {
        users: msg.mentions?.users,
        roles: msg.mentions?.roles,
        channels: msg.mentions?.channels,
      });
      const panel = [
        renderEmbeds(msg.embeds || []),
        renderButtons(msg.components || []),
        renderMediaExtras(msg),
      ].filter(Boolean).join(" ");
      const text = `${content}${panel ? ` ${panel}` : ""}`.replace(/\s+/g, " ").trim();
      if (!text) return null;
      const who = msg.author.bot
        ? `${msg.author.displayName || msg.author.username || "bot"} [bot]`
        : (msg.member?.displayName || msg.author.displayName || msg.author.username || "someone");
      return `${who}: ${text.slice(0, 320)}`;
    })
    .filter(Boolean).join("\n");
}

// Vision: when someone sends her an image while talking to her, the user turn
// becomes a multimodal content array. Without images it stays a plain string,
// so nothing changes for text-only messages.
export function visionUserContent(prompt, images) {
  const text = String(prompt || "");
  if (!Array.isArray(images) || !images.length) return text;
  return [
    { type: "text", text },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}
