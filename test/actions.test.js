import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits as P, Collection } from 'discord.js';
import { validatePlan, checkPermission, checkHierarchy, executePlan, executeStep, isActionRequest, createActionHandler, requiresDeleteConfirmation, confirmDeletion } from '../src/actions.js';
const ownerId = '100000000000000001', actorId = '100000000000000002', botId = '100000000000000003', targetId = '100000000000000004', roleId = '100000000000000005', channelId = '100000000000000006';
const position = n => ({ position: n, comparePositionTo(other) { return n - other.position; } });
const member = (id, level, permissions = []) => ({ id, roles: { highest: position(level) }, permissions: new PermissionsBitField(permissions) });
function fixture() {
  const actor = member(actorId, 10, [P.Administrator]);
  const bot = member(botId, 20, [P.Administrator]);
  const target = member(targetId, 1);
  const calls = [];
  const role = { ...position(2), id: roleId, name: 'Crew', permissions: new PermissionsBitField(), editable: true, managed: false, delete: async () => calls.push(['delete']) };
  const channel = { id: channelId, guildId: ownerId, permissionsFor: m => m.permissions, isTextBased: () => true, isThread: () => false, send: async data => { calls.push(['send', data]); return { id: '123456789012345678' }; } };
  target.roles.add = async r => calls.push(['role_add', r.id]);
  target.bannable = true;
  target.ban = async options => calls.push(['ban', options]);
  const guild = {
    id: ownerId, ownerId, fetch: async () => guild,
    roles: { fetch: async id => id ? role : new Collection([[roleId, role]]), create: async opts => { calls.push(['create', opts]); return role; } },
    channels: { fetch: async id => id ? channel : new Collection([[channelId, channel]]) },
    members: { fetch: async ({ user }) => user === actorId ? actor : target, fetchMe: async () => bot },
    setName: async name => calls.push(['rename', name]),
  };
  const message = { id: '200000000000000001', author: { id: actorId }, guild, channel, content: 'Hey Capri change the server name to Night City', mentions: { users: new Collection() } };
  return { actor, bot, target, role, channel, guild, message, calls };
}
const plan = (...actions) => ({ actions });
const step = (action, args) => ({ action, args });
test('validates chained role creation with a reference', () => {
  assert.equal(validatePlan(plan(step('role_create', { name: 'Crew' }), step('role_add', { role: '$last_role', user: targetId }))).actions.length, 2);
});
test('rejects arbitrary endpoints, unknown fields, malformed IDs and unsafe ranges', () => {
  for (const action of [step('eval', { code: 'x' }), step('server_rename', { name: 'X', token: 'x' }), step('member_unban', { user: '@someone' }), step('member_timeout', { user: targetId, minutes: -1 }), step('message_purge', { channel: channelId, count: 101 }), step('role_create', { name: 'X', permissions: ['FakeFlag'] }), step('role_add', { role: '$last_channel', user: targetId })]) assert.throws(() => validatePlan(plan(action)));
  assert.throws(() => validatePlan({ actions: [] }));
  assert.throws(() => validatePlan({ actions: Array(9).fill(step('server_rename', { name: 'X' })) }));
});
test('requires an ID for unbanning a member by name', () => {
  assert.throws(() => validatePlan(plan(step('member_unban', { user: 'karuta' }))), /Provide a Discord user ID to unban/);
});
test('requires explicit Capri address, mention, or t do', () => {
  assert.equal(isActionRequest({ content: 'ban this user' }), false);
  assert.equal(isActionRequest({ content: 'hey Capri ban this user' }), true);
  assert.equal(isActionRequest({ content: 't do make a role' }), true);
  assert.equal(isActionRequest({ content: 'hi Capri' }), false);
});
test('allowlisted users can phrase clear action requests casually without addressing Capri', () => {
  assert.equal(isActionRequest({ content: 'Create a role named Crew' }, 't', true), true);
  assert.equal(isActionRequest({ content: 'Could you rename the server to Night City?' }, 't', true), true);
  assert.equal(isActionRequest({ content: 'Bet, running it again—add sprite to brochacho.' }, 't', true), true);
  assert.equal(isActionRequest({ content: 'How do I create a role?' }, 't', true), false);
  assert.equal(isActionRequest({ content: 'Please do not delete that channel' }, 't', true), false);
  assert.equal(isActionRequest({ content: 'I think their role is funny' }, 't', true), false);
  assert.equal(isActionRequest({ content: 'Hey Capri, should we rename the server?' }), false);
});
test('permission check rejects missing permission even when bot has it', async () => {
  const f = fixture(); f.actor.permissions = new PermissionsBitField();
  await assert.rejects(executeStep(f.message, step('server_rename', { name: 'X' })), /Missing ManageGuild/);
  assert.equal(f.calls.length, 0);
});
test('channel overwrites are respected', () => {
  const f = fixture();
  assert.throws(() => checkPermission(f.actor, 'SendMessages', { permissionsFor: () => new PermissionsBitField() }), /Missing/);
});
test('equal/higher targets and owner cannot be moderated', () => {
  const f = fixture();
  for (const target of [member(targetId, 10), member(targetId, 21), member(ownerId, 0), f.actor, f.bot]) assert.throws(() => checkHierarchy(f.guild, f.actor, f.bot, target));
});
test('role creation and assignment execute in order using returned role ID', async () => {
  const f = fixture();
  f.message.content = `Hey Capri add Crew to <@${targetId}>`;
  const result = await executePlan(f.message, plan(step('role_create', { name: 'Crew' }), step('role_add', { role: '$last_role', user: targetId })));
  assert.equal(result.length, 2);
  assert.deepEqual(f.calls.map(c => c[0]), ['create', 'role_add']);
  assert.deepEqual(f.calls[0][1].permissions, []);
  assert.equal(f.calls[1][1], roleId);
});
test('does not trust a planner-generated member ID absent from the request', async () => {
  const f = fixture();
  f.message.content = 'add sprite to brochacho';
  await assert.rejects(
    executeStep(f.message, step('role_add', { role: roleId, user: ownerId })),
    /won’t infer a member ID from a name/,
  );
  assert.deepEqual(f.calls, []);
});
test('resolves an exact cached member name, but never guesses when there is no match', async () => {
  const f = fixture();
  f.target.displayName = 'Karuta bot';
  f.target.user = { username: 'Karuta', globalName: 'Karuta bot', bot: true };
  f.guild.members.cache = new Collection([[targetId, f.target]]);
  await executeStep(f.message, step('role_add', { role: roleId, user: 'Karuta bot' }));
  assert.deepEqual(f.calls, [['role_add', roleId]]);

  const missing = fixture();
  await assert.rejects(
    executeStep(missing.message, step('role_add', { role: roleId, user: 'Karuta bot' })),
    /couldn't find a cached member named "Karuta bot"/,
  );

  const ambiguous = fixture();
  const duplicate = member('100000000000000007', 1);
  for (const candidate of [ambiguous.target, duplicate]) {
    candidate.displayName = 'Karuta bot';
    candidate.user = { username: 'Karuta', globalName: 'Karuta bot', bot: true };
  }
  ambiguous.guild.members.cache = new Collection([[targetId, ambiguous.target], [duplicate.id, duplicate]]);
  await assert.rejects(
    executeStep(ambiguous.message, step('role_add', { role: roleId, user: 'Karuta bot' })),
    /More than one server member matches/,
  );
});
test('cannot create elevated role or assign role beyond requester permissions', async () => {
  const f = fixture(); f.actor.permissions = new PermissionsBitField([P.ManageRoles]);
  await assert.rejects(executeStep(f.message, step('role_create', { name: 'Admin', permissions: ['Administrator'] })), /Missing Administrator/);
  f.role.permissions = new PermissionsBitField([P.Administrator]);
  f.message.content = `Hey Capri add the role to <@${targetId}>`;
  await assert.rejects(executeStep(f.message, step('role_add', { role: roleId, user: targetId })), /beyond yours/);
  assert.equal(f.calls.length, 0);
});
test('partial failure stops subsequent steps and reports completed work', async () => {
  let count = 0;
  const results = await executePlan({}, plan(...Array(3).fill(step('server_rename', { name: 'X' }))), async () => { if (++count === 2) throw new Error('Forbidden'); return 'success'; });
  assert.equal(count, 2); assert.equal(results[0], 'success'); assert.match(results[1], /Later steps were not run/);
});
test('ban uses audit reason and does not delete message history', async () => {
  const f = fixture();
  f.message.content = `Hey Capri ban <@${targetId}>`;
  await executeStep(f.message, step('member_ban', { user: targetId, reason: 'Spam' }));
  assert.equal(f.calls[0][1].deleteMessageSeconds, 0);
  assert.match(f.calls[0][1].reason, /Spam/);
  assert.match(f.calls[0][1].reason, new RegExp(actorId));
});
test('message send suppresses unsolicited mention notifications', async () => {
  const f = fixture();
  await executeStep(f.message, step('message_send', { channel: channelId, content: '@everyone hello' }));
  assert.deepEqual(f.calls[0][1].allowedMentions, { parse: [] });
});
test('missing creation reference cannot execute', async () => {
  const f = fixture();
  await assert.rejects(executeStep(f.message, step('role_add', { role: '$last_role', user: targetId })), /No successful creation/);
});
function previewFixture(mode = 'approve') {
  const f = fixture(); const replies = []; const edits = []; let filter;
  const click = { customId: '', user: { id: actorId }, deferUpdate: async () => {}, followUp: async data => replies.push(data) };
  f.message.reply = async data => {
    replies.push(data);
    return {
      edit: async data => edits.push(data),
      awaitMessageComponent: async opts => {
        filter = opts.filter;
        if (mode === 'timeout') throw new Error('timeout');
        click.customId = data.components[0].components[mode === 'cancel' ? 1 : 0].data.custom_id;
        if (mode === 'revoke') f.actor.permissions = new PermissionsBitField();
        assert.equal(filter(click), true);
        assert.equal(filter({ ...click, user: { id: targetId } }), false);
        return click;
      },
    };
  };
  return { ...f, replies, edits };
}
test('planner proposes only; approval executes and reports actual success', async () => {
  const f = previewFixture();
  const handler = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => { assert.equal(f.calls.length, 0); return JSON.stringify(plan(step('role_delete', { role: roleId }))); } });
  assert.equal(await handler(f.message), true);
  assert.deepEqual(f.calls, [['delete']]);
  assert.match(f.edits.at(-1).content, /done/);
});
for (const mode of ['cancel', 'timeout', 'revoke']) test(`${mode} prevents execution`, async () => {
  const f = previewFixture(mode);
  const handler = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => JSON.stringify(plan(step('role_delete', { role: roleId }))) });
  await handler(f.message); assert.equal(f.calls.length, 0);
});
test('ordinary discussion can fall through to chat without performing actions', async () => {
  const f = fixture();
  f.message.content = 'Could you explain how to add a role?';
  const handler = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => '{"actions":[],"chat":true}' });
  assert.equal(await handler(f.message), false);
});
test('disabled actions never contact planner', async () => {
  const f = fixture();
  const handler = createActionHandler({ allowedUserIds: new Set([actorId]), enabled: false, completeAI: async () => { throw new Error('unexpected'); } });
  assert.equal(await handler(f.message), false);
});

test('pin requires dedicated PinMessages permission, not just ManageMessages', async () => {
  const f = fixture();
  f.actor.permissions = new PermissionsBitField([P.ManageMessages, P.ReadMessageHistory, P.ViewChannel]);
  await assert.rejects(executeStep(f.message, step('message_pin', { channel: channelId, message: '123456789012345678' })), /Missing PinMessages/);
});

import { parseCommandUserIds, canRunCommands } from '../src/command-auth.js';
test('command allowlist accepts only exact valid IDs and fails closed when empty', () => {
  const ids = parseCommandUserIds(`${actorId}, ${targetId}`);
  assert.equal(canRunCommands(actorId, ids), true);
  assert.equal(canRunCommands(botId, ids), false);
  assert.equal(canRunCommands(actorId, parseCommandUserIds('')), false);
  assert.throws(() => parseCommandUserIds('YOUR_DISCORD_USER_ID'), /COMMAND_USER_IDS/);
});
test('only delete and purge operations require approval; removal, bans and kicks are immediate', () => {
  for (const action of ['role_delete', 'channel_delete', 'message_delete', 'message_purge']) assert.equal(requiresDeleteConfirmation(plan(step(action, {}))), true);
  for (const action of ['role_remove', 'role_add', 'member_ban', 'member_kick', 'member_timeout', 'server_rename']) assert.equal(requiresDeleteConfirmation(plan(step(action, {}))), false);
  assert.equal(requiresDeleteConfirmation(plan(step('role_add', {}), step('channel_delete', {}))), true);
});
for (const operation of [step('server_rename', { name: 'Night City' }), step('role_add', { role: roleId, user: targetId }), step('member_ban', { user: targetId })]) test(`${operation.action} executes immediately without files, buttons or a collector`, async () => {
  const f = fixture(); const replies = [];
  if (operation.args.user) f.message.content = `Hey Capri ${operation.action === 'member_ban' ? 'ban' : 'add role to'} <@${targetId}>`;
  f.message.reply = async data => { assert.equal(data.components, undefined); assert.equal(data.files, undefined); replies.push(data); return {}; };
  const handle = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => JSON.stringify(plan(operation)) });
  assert.equal(await handle(f.message), true);
  assert.equal(f.calls.length, 1);
  assert.equal(replies.length, 1);
});
for (const ids of [new Set(), new Set([targetId])]) test('unlisted users are denied before action planning', async () => {
  const f = fixture(); const replies = [];
  f.message.reply = async data => { assert.equal(data.components, undefined); replies.push(data); return {}; };
  const handle = createActionHandler({ allowedUserIds: ids, completeAI: async () => { throw new Error('planner must not run'); } });
  await handle(f.message);
  assert.equal(f.calls.length, 0);
  assert.match(replies[0].content, /COMMAND_USER_IDS/);
});
test('unlisted direct action requests cannot fall through to ordinary chat', async () => {
  const f = fixture(); const replies = [];
  f.message.content = 'Bet, running it again—add sprite to brochacho.';
  f.message.reply = async data => { replies.push(data); return {}; };
  const handle = createActionHandler({
    allowedUserIds: new Set([targetId]),
    completeAI: async () => { throw new Error('planner must not run'); },
  });
  assert.equal(await handle(f.message), true);
  assert.match(replies[0].content, /COMMAND_USER_IDS/);
  assert.equal(f.calls.length, 0);
});
test('allowlisted user commands without an explicit bot address execute immediately', async () => {
  const f = fixture(); const replies = [];
  f.message.content = 'Could you rename the server to Night City?';
  f.message.reply = async data => { replies.push(data); return {}; };
  const handle = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => JSON.stringify(plan(step('server_rename', { name: 'Night City' }))) });
  assert.equal(await handle(f.message), true);
  assert.deepEqual(f.calls, [['rename', 'Night City']]);
  assert.equal(replies.length, 1);
});
test('create-and-assign role plans execute immediately without confirmation', async () => {
  const f = fixture(); const replies = [];
  f.message.content = `Hey Capri add poker to <@${targetId}>`;
  f.message.reply = async data => { assert.equal(data.components, undefined); assert.equal(data.files, undefined); replies.push(data); return {}; };
  const handle = createActionHandler({
    allowedUserIds: new Set([actorId]),
    completeAI: async () => JSON.stringify(plan(
      step('role_create', { name: 'poker' }),
      step('role_add', { role: '$last_role', user: targetId }),
    )),
  });
  assert.equal(await handle(f.message), true);
  assert.deepEqual(f.calls.map(call => call[0]), ['create', 'role_add']);
  assert.equal(replies.length, 1);
});
test('casually prefaced role assignments still execute immediately', async () => {
  const f = fixture(); const replies = [];
  f.message.content = 'Bet, running it again—add sprite to brochacho.';
  f.target.displayName = 'brochacho';
  f.target.user = { username: 'brochacho' };
  f.guild.members.cache = new Collection([[targetId, f.target]]);
  f.message.reply = async data => { assert.equal(data.components, undefined); assert.equal(data.files, undefined); replies.push(data); return {}; };
  const handle = createActionHandler({
    allowedUserIds: new Set([actorId]),
    completeAI: async () => JSON.stringify(plan(step('role_add', { role: roleId, user: 'brochacho' }))),
  });
  assert.equal(await handle(f.message), true);
  assert.deepEqual(f.calls.map(call => call[0]), ['role_add']);
  assert.equal(replies.length, 1);
});
test('a planner chat fallback cannot claim a direct action is waiting for confirmation', async () => {
  const f = fixture(); const replies = [];
  f.message.content = 'Bet, running it again—add sprite to brochacho.';
  f.message.reply = async data => { assert.equal(data.components, undefined); assert.equal(data.files, undefined); replies.push(data); return {}; };
  const handle = createActionHandler({
    allowedUserIds: new Set([actorId]),
    completeAI: async () => '{"actions":[],"chat":true}',
  });
  assert.equal(await handle(f.message), true);
  assert.match(replies[0].content, /couldn’t translate that direct request/);
  assert.doesNotMatch(replies[0].content, /Run these actions/);
  assert.equal(f.calls.length, 0);
});
test('planner output with trailing chatter still executes its valid JSON plan', async () => {
  const f = fixture();
  f.message.reply = async () => ({});
  const response = `${JSON.stringify(plan(step('server_rename', { name: 'Night City' })))}\nI have prepared that for you.`;
  const handle = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => response });
  assert.equal(await handle(f.message), true);
  assert.deepEqual(f.calls, [['rename', 'Night City']]);
});
test('records action requests and results so later chat can follow up', async () => {
  const f = fixture(); const history = [];
  f.message.reply = async () => ({});
  const handle = createActionHandler({
    allowedUserIds: new Set([actorId]),
    completeAI: async () => JSON.stringify(plan(step('server_rename', { name: 'Night City' }))),
    onRequest: message => history.push(['user', message.content]),
    onReply: (message, content) => history.push(['assistant', content]),
  });
  await handle(f.message);
  assert.equal(history.length, 2);
  assert.equal(history[0][0], 'user');
  assert.equal(history[0][1], f.message.content);
  assert.equal(history[1][0], 'assistant');
  assert.match(history[1][1], /Night City/);
});
test('unlisted users still get ordinary chat even when a message mentions server or role', async () => {
  const f = fixture();
  f.message.content = 'Hey Capri, should we change the server name? That role is odd.';
  const handle = createActionHandler({ allowedUserIds: new Set(), completeAI: async () => '{"actions":[],"chat":true}' });
  assert.equal(await handle(f.message), false);
});
test('mixed deletion plan executes nothing until approved', async () => {
  const f = previewFixture('cancel');
  const handle = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => JSON.stringify(plan(step('server_rename', { name: 'X' }), step('role_delete', { role: roleId }))) });
  await handle(f.message);
  assert.equal(f.calls.length, 0);
});
test('completed immediate commands do not impose a five-second cooldown', async () => {
  const f = fixture(); f.message.reply = async () => ({});
  const handle = createActionHandler({ allowedUserIds: new Set([actorId]), completeAI: async () => JSON.stringify(plan(step('server_rename', { name: 'X' }))) });
  await handle(f.message); await handle(f.message);
  assert.equal(f.calls.length, 2);
});
for (const cancel of [false, true]) test(`memory deletion helper ${cancel ? 'cancels' : 'approves'} only for requester`, async () => {
  const result = await confirmDeletion(async data => ({
    edit: async () => {},
    awaitMessageComponent: async ({ filter }) => {
      const click = { user: { id: actorId }, customId: data.components[0].components[cancel ? 1 : 0].data.custom_id, deferUpdate: async () => {} };
      assert.equal(filter({ ...click, user: { id: targetId } }), false);
      assert.equal(filter(click), true);
      return click;
    },
  }), actorId, 'Delete test memories?');
  assert.equal(result, !cancel);
});
