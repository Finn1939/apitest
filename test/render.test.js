import test from "node:test";
import assert from "node:assert/strict";
import { renderDiscordMentions } from "../src/render.js";

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
