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

export function renderEmbeds(embeds, { maxLength = 1500 } = {}) {
  if (!Array.isArray(embeds)) return "";
  const parts = [];
  for (const embed of embeds) {
    if (!embed) continue;
    const bits = [
      embed.author?.name,
      embed.title,
      embed.url ? `URL: ${embed.url}` : "",
      embed.description,
      ...(Array.isArray(embed.fields) ? embed.fields : []).map((field) =>
        [field?.name, field?.value].filter(Boolean).join(": ")),
      embed.image?.url ? `[Image: ${embed.image.url}]` : "",
      embed.thumbnail?.url ? `[Thumbnail: ${embed.thumbnail.url}]` : "",
      embed.video?.url ? `[Video: ${embed.video.url}]` : "",
      embed.footer?.text,
      embed.timestamp ? `Timestamp: ${embed.timestamp}` : "",
    ].filter(Boolean);
    if (bits.length) parts.push(bits.join(" | "));
  }
  const text = parts.join(" || ").replace(/\s+/g, " ").trim().slice(0, maxLength);
  return text ? `[Discord Embed: ${text}]` : "";
}

export function renderButtons(components, { maxButtons = 10 } = {}) {
  if (!Array.isArray(components)) return "";
  const labels = [];
  for (const row of components) {
    for (const child of row?.components || []) {
      const label = typeof child?.label === "string" ? child.label.replace(/\s+/g, " ").trim() : "";
      if (label) labels.push(label);
      if (Array.isArray(child?.options)) {
        for (const opt of child.options) {
          if (opt?.label) labels.push(opt.label);
        }
      }
    }
  }
  const shown = labels.slice(0, maxButtons).join(" / ");
  return shown ? `[choices: ${shown}]` : "";
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function renderAttachments(attachments, { maxAttachments = 6 } = {}) {
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
    .map((answer) => String(answer?.text || "").trim()).filter(Boolean).slice(0, 8);
  return `[poll: ${String(poll.question.text).replace(/\s+/g, " ").trim()}${answers.length ? ` — options: ${answers.join(", ")}` : ""}]`;
}

export function renderMediaExtras(message) {
  const parts = [
    renderAttachments(message?.attachments),
    renderStickers(message?.stickers),
    renderPoll(message?.poll),
  ].filter(Boolean);
  return parts.join(" ");
}

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
      return `${who}: ${text.slice(0, 420)}`;
    })
    .filter(Boolean).join("\n");
}

export function visionUserContent(prompt, images = [], binaryMedia = []) {
  const text = String(prompt || "");
  if ((!Array.isArray(images) || !images.length) && (!Array.isArray(binaryMedia) || !binaryMedia.length)) {
    return text;
  }
  const parts = [{ type: "text", text }];
  for (const url of images || []) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  for (const item of binaryMedia || []) {
    if (item?.data && item?.mimeType) {
      parts.push({ type: "inline_data", inlineData: { mimeType: item.mimeType, data: item.data } });
    }
  }
  return parts;
}
