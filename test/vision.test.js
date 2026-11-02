import test from "node:test";
import assert from "node:assert/strict";
import { collectVisionImages, VISION_UNAVAILABLE_NOTE, hasSharp } from "../src/vision.js";
import { config } from "../src/config.js";

// The vision pipeline must work WITHOUT sharp (the host never runs npm
// install, so sharp is never there). Large images ride Discord's media proxy
// (attachment.proxyURL + width/height) instead of being silently dropped.

function jpegBytes(kb) {
  return Buffer.alloc(kb * 1024, 0xff); // size is all that matters to the ladder
}

function attachment({ name = "IMG_7744.jpeg", contentType = "image/jpeg", size, url, proxyURL }) {
  return {
    name,
    contentType,
    size,
    url: url || `https://cdn.discordapp.com/attachments/1/2/${name}?ex=abc&is=def`,
    proxyURL: proxyURL || `https://media.discordapp.net/attachments/1/2/${name}?ex=abc&is=def`,
  };
}

function messageWith(...attachments) {
  return { attachments: new Map(attachments.map((a, i) => [`id${i}`, a])) };
}

// Installs a fetch stub that routes by URL; records every requested URL.
function stubFetch(router) {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const handler = router[String(url)];
    if (!handler) return new Response("not found", { status: 404 });
    return new Response(handler.body, { headers: { "content-type": handler.contentType || "image/jpeg" } });
  };
  return { requested, restore: () => { globalThis.fetch = original; } };
}

test("small images are inlined from the original URL, no proxy involved", async () => {
  const att = attachment({ size: 200 * 1024 });
  const { requested, restore } = stubFetch({
    [att.url]: { body: jpegBytes(150), contentType: "image/jpeg" },
  });
  try {
    const images = await collectVisionImages(messageWith(att), { sharp: null });
    assert.equal(images.length, 1);
    assert.match(images[0], /^data:image\/jpeg;base64,/);
    assert.equal(requested.length, 1);
    assert.ok(requested[0].startsWith("https://cdn.discordapp.com/"));
  } finally {
    restore();
  }
});

test("large images (the old silent drop) are downscaled via the media proxy", async () => {
  // A 3.4 MB iPhone photo: over the 2 MB inline cap, the exact case that used
  // to disappear without a trace.
  const att = attachment({ size: 3.4 * 1024 * 1024 });
  const proxyUrl1536 = `${att.proxyURL}&width=1536&height=1536`;
  const { requested, restore } = stubFetch({
    [proxyUrl1536]: { body: jpegBytes(380), contentType: "image/jpeg" },
  });
  try {
    const images = await collectVisionImages(messageWith(att), { sharp: null });
    assert.equal(images.length, 1);
    assert.match(images[0], /^data:image\/jpeg;base64,/);
    assert.deepEqual(requested, [proxyUrl1536]);
  } finally {
    restore();
  }
});

test("the proxy ladder walks down until the payload fits", async () => {
  const att = attachment({ size: 5 * 1024 * 1024 });
  const p1536 = `${att.proxyURL}&width=1536&height=1536`;
  const p1024 = `${att.proxyURL}&width=1024&height=1024`;
  const { requested, restore } = stubFetch({
    [p1536]: { body: jpegBytes(2500), contentType: "image/jpeg" }, // still too big
    [p1024]: { body: jpegBytes(900), contentType: "image/jpeg" },  // fits
  });
  try {
    const images = await collectVisionImages(messageWith(att), { sharp: null });
    assert.equal(images.length, 1);
    assert.match(images[0], /^data:image\/jpeg;base64,/);
    assert.deepEqual(requested, [p1536, p1024]);
  } finally {
    restore();
  }
});

test("an unloadable image is dropped with a warning naming the workaround", async () => {
  const att = attachment({ size: 3 * 1024 * 1024 });
  const { requested, restore } = stubFetch({}); // everything 404s
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    const images = await collectVisionImages(messageWith(att), { sharp: null });
    assert.equal(images.length, 0);
    assert.ok(warnings.some((w) => w.includes("could not prepare") && w.includes("VISION_TRANSPORT=url")));
  } finally {
    console.warn = originalWarn;
    restore();
  }
});

test("non-image attachments and oversize sources are skipped without fetching", async () => {
  const video = attachment({ name: "clip.mp4", contentType: "video/mp4", size: 5 * 1024 * 1024 });
  const huge = attachment({ name: "raw.png", contentType: "image/png", size: 9 * 1024 * 1024 });
  const { requested, restore } = stubFetch({});
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    const images = await collectVisionImages(messageWith(video, huge), { sharp: null });
    assert.equal(images.length, 0);
    assert.equal(requested.length, 0); // never even tried to download
    assert.ok(warnings.some((w) => w.includes("raw.png") && w.includes("source cap")));
  } finally {
    console.warn = originalWarn;
    restore();
  }
});

test("VISION_TRANSPORT=url passes the CDN link straight through, zero downloads", async () => {
  const original = config.visionTransport;
  config.visionTransport = "url";
  const att = attachment({ size: 4 * 1024 * 1024 }); // would need the proxy in base64 mode
  const { requested, restore } = stubFetch({});
  try {
    const images = await collectVisionImages(messageWith(att), { sharp: null });
    assert.deepEqual(images, [att.url]);
    assert.equal(requested.length, 0);
  } finally {
    config.visionTransport = original;
    restore();
  }
});

test("a successful collection logs one compact summary line", async () => {
  const att = attachment({ size: 3 * 1024 * 1024 });
  const { restore } = stubFetch({
    [`${att.proxyURL}&width=1536&height=1536`]: { body: jpegBytes(300), contentType: "image/jpeg" },
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    await collectVisionImages(messageWith(att), { sharp: null });
    assert.ok(logs.some((line) => line.includes("[teacher-san] vision: 1 image(s) ready")));
  } finally {
    console.log = originalLog;
    restore();
  }
});

test("the honesty note tells her to admit she cannot open the image", () => {
  assert.match(VISION_UNAVAILABLE_NOTE, /could not be loaded/i);
  assert.match(VISION_UNAVAILABLE_NOTE, /Do NOT pretend/i);
  assert.match(VISION_UNAVAILABLE_NOTE, /which image/i);
});

test("vision works whether or not sharp is present on this machine", () => {
  // Informational: the pipeline must not depend on the answer.
  assert.equal(typeof hasSharp(), "boolean");
});
