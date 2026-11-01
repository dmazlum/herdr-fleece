import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentApp,
  isClaude,
  isCodex,
  sessionIdForPid,
  terminalAgent,
  terminalState,
  type CoreTerminal,
} from "./core.js";

const reported: CoreTerminal = {
  address: "t8",
  status: { app: "claude-code", state: "working" },
  foreground: { argv: ["claude"], pid: 21180 },
};

test("an agent is recognised by what it reported", () => {
  assert.equal(agentApp(reported), "claude-code");
  assert.equal(isClaude(reported), true);
});

test("a silent claude process is still recognised by its argv", () => {
  assert.equal(isClaude({ address: "t9", foreground: { argv: ["/usr/local/bin/claude"] } }), true);
});

test("a shell is not an agent", () => {
  const shell: CoreTerminal = { address: "t6", foreground: { argv: ["zsh"] }, status: "idle" };
  assert.equal(agentApp(shell), undefined);
  assert.equal(isClaude(shell), false);
});

test("the session id comes from Claude Code's per-pid file", () => {
  const read = (path: string) => {
    assert.match(path, /sessions\/21180\.json$/);
    return JSON.stringify({ pid: 21180, sessionId: "cf48157b" });
  };
  assert.equal(sessionIdForPid(21180, read), "cf48157b");
});

test("a missing or malformed session file gives no session", () => {
  assert.equal(
    sessionIdForPid(1, () => {
      throw new Error("ENOENT");
    }),
    undefined,
  );
  assert.equal(sessionIdForPid(1, () => "{not json"), undefined);
  assert.equal(sessionIdForPid(1, () => JSON.stringify({ sessionId: "" })), undefined);
});

test("codex is recognised by what it reported or by its argv", () => {
  assert.equal(terminalAgent({ address: "t1", status: { app: "codex" } }), "codex");
  assert.equal(terminalAgent({ address: "t2", foreground: { argv: ["/opt/homebrew/bin/codex"] } }), "codex");
  assert.equal(
    terminalAgent({ address: "t3", foreground: { argv: ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"] } }),
    "codex",
  );
  assert.equal(isCodex({ address: "t4", foreground: { argv: ["codexify"] } }), false);
});

test("a terminal's agent name matches the transcript registry", () => {
  assert.equal(terminalAgent(reported), "claude");
  assert.equal(terminalAgent({ address: "t5", status: { app: "aider" } }), "aider");
  assert.equal(terminalAgent({ address: "t6", foreground: { argv: ["zsh"] } }), "unknown");
});

test("a terminal's state comes from its status object or string", () => {
  assert.equal(terminalState(reported), "working");
  assert.equal(terminalState({ address: "t6", status: "idle" }), "idle");
  assert.equal(terminalState({ address: "t7" }), undefined);
});
