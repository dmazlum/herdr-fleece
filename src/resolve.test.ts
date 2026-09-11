import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPaneOrThrow, ResolveError } from "./resolve.js";
import type { PaneAgent } from "./herdr.js";

const claude: PaneAgent = { pane_id: "w1:p1", agent: "claude" };
const shell: PaneAgent = { pane_id: "w1:p1" };

test("an explicit pane that resolved is the one that is used", () => {
  assert.equal(agentPaneOrThrow("w1:p1", claude, null).pane_id, "w1:p1");
});

test("a missing explicit pane does not fall back", () => {
  assert.throws(
    () => agentPaneOrThrow("w1:p9", null, null),
    (err: unknown) => err instanceof ResolveError && /was not found/.test(err.message),
  );
});

test("an explicit pane without an agent is refused", () => {
  assert.throws(
    () => agentPaneOrThrow("w1:p1", null, shell),
    (err: unknown) => err instanceof ResolveError && /has no agent/.test(err.message),
  );
});

test("an empty pane id is refused", () => {
  assert.throws(
    () => agentPaneOrThrow("", null, null),
    (err: unknown) => err instanceof ResolveError && /empty/.test(err.message),
  );
});
