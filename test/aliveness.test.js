import test from "node:test";
import assert from "node:assert/strict";
import { ALIVENESS_BLOCK, buildCurrentState, renderAliveness } from "../src/aliveness.js";

test("aliveness block preserves the personality override and memory hook", () => {
  assert.match(ALIVENESS_BLOCK, /never WHO you are/);
  assert.match(ALIVENESS_BLOCK, /<right_now>/);
});

test("current state includes local time and elapsed speech", () => {
  const now = new Date("2026-10-31T03:12:00");
  const state = buildCurrentState(now, now.getTime() - 40 * 60_000);
  assert.match(state, /hasn't spoken in 40 min/);
  assert.match(state, /current mood:/);
});

test("renders an aliveness block with a concrete current state", () => {
  const rendered = renderAliveness(new Date("2026-10-31T03:12:00"), Date.now());
  assert.doesNotMatch(rendered, /\{\{CURRENT_STATE\}\}/);
});

import { deliverStreamedReply } from '../src/aliveness.js';

test('stream delivery waits for pending edits before final answer', async () => {
  const edits = [];
  let visible = '';
  const sent = { async edit(text) {
    if (text === 'partial') await new Promise(resolve => setTimeout(resolve, 25));
    visible = text;
    edits.push(text);
  }};
  const message = {
    channel: { async sendTyping() {} },
    async reply() { return sent; },
    async react() {},
  };
  const result = await deliverStreamedReply(message, async delta => {
    delta('partial');
    return 'This is the completed answer with enough words to avoid reactions.';
  });
  assert.equal(visible, result);
  assert.equal(edits.at(-1), result);
  assert.equal(edits[0], 'partial');
});

test('failed stream leaves fallback after pending edits settle', async () => {
  let visible = '';
  const sent = { async edit(text) {
    if (text === 'partial') await new Promise(resolve => setTimeout(resolve, 25));
    visible = text;
  }};
  const message = { channel: { async sendTyping() {} }, async reply() { return sent; } };
  const result = await deliverStreamedReply(message, async delta => {
    delta('partial');
    throw new Error('simulated failure');
  });
  assert.equal(result, '');
  assert.match(visible, /Please try again/);
});
