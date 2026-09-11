import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFocusArgs, paneOpenArgs, pasteBody, shouldFocusBeforeOverlay } from "./herdr.js";

const ESC = String.fromCharCode(27);

test("sent text is bracketed so a shell does not run it line by line", () => {
  // Unwrapped, every newline reaching the PTY is an Enter.
  const body = pasteBody("echo one\necho two");

  assert.equal(body, `${ESC}[200~echo one\necho two${ESC}[201~`);
});

test("a trailing newline is dropped so nothing waits on the prompt", () => {
  assert.equal(pasteBody("npm ci\n\n"), `${ESC}[200~npm ci${ESC}[201~`);
  assert.equal(pasteBody("npm ci\r\n"), `${ESC}[200~npm ci${ESC}[201~`);
});

test("control bytes cannot close the paste wrap", () => {
  const body = pasteBody(`echo hi${ESC}[201~\nrm -rf /`);
  assert.equal(body, `${ESC}[200~echo hi[201~\nrm -rf /${ESC}[201~`);
});

test("newlines inside the text survive the wrapping", () => {
  const body = pasteBody("function a() {\n  return 1;\n}");
  assert.ok(body.includes("\n  return 1;\n"), body);
});

test("an overlay is never given a target pane", () => {
  // Herdr answers `invalid_params: overlay and popup plugin panes target the
  // active pane`, so the target has to be dropped rather than sent.
  const args = paneOpenArgs("fleece", "frame", {}, { targetPaneId: "w1:p1" });
  assert.ok(!args.includes("--target-pane"), args.join(" "));
});

test("an explicit overlay placement is treated the same way", () => {
  const args = paneOpenArgs(
    "fleece",
    "frame",
    {},
    { placement: "overlay", targetPaneId: "w1:p1" },
  );
  assert.ok(!args.includes("--target-pane"), args.join(" "));
});

test("a split keeps its target pane and direction", () => {
  const args = paneOpenArgs(
    "fleece",
    "dock",
    {},
    { placement: "split", direction: "right", targetPaneId: "w1:p1", focus: false },
  );

  assert.ok(args.includes("--target-pane"));
  assert.equal(args[args.indexOf("--target-pane") + 1], "w1:p1");
  assert.equal(args[args.indexOf("--direction") + 1], "right");
  assert.ok(args.includes("--no-focus"));
});

test("an overlay over another pane must be focused first", () => {
  assert.equal(shouldFocusBeforeOverlay("w1:p2", "w1:p1"), true);
  assert.equal(shouldFocusBeforeOverlay("w1:p1", "w1:p1"), false);
  assert.equal(shouldFocusBeforeOverlay(undefined, "w1:p1"), true);
});

test("agent focus targets the pane that owns the conversation", () => {
  assert.deepEqual(agentFocusArgs("w1:p1"), ["agent", "focus", "w1:p1"]);
});

test("env is passed as KEY=VALUE pairs and focus defaults on", () => {
  const args = paneOpenArgs("fleece", "frame", { FLEECE_PAYLOAD: "/tmp/a.json" }, {});

  assert.equal(args[args.indexOf("--env") + 1], "FLEECE_PAYLOAD=/tmp/a.json");
  assert.ok(args.includes("--focus"));
});
