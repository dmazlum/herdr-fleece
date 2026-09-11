import assert from "node:assert/strict";
import { test } from "node:test";
import type { Turn } from "./transcript/types.js";
import { answers, stepPin, windowLabel, windowOf } from "./window.js";

function turn(index: number, text = `answer ${index}`): Turn {
  return {
    index,
    prompt: "p",
    text,
    thinking: "",
    toolUses: [],
    files: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  };
}

/** Turn 3 was asked but never answered, so it is not a stop on the way back. */
const session = [turn(1), turn(2), turn(3, ""), turn(4), turn(5)];

test("an unanswered prompt is not part of the session to page through", () => {
  assert.deepEqual(
    answers(session).map((entry) => entry.index),
    [1, 2, 4, 5],
  );
});

test("a live window is the whole session", () => {
  assert.equal(windowOf(session, null).length, 4);
  assert.equal(windowLabel(session, null, 3), "last 3 turns");
});

test("stepping back pins the answer before the newest, skipping unanswered ones", () => {
  const first = stepPin(session, null, -1);
  assert.equal(first.pinned, 4);

  const second = stepPin(session, first.pinned, -1);
  assert.equal(second.pinned, 2, "turn 3 has no answer to show");
});

test("a pinned window ends at the pin and says how far back it is", () => {
  const window = windowOf(session, 2);

  assert.deepEqual(
    window.map((entry) => entry.index),
    [1, 2],
  );
  assert.equal(windowLabel(session, 2, 3), "turn 2 · 2 back");
});

test("the label names the newest answer shown, not the span of turns", () => {
  // Turn 3 has no answer, so "turns 2–4" would claim three answers where the
  // window holds two.
  assert.equal(windowLabel(session, 4, 2), "turn 4 · 1 back");
  assert.equal(windowLabel([turn(1)], null, 3), "last 1 turn");
});

test("stepping forward onto the newest answer goes live again", () => {
  // Otherwise the dock would stay pinned to a turn that is no longer the end.
  assert.deepEqual(stepPin(session, 4, 1), { pinned: null });
});

test("the ends of the session are refused rather than clamped silently", () => {
  assert.equal(stepPin(session, 1, -1).blocked, "oldest answer");
  assert.equal(stepPin(session, 1, -1).pinned, 1);
  assert.equal(stepPin(session, null, 1).blocked, "newest answer");
  assert.equal(stepPin([], null, -1).blocked, "no answers yet");
});

test("a new answer does not move a pinned window", () => {
  // This is the whole reason the pin is an index and not a distance.
  const before = windowOf(session, 2);
  const after = windowOf([...session, turn(6)], 2);

  assert.deepEqual(
    after.map((entry) => entry.index),
    before.map((entry) => entry.index),
  );
  assert.equal(windowLabel([...session, turn(6)], 2, 3), "turn 2 · 3 back");
});

test("a pin that no longer resolves falls back to live", () => {
  assert.equal(windowOf(session, 99).length, 4);
});
