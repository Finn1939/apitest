import test from "node:test";
import assert from "node:assert/strict";
import { canRunCommands, parseCommandUserIds } from "../src/command-auth.js";

test("parseCommandUserIds validates Discord snowflake IDs", () => {
  const set = parseCommandUserIds("123456789012345678, 987654321098765432");
  assert.equal(set.size, 2);
  assert.throws(() => parseCommandUserIds("not-an-id"), /17–20 digits/);
});

test("canRunCommands grants access to allowlisted IDs and optional guild admins", () => {
  const allowed = new Set(["123456789012345678"]);
  assert.equal(canRunCommands("123456789012345678", allowed), true);
  assert.equal(canRunCommands("111111111111111111", allowed), false);

  const adminMember = {
    id: "222222222222222222",
    guild: { ownerId: "999999999999999999" },
    permissions: { has: (flag) => flag === "Administrator" },
  };
  assert.equal(canRunCommands(adminMember, allowed, { allowGuildAdmins: true }), true);
  assert.equal(canRunCommands(adminMember, allowed, { allowGuildAdmins: false }), false);
});
