import test from "node:test";
import assert from "node:assert/strict";
import {
  renderAttachments,
  renderButtons,
  renderChannelSnapshot,
  renderDiscordMentions,
  renderEmbeds,
  visionUserContent,
} from "../src/render.js";
import { extractJson, validLearnedCommand } from "../src/analysis.js";

test("renderDiscordMentions resolves users, roles, and channels into readable names", () => {
  const out = renderDiscordMentions("hey <@111> check <#222> with <@&333>", {
    users: new Map([["111", { displayName: "Alex" }]]),
    channels: new Map([["222", { name: "netrunners" }]]),
    roles: new Map([["333", { name: "Fixers" }]]),
  });
  assert.equal(out, "hey @Alex check #netrunners with @Fixers");
});

test("renderChannelSnapshot includes embeds, buttons, and attachment notes", () => {
  const snap = renderChannelSnapshot([
    {
      createdTimestamp: 100,
      author: { id: "b1", username: "OwO", bot: true },
      content: "",
      embeds: [{ title: "HighLow", description: "Current card: 7" }],
      components: [{ components: [{ label: "Higher" }, { label: "Lower" }] }],
    },
  ], "self-id");
  assert.match(snap, /OwO \[bot\]/);
  assert.match(snap, /HighLow/);
  assert.match(snap, /Higher \/ Lower/);
});

test("visionUserContent supports images and Gemini binary inline_data", () => {
  const content = visionUserContent(
    "listen to this",
    ["data:image/png;base64,AAA"],
    [{ mimeType: "audio/ogg", data: "BBB" }],
  );
  assert.equal(Array.isArray(content), true);
  assert.equal(content.length, 3);
  assert.equal(content[1].type, "image_url");
  assert.equal(content[2].type, "inline_data");
});

test("renderAttachments and renderButtons format Discord media cleanly", () => {
  assert.match(renderAttachments([{ name: "log.txt", contentType: "text/plain", size: 2048 }]), /log\.txt/);
  assert.equal(renderButtons([{ components: [{ label: "Confirm" }] }]), "[choices: Confirm]");
});

test("analysis JSON extractor handles fenced JSON and learned commands", () => {
  assert.deepEqual(extractJson("```json\n{\"speak\":true}\n```"), { speak: true });
  assert.equal(validLearnedCommand("whl 500", "whl"), "whl");
  assert.equal(validLearnedCommand("here look", "here"), "");
});
