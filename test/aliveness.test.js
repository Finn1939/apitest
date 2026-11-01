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
