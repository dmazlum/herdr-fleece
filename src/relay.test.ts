import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaneAgent } from "./herdr.js";
import { MAX_TARGETS, relayPrompt, relayReceipt, relayTargets, targetForKey } from "./relay.js";

const pane = (id: string, extra: Partial<PaneAgent> = {}): PaneAgent => ({
  pane_id: id,
  agent: "claude",
  cwd: `/work/${id}`,
  tab_id: "t1",
  workspace_id: "w1",
  ...extra,
});

const from = { paneId: "src", tabId: "t1", workspaceId: "w1" };

test("relay: the followed agent, the dock and panes without an agent are not targets", () => {
  const targets = relayTargets(
    [pane("src"), pane("dock"), pane("shell", { agent: undefined }), pane("b", { agent: "codex" })],
    from,
    "dock",
  );
  assert.deepEqual(targets, [{ paneId: "b", label: "codex b" }]);
});

test("relay: nearest first — same tab, then same workspace, then the rest", () => {
  const targets = relayTargets(
    [
      pane("far", { tab_id: "t9", workspace_id: "w9" }),
      pane("ws", { tab_id: "t2" }),
      pane("tab"),
      pane("ws2", { tab_id: "t3" }),
    ],
    from,
    "",
  );
  assert.deepEqual(
    targets.map((target) => target.paneId),
    ["tab", "ws", "ws2", "far"],
  );
});

test("relay: a name beats the agent kind, and twins are told apart by pane id", () => {
  const targets = relayTargets(
    [
      pane("a", { name: "reviewer" }),
      pane("b", { cwd: "/work/api" }),
      pane("c", { cwd: "/other/api" }),
      pane("d", { cwd: undefined, foreground_cwd: undefined }),
    ],
    from,
    "",
  );
  assert.deepEqual(
    targets.map((target) => target.label),
    ["reviewer a", "claude api b", "claude api c", "claude"],
  );
});

test("relay: at most nine targets, picked by their number", () => {
  const many = Array.from({ length: 12 }, (_, index) => pane(`p${index}`));
  const targets = relayTargets(many, from, "");
  assert.equal(targets.length, MAX_TARGETS);
  assert.equal(targetForKey(targets, "1")?.paneId, "p0");
  assert.equal(targetForKey(targets, "9")?.paneId, "p8");
  assert.equal(targetForKey(targets, "0"), undefined);
  assert.equal(targetForKey(targets, "a"), undefined);
  assert.equal(targetForKey(targets.slice(0, 2), "3"), undefined);
});

test("relay: the prompt lists numbered targets, the receipt counts lines", () => {
  const targets = [
    { paneId: "b", label: "codex api" },
    { paneId: "c", label: "claude web" },
  ];
  assert.equal(relayPrompt("code", targets), "relay code → 1 codex api · 2 claude web · esc cancels");
  assert.equal(relayReceipt("answer", targets[0]!, "one\ntwo\nthree\n"), "relayed answer → codex api · 3 lines");
  assert.equal(relayReceipt("command", targets[1]!, "npm test"), "relayed command → claude web");
});
