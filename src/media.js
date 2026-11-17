import { config } from "./config.js";

export const VISION_MAX_IMAGES = 4;
export const VISION_MAX_BYTES = 10 * 1024 * 1024;
export const VISION_INLINE_MAX_BYTES = 4 * 1024 * 1024;
export const VISION_PROXY_LADDER = [1024, 768, 512];
export const VISION_UNAVAILABLE_NOTE =
  "Note: the user attached an image or media file, but it could not be downloaded for inspection. Be honest about not being able to view it.";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".css", ".html", ".htm", ".yml", ".yaml", ".csv", ".tsv", ".log", ".xml",
  ".sql", ".sh", ".bash", ".env", ".toml", ".ini", ".cfg", ".conf", ".rs", ".go", ".java",
]);

const TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;
const TEXT_ATTACHMENT_MAX_CHARS = 5000;
const BINARY_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

export function isReadableTextAttachment(attachment) {
  if (!attachment) return false;
  const type = String(attachment.contentType || "").toLowerCase();
  const name = String(attachment.name || "").toLowerCase();
  if (type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("javascript")) {
    return true;
  }
  const dot = name.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(name.slice(dot));
}

export function isMultimodalBinaryAttachment(attachment) {
  if (!attachment) return false;
  const type = String(attachment.contentType || "").toLowerCase().split(";")[0];
  return type.startsWith("audio/") || type.startsWith("video/") || type === "application/pdf";
}

function proxiedUrl(attachment, maxDimension) {
  const raw = String(attachment?.proxyURL || attachment?.url || "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.searchParams.set("width", String(maxDimension));
    parsed.searchParams.set("height", String(maxDimension));
    return parsed.toString();
  } catch {
    return raw;
  }
}

async function fetchBytes(url, timeoutMs = 8000) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      bytes: buffer,
      contentType: String(response.headers.get("content-type") || "application/octet-stream").split(";")[0],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function attachmentToImage(attachment) {
  const url = String(attachment?.url || attachment?.proxyURL || "");
  if (!url) return null;
  if (config.visionTransport === "url") return url;

  const direct = await fetchBytes(url);
  if (direct && direct.contentType.startsWith("image/") && direct.bytes.length <= VISION_INLINE_MAX_BYTES) {
    return `data:${direct.contentType};base64,${direct.bytes.toString("base64")}`;
  }

  for (const box of VISION_PROXY_LADDER) {
    const got = await fetchBytes(proxiedUrl(attachment, box));
    if (got && got.contentType.startsWith("image/") && got.bytes.length <= VISION_INLINE_MAX_BYTES) {
      return `data:${got.contentType};base64,${got.bytes.toString("base64")}`;
    }
  }
  return null;
}

export async function collectVisionImages(message, { referencedMessage = null } = {}) {
  const images = [];
  const seenUrls = new Set();

  const tryAddAttachment = async (attachment) => {
    if (images.length >= VISION_MAX_IMAGES || !attachment) return;
    const type = String(attachment.contentType || "");
    const url = String(attachment.url || attachment.proxyURL || "");
    if (!type.startsWith("image/") && !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return;
    if (seenUrls.has(url)) return;
    if ((attachment.size || 0) > VISION_MAX_BYTES) return;
    seenUrls.add(url);
    const dataUrl = await attachmentToImage(attachment);
    if (dataUrl) images.push(dataUrl);
  };

  for (const attachment of message?.attachments?.values?.() || []) {
    await tryAddAttachment(attachment);
  }
  for (const attachment of referencedMessage?.attachments?.values?.() || []) {
    await tryAddAttachment(attachment);
  }
  for (const embed of [...(message?.embeds || []), ...(referencedMessage?.embeds || [])]) {
    const imgUrl = embed?.image?.url || embed?.thumbnail?.url;
    if (imgUrl && !seenUrls.has(imgUrl) && images.length < VISION_MAX_IMAGES) {
      await tryAddAttachment({ url: imgUrl, contentType: "image/png", size: 1024 });
    }
  }

  return images;
}

export async function collectRichMediaAndText(message, { referencedMessage = null } = {}) {
  const textFiles = [];
  const binaryMedia = [];

  const allAttachments = [
    ...(message?.attachments?.values?.() || []),
    ...(referencedMessage?.attachments?.values?.() || []),
  ];

  for (const attachment of allAttachments) {
    if (!attachment?.url) continue;

    if (isReadableTextAttachment(attachment) && textFiles.length < 3 && (attachment.size || 0) <= TEXT_ATTACHMENT_MAX_BYTES) {
      const fetched = await fetchBytes(attachment.url, 6000);
      if (fetched) {
        const text = fetched.bytes.toString("utf8").slice(0, TEXT_ATTACHMENT_MAX_CHARS).trim();
        if (text) {
          textFiles.push(`[Attached file "${attachment.name || "file"}":\n${text}\n]`);
        }
      }
      continue;
    }

    if (
      config.aiProvider === "gemini" &&
      isMultimodalBinaryAttachment(attachment) &&
      binaryMedia.length < 2 &&
      (attachment.size || 0) <= BINARY_MEDIA_MAX_BYTES
    ) {
      const fetched = await fetchBytes(attachment.url, 10000);
      if (fetched && fetched.bytes.length <= BINARY_MEDIA_MAX_BYTES) {
        const mime = String(attachment.contentType || fetched.contentType).split(";")[0];
        binaryMedia.push({
          name: attachment.name || "media",
          mimeType: mime,
          data: fetched.bytes.toString("base64"),
        });
      }
    }
  }

  return {
    textNotes: textFiles.join("\n\n"),
    binaryMedia,
  };
}
