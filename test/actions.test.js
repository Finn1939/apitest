import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  DELETE_ACTIONS,
  formatActionOutcome,
  formatChannelName,
  isActionRequest,
  normalizePlan,
  requiresDeleteConfirmation,
  resolveChannelFromList,
  resolveRoleFromList,
  shouldCheckAuthorizedAction,
  validatePlan,
} from "../src/actions-schema.js";

test("action registry covers 80+ max-capability Discord operations across all domains", () => {
  const keys = Object.keys(ACTIONS);
  assert.ok(keys.length >= 80, `Expected 80+ operations, got ${keys.length}`);
  for (const required of [
    "server_inspect", "server_edit", "server_backup_snapshot", "bot_presence_set",
    "members_list", "member_inspect", "members_nickname_all", "members_prune", "member_dm",
    "roles_list", "role_create", "role_edit", "role_delete", "roles_bulk_delete",
    "role_add", "role_remove", "role_add_all", "role_remove_all",
    "channels_list", "channel_inspect", "channel_read", "channel_create", "channel_edit", "channel_rename",
    "channel_clone", "channel_permissions_set", "channel_permissions_delete", "channel_sync_permissions",
    "channel_delete", "channels_bulk_delete",
    "voice_move_all", "voice_disconnect_all", "voice_mute_all", "voice_deafen_all", "voice_status_set",
    "voice_join", "voice_leave", "voice_say",
    "stage_start", "stage_edit", "stage_end",
    "message_send", "poll_send", "message_edit", "message_react", "message_reactions_clear",
    "message_pin", "message_delete", "message_purge",
    "thread_create", "thread_edit", "thread_delete",
    "webhook_create", "webhook_send", "webhook_delete",
    "emoji_create", "emoji_delete", "sticker_create", "sticker_delete",
    "event_create", "event_delete", "automod_create", "automod_delete",
    "invite_create", "invite_delete", "audit_logs_read",
  ]) {
    assert.ok(Object.hasOwn(ACTIONS, required), `Missing action ${required}`);
  }
});

test("ONLY delete/purge/prune operations trigger confirmation gate; all other operations run immediately", () => {
  const immediatePlan = validatePlan({
    actions: [
      { action: "server_edit", args: { name: "Night City" } },
      { action: "bot_presence_set", args: { status: "dnd", activityType: "watching", activityText: "Afterlife" } },
      { action: "role_create", args: { name: "coke", color: "#F59E0B", permissions: ["ManageMessages"] } },
      { action: "role_add_all", args: { role: "$last_role", targetGroup: "everyone" } },
      { action: "channel_create", args: { name: "ops", type: "category" } },
      { action: "channel_create", args: { name: "briefing", type: "text", parent: "$last_category", slowmode: 5 } },
      { action: "channel_permissions_set", args: { channel: "$last_channel", target: "@everyone", targetType: "role", deny: ["SendMessages"] } },
      { action: "poll_send", args: { channel: "$last_channel", question: "Best chrome?", answers: ["Sandevistan", "Cyberdeck"] } },
      { action: "member_ban", args: { user: "123456789012345678", reason: "raiding" } },
      { action: "webhook_create", args: { channel: "$last_channel", name: "Watcher" } },
      { action: "webhook_send", args: { webhook: "$last_webhook", content: "Online." } },
    ],
  });
  assert.equal(requiresDeleteConfirmation(immediatePlan), false);

  for (const deleteAction of DELETE_ACTIONS) {
    const sampleArgs = {
      role_delete: { role: "123456789012345678" },
      roles_bulk_delete: { roles: ["123456789012345678"] },
      channel_delete: { channel: "123456789012345678" },
      channels_bulk_delete: { channels: ["123456789012345678"] },
      channel_permissions_delete: { channel: "123456789012345678", target: "@everyone", targetType: "role" },
      thread_delete: { channel: "123456789012345678" },
      message_delete: { channel: "123456789012345678", message: "123456789012345679" },
      message_purge: { channel: "123456789012345678", count: 25 },
      message_reactions_clear: { channel: "123456789012345678", message: "123456789012345679" },
      members_prune: { days: 7, computeOnly: false },
      webhook_delete: { webhook: "123456789012345678" },
      emoji_delete: { emoji: "kekw" },
      sticker_delete: { sticker: "wave" },
      event_delete: { event: "123456789012345678" },
      automod_delete: { rule: "123456789012345678" },
      invite_delete: { code: "abc123" },
    }[deleteAction];
    const deletePlan = validatePlan({ actions: [{ action: deleteAction, args: sampleArgs }] });
    assert.equal(requiresDeleteConfirmation(deletePlan), true, `Expected ${deleteAction} to require confirmation`);
  }
});

test("mixed plan containing any delete action gates the entire plan behind confirmation", () => {
  const mixed = validatePlan({
    actions: [
      { action: "channel_create", args: { name: "archive", type: "text" } },
      { action: "channel_delete", args: { channel: "old-chat" } },
    ],
  });
  assert.equal(requiresDeleteConfirmation(mixed), true);
});

test("casual natural-language action detection catches typos, slang, mid-sentence requests, and snowflake reads", () => {
  assert.equal(isActionRequest({ content: "yo tbh rename #general to netrunners and put a 5s slowmode on it, also how was your night?" }, "t", true), true);
  assert.equal(isActionRequest({ content: "can someone lock #announcements real quick" }, "t", true), true);
  assert.equal(isActionRequest({ content: "capri who's in voice right now?" }, "t", false), true);
  assert.equal(isActionRequest({ content: "read 1567358193334493247" }, "t", true), true);
  assert.equal(isActionRequest({ content: "lol good morning everyone" }, "t", true), false);
  // Authorized controller typo tolerance
  assert.equal(shouldCheckAuthorizedAction({ content: "cpuld you add role coke to everyone" }, "t", false), true);
  assert.equal(shouldCheckAuthorizedAction({ content: "renmae dis channel to saitama" }, "t", false), true);
  assert.equal(shouldCheckAuthorizedAction({ content: "lol" }, "t", false), false);
});

test("rename safety net extracts target name when LLM omits name and rejects empty channel_edit", () => {
  const recovered = normalizePlan(
    { actions: [{ action: "channel_edit", args: { channel: "123456789012345678" } }] },
    "123456789012345678",
    "rename this channel to saitama",
  );
  const valid = validatePlan(recovered);
  assert.equal(valid.actions[0].args.name, "saitama");

  const aliasRecovered = normalizePlan(
    { actions: [{ action: "channel_edit", args: { channel: "this channel", to: "saitama" } }] },
    "123456789012345678",
  );
  assert.equal(validatePlan(aliasRecovered).actions[0].args.name, "saitama");

  assert.throws(
    () => validatePlan({ actions: [{ action: "channel_edit", args: { channel: "123456789012345678" } }] }),
    /at least one change/,
  );
});

test("role_add with typos/aliases and 'everyone' auto-routes cleanly to role_add_all", () => {
  const normalized = normalizePlan({
    actions: [
      { action: "role_add", args: { roleName: "coke", target: "everyone" } },
    ],
  }, "123456789012345678", "cpuld you add role coke to everyone");
  const valid = validatePlan(normalized);
  assert.equal(valid.actions[0].action, "role_add_all");
  assert.equal(valid.actions[0].args.role, "coke");
  assert.equal(valid.actions[0].args.targetGroup, "everyone");
  assert.equal(requiresDeleteConfirmation(valid), false);
});

test("formatActionOutcome flags failed steps cleanly so failed renames are never reported as success", () => {
  const failed = formatActionOutcome(["Step 1 (channel_edit) failed: Discord rate-limited channel edits on #dog."]);
  assert.equal(failed.allSucceeded, false);
  assert.equal(failed.failures.length, 1);

  const ok = formatActionOutcome(["Updated <#1567358193334493247>: renamed #dog -> #thalia."]);
  assert.equal(ok.allSucceeded, true);
  assert.equal(ok.failures.length, 0);
});

test("normalizePlan converts channel_rename, current-channel aliases, null optionals, and string numbers", () => {
  const normalized = normalizePlan({
    actions: [
      { action: "channel_rename", args: { channel: "this channel", newName: "afterlife-lounge", topic: null } },
      { action: "channel_edit", args: { slowmode: "5", nsfw: "false" } },
    ],
  }, "123456789012345678");
  const valid = validatePlan(normalized);
  assert.equal(valid.actions[0].action, "channel_edit");
  assert.equal(valid.actions[0].args.channel, "123456789012345678");
  assert.equal(valid.actions[0].args.name, "afterlife-lounge");
  assert.equal(valid.actions[0].args.topic, undefined);
  assert.equal(valid.actions[1].args.channel, "123456789012345678");
  assert.equal(valid.actions[1].args.slowmode, 5);
  assert.equal(valid.actions[1].args.nsfw, false);
  assert.equal(requiresDeleteConfirmation(valid), false);
});

test("resolveChannelFromList, resolveRoleFromList, and formatChannelName handle emoji prefixes and slug formatting", () => {
  const channels = [
    { id: "111111111111111111", name: "💬・general", type: 0 },
    { id: "222222222222222222", name: "Lounge VC", type: 2 },
  ];
  const roles = [
    { id: "333333333333333333", name: "🥤・coke" },
    { id: "444444444444444444", name: "Netrunner" },
  ];
  assert.equal(resolveChannelFromList(channels, "general").id, "111111111111111111");
  assert.equal(resolveChannelFromList(channels, "this channel", { $current_channel: "111111111111111111" }).id, "111111111111111111");
  assert.equal(resolveRoleFromList(roles, "coke").id, "333333333333333333");
  assert.equal(resolveRoleFromList(roles, "@Netrunner").id, "444444444444444444");
  assert.equal(formatChannelName("Night Deck", 0), "night-deck");
  assert.equal(formatChannelName("Night Lounge VC", 2), "Night Lounge VC");
});

test("plan validation rejects malformed permissions and oversized plans", () => {
  assert.throws(() => validatePlan({ actions: [] }), /1–100/);
  assert.throws(() => validatePlan({ actions: [{ action: "role_create", args: { name: "Bad", permissions: ["FakePerm"] } }] }), /Invalid/);
  assert.throws(() => validatePlan({ actions: [{ action: "message_purge", args: { channel: "general", count: 999 } }] }), /Invalid/);
});
