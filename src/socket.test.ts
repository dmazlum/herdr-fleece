import assert from "node:assert/strict";
import { test } from "node:test";
import { eventData, eventKind, splitLines } from "./socket.js";

test("splitLines holds back an unterminated line", () => {
  const first = splitLines('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(first.rest, '{"c":');

  const second = splitLines(`${first.rest}3}\n`);
  assert.deepEqual(second.lines, ['{"c":3}']);
  assert.equal(second.rest, "");
});

test("splitLines drops blank lines", () => {
  assert.deepEqual(splitLines("\n\n{}\n").lines, ["{}"]);
});

test("eventKind normalises the dotted spelling to underscores", () => {
  assert.equal(
    eventKind({ event: "pane.agent_status_changed", data: {} }),
    "pane_agent_status_changed",
  );
  assert.equal(eventKind({ event: "pane_focused", data: {} }), "pane_focused");
});

test("eventKind falls back to the type inside data", () => {
  assert.equal(eventKind({ data: { type: "pane_closed" } }), "pane_closed");
});

test("eventKind is empty for anything unrecognisable", () => {
  assert.equal(eventKind({ result: { type: "subscription_started" } }), "");
  assert.equal(eventKind({}), "");
});

test("eventData returns the payload, or an empty object", () => {
  const payload = { pane_id: "w1:p1", agent_status: "idle" };
  assert.deepEqual(eventData({ event: "pane_agent_status_changed", data: payload }), payload);
  assert.deepEqual(eventData({ event: "pane_focused" }), {});
});
