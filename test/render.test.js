import test from "node:test";
import assert from "node:assert/strict";
import { renderAttachments, renderButtons, renderChannelSnapshot, renderDiscordMentions, renderEmbeds, renderMediaExtras, renderPoll, renderStickers, visionUserContent } from "../src/render.js";

test("renders user, role, and channel mentions into readable names", () => {
  const users = new Map([["111", { displayName: "Jake", globalName: "Jake", username: "jakey" }]]);
  const roles = new Map([["222", { name: "Gamer" }]]);
  const channels = new Map([["333", { name: "general" }]]);
  const out = renderDiscordMentions(
    "hey <@111> check <#333> for <@&222> and <@!111> again",
    { users, roles, channels },
  );
  assert.equal(out, "hey @Jake check #general for @Gamer and @Jake again");
});

test("prefers the global display name over the raw username", () => {
  const users = new Map([["444", { globalName: "sprite vodka", username: "sprite_vodka" }]]);
  const out = renderDiscordMentions("ping <@444> please", { users });
  assert.equal(out, "ping @sprite vodka please");
});

test("leaves unresolvable mentions untouched", () => {
  const out = renderDiscordMentions("<@999> <#888> <@&777>", {});
  assert.equal(out, "<@999> <#888> <@&777>");
});

test("empty and null input never crash", () => {
  assert.equal(renderDiscordMentions("", {}), "");
  assert.equal(renderDiscordMentions(null, {}), "");
});

test("flattens game-bot embeds into readable panel text", () => {
  // OwO's HighLow panel: the message content is empty and the whole game state
  // lives in one embed. She used to be blind to it.
  const embeds = [{
    title: "HighLow",
    description: "Current card: Queen of clubs (12)",
    fields: [
      { name: "Higher", value: "+12,219" },
      { name: "Lower", value: "+1,110" },
      { name: "Same", value: "+10,000" },
    ],
    footer: { text: "Bet: 1,000 shards" },
  }];
  const out = renderEmbeds(embeds);
  assert.match(out, /^\[/);
  assert.match(out, /HighLow/);
  assert.match(out, /Queen of clubs \(12\)/);
  assert.match(out, /Higher: \+12,219/);
  assert.match(out, /Lower: \+1,110/);
  assert.match(out, /Same: \+10,000/);
  assert.match(out, /Bet: 1,000 shards/);
});

test("renderEmbeds caps length and skips empty input", () => {
  assert.equal(renderEmbeds([]), "");
  assert.equal(renderEmbeds(null), "");
  assert.equal(renderEmbeds([{ title: "", description: "", fields: [] }]), "");
  const long = renderEmbeds([{ description: "x".repeat(500) }], { maxLength: 100 });
  assert.ok(long.length <= 102, "embed text must be capped");
});

test("renders button labels from bot panels", () => {
  const components = [
    { components: [
      { label: "Higher (+12,219)" },
      { label: "Lower (+1,110)" },
      { label: "Same (+10,000)" },
    ] },
    { components: [{ label: "Cash Out" }] },
  ];
  const out = renderButtons(components);
  assert.match(out, /choices: /);
  assert.match(out, /Higher \(\+12,219\)/);
  assert.match(out, /Lower \(\+1,110\)/);
  assert.match(out, /Cash Out/);
  assert.equal(renderButtons([]), "");
  assert.equal(renderButtons(undefined), "");
  assert.equal(renderButtons([{ components: [{ label: "" }] }]), "");
});

test("renders attachments as readable metadata", () => {
  // A photo with dimensions — she knows an image exists and how big.
  const photo = new Map([["a1", {
    name: "meme.png", contentType: "image/png", size: 512 * 1024,
    width: 800, height: 600,
  }]]);
  assert.equal(renderAttachments(photo), "[attached: meme.png (image/png, 512 KB, 800×600)]");

  // A voice message with duration.
  const voice = new Map([["a2", {
    name: "", contentType: "audio/ogg; codecs=opus", size: 88 * 1024, duration: 14.2,
  }]]);
  assert.equal(renderAttachments(voice), "[attached: voice message (audio/ogg, 88 KB, 14s)]");

  // Multiple attachments, capped with a "+N more" note.
  const many = new Map([["a", { name: "1.jpg", contentType: "image/jpeg", size: 1000 }],
    ["b", { name: "2.jpg", contentType: "image/jpeg", size: 1000 }],
    ["c", { name: "3.jpg", contentType: "image/jpeg", size: 1000 }],
    ["d", { name: "4.jpg", contentType: "image/jpeg", size: 1000 }],
    ["e", { name: "5.jpg", contentType: "image/jpeg", size: 1000 }],
    ["f", { name: "6.jpg", contentType: "image/jpeg", size: 1000 }]]);
  const out = renderAttachments(many);
  assert.match(out, /4\.jpg/);
  assert.ok(!out.includes("5.jpg"), "beyond the cap only a count is shown");
  assert.match(out, /\+2 more/);

  // Nothing attached, garbage input.
  assert.equal(renderAttachments(new Map()), "");
  assert.equal(renderAttachments(null), "");
});

test("renders stickers and polls into notes she can read", () => {
  assert.equal(renderStickers(new Map([["s1", { name: "Batcup" }]])), "[sticker: Batcup]");
  assert.equal(renderStickers(null), "");
  assert.equal(renderPoll({ question: { text: "Movie night?" }, answers: new Map([["1", { text: "Yes" }], ["2", { text: "No" }]]) }),
    "[poll: Movie night? — options: Yes, No]");
  // Plain arrays work too (test doubles), and empty polls stay silent.
  assert.equal(renderPoll({ question: { text: "Lunch?" }, answers: [{ text: "Ram" }, { text: "Sushi" }] }),
    "[poll: Lunch? — options: Ram, Sushi]");
  assert.equal(renderPoll(null), "");
  assert.equal(renderPoll({ answers: [{ text: "Yes" }] }), "");
});

test("renderMediaExtras combines all media notes for one message", () => {
  const message = {
    attachments: new Map([["a1", { name: "cat.png", contentType: "image/png", size: 2048, width: 64, height: 64 }]]),
    stickers: new Map([["s1", { name: "Sadge" }]]),
    poll: null,
  };
  assert.equal(renderMediaExtras(message), "[attached: cat.png (image/png, 2 KB, 64×64)] [sticker: Sadge]");
  assert.equal(renderMediaExtras({ attachments: new Map(), stickers: new Map() }), "");
  assert.equal(renderMediaExtras(null), "");
});

test("visionUserContent passes through text and builds multimodal arrays", () => {
  // Text-only: plain string, nothing changes for the API.
  assert.equal(visionUserContent("what do you think?", []), "what do you think?");
  assert.equal(visionUserContent("what do you think?", null), "what do you think?");

  // With images: the user turn becomes a content array with the images after
  // the text, in OpenAI vision format.
  const content = visionUserContent("look at this", ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]);
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: "look at this" });
  assert.deepEqual(content[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } });
  assert.deepEqual(content[2], { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } });
});

test("channel snapshot shows bot game panels with buttons, skips her own messages", () => {
  // The exact screenshot scenario: OwO's HighLow panel, then someone asking
  // her for help — plus one of her own earlier replies that must not appear.
  const selfId = "42";
  const owoEmbed = {
    title: "HighLow",
    description: "Current card: 9 of diamonds",
    fields: [{ name: "Higher", value: "+2,325" }, { name: "Lower", value: "+597" }],
  };
  const messages = [
    {
      createdTimestamp: 3000,
      author: { id: selfId, bot: true, username: "teacher-san" },
      content: "go all in, trust me",
    },
    {
      createdTimestamp: 1000,
      author: { id: "1", bot: true, displayName: "OwO", username: "owo" },
      content: "",
      embeds: [owoEmbed],
      components: [{ components: [{ label: "Higher (+2,325)" }, { label: "Cash Out: 1,131" }] }],
    },
    {
      createdTimestamp: 2000,
      author: { id: "2", bot: false, displayName: "sprite vodka", username: "sprite_vodka" },
      member: { displayName: "sprite vodka" },
      content: "<@42> help me decide",
      mentions: { users: new Map([[selfId, { displayName: "teacher-san", username: "teacher_san" }]]) },
    },
  ];
  const out = renderChannelSnapshot(messages, selfId);
  const lines = out.split("\n");
  // Oldest first, her own message dropped.
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("OwO [bot]:"));
  assert.ok(lines[0].includes("HighLow"));
  assert.ok(lines[0].includes("Higher (+2,325)")); // buttons rendered too
  assert.ok(lines[1].startsWith("sprite vodka:"));
  assert.ok(lines[1].includes("@teacher-san help me decide")); // mention → name
  assert.ok(!out.includes("go all in")); // her own messages never duplicated
});

test("channel snapshot handles empty channels and message-shaped junk", () => {
  assert.equal(renderChannelSnapshot([], "1"), "");
  assert.equal(renderChannelSnapshot(null, "1"), "");
  assert.equal(renderChannelSnapshot([null, { author: null }, { author: { id: "9" }, content: "   " }], "1"), "");
});
