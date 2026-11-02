import { config } from "./config.js";

// Vision pipeline: turn image attachments into model-ready image parts.
//
// The hosted bot runs WITHOUT sharp: it is not a root dependency, and the
// host's deploy flow is `git pull` + `node` — no npm install step. (The copy
// nested inside @huggingface/transformers cannot be imported; its package
// exports block outside subpaths.) So nothing here may require sharp:
//   - small images are sent inline as base64, exactly as before;
//   - LARGE images (the old code silently dropped anything over 2 MB, which
//     is most iPhone photos — "I don't see an attached image, nya") are
//     downscaled by Discord's own media proxy (attachment.proxyURL with
//     width/height params) — a resize the CDN does for us, zero dependencies;
//   - if sharp happens to be installed anyway, it is preferred (EXIF
//     rotation + local downscale).
// Every drop is logged loudly; nothing disappears silently anymore.

const VISION_MAX_IMAGES = 2;
const VISION_MAX_BYTES = 8 * 1024 * 1024; // source attachment sanity cap
const VISION_INLINE_MAX_BYTES = 2 * 1024 * 1024; // inline base64 payload cap
const VISION_PROXY_LADDER = [1536, 1024, 768]; // proxy resize box, tried in order

// System-prompt note for the honest failure case: images were attached but
// none could be loaded for viewing. She says she cannot open it — she never
// pretends to see it and never asks "which one?".
export const VISION_UNAVAILABLE_NOTE =
  "An image was attached to this message but it could not be loaded for you to view (too large or unsupported format). Be honest about it: say you can't open the image right now. Do NOT pretend to see it and do NOT ask which image they mean. Ask them to send a smaller version or paste the text instead.";

let sharpModule = null;
try {
  // Optional quality path. Missing on the stock host by design; every other
  // path works without it.
  sharpModule = (await import("sharp")).default;
} catch {
  // Fine: the Discord media proxy handles large images instead.
}

export function hasSharp() {
  return Boolean(sharpModule);
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function fetchImage(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim();
  return { bytes, contentType };
}

function toDataUrl(bytes, contentType) {
  return `data:${contentType || "image/jpeg"};base64,${bytes.toString("base64")}`;
}

function proxiedUrl(attachment, box) {
  const joiner = attachment.proxyURL.includes("?") ? "&" : "?";
  return `${attachment.proxyURL}${joiner}width=${box}&height=${box}`;
}

// One attachment -> one model-ready image string (data URL, or a plain CDN
// URL in url-transport mode). Returns null when nothing could be prepared;
// the caller logs it — this function never warns on its own behalf.
async function attachmentToImage(attachment, sharp) {
  // URL transport: hand Discord's public CDN link to the API and let it do
  // the downloading. Nothing to fetch locally, nothing to resize.
  if (config.visionTransport === "url") return attachment.url;

  // With sharp available, always take the original bytes and downscale
  // locally: best quality, EXIF-aware (iPhone photos arrive rotated).
  if (sharp) {
    const got = await fetchImage(attachment.url);
    if (!got) return null;
    const out = await sharp(got.bytes)
      .rotate() // respect EXIF orientation
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return toDataUrl(out, "image/jpeg");
  }

  // Small images go through as-is — the path that always worked.
  if (attachment.size <= VISION_INLINE_MAX_BYTES) {
    const got = await fetchImage(attachment.url);
    if (got && got.bytes.length <= VISION_INLINE_MAX_BYTES) {
      return toDataUrl(got.bytes, got.contentType || String(attachment.contentType || "image/jpeg"));
    }
  }

  // Too big for inline base64 with no local downscaler: Discord's media
  // proxy serves a resized copy of any attachment. Walk the ladder down
  // until the payload fits; if the proxy itself is unreachable, stop.
  for (const box of VISION_PROXY_LADDER) {
    const got = await fetchImage(proxiedUrl(attachment, box));
    if (!got) return null;
    if (!String(got.contentType).startsWith("image/")) return null;
    if (got.bytes.length <= VISION_INLINE_MAX_BYTES) {
      return toDataUrl(got.bytes, got.contentType);
    }
  }
  return null;
}

// Only images from people actually talking to her are fetched — never from
// bot spam, never from passive channel traffic. Same request count as a
// normal reply; the images ride along inside it.
export async function collectVisionImages(message, { sharp = sharpModule } = {}) {
  const images = [];
  for (const attachment of (message.attachments?.values?.() || [])) {
    if (images.length >= VISION_MAX_IMAGES) break;
    const type = String(attachment.contentType || "");
    if (!type.startsWith("image/")) continue;
    if (attachment.size > VISION_MAX_BYTES) {
      console.warn(`[teacher-san] vision: skipped ${attachment.name || "image"} (${humanSize(attachment.size)}) — over the ${VISION_MAX_BYTES / 1024 / 1024} MB source cap`);
      continue;
    }
    let image = null;
    try {
      image = await attachmentToImage(attachment, sharp);
    } catch (error) {
      console.warn(`[teacher-san] vision: loading ${attachment.name || "image"} failed: ${error.message}`);
    }
    if (image) images.push(image);
    else console.warn(`[teacher-san] vision: could not prepare ${attachment.name || "image"} (${humanSize(attachment.size)}, ${type || "unknown type"}) for the model — she will be told she cannot open it. Workaround: VISION_TRANSPORT=url in .env`);
  }
  if (images.length) {
    const kb = Math.round(images.reduce((total, image) => total + image.length, 0) / 1024);
    console.log(`[teacher-san] vision: ${images.length} image(s) ready for the model (~${kb} KB ${config.visionTransport === "url" ? "via CDN link" : "inline"})`);
  }
  return images;
}
