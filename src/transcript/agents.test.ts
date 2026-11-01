import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  agentTranscripts,
  AgentTranscriptWatch,
  describeTranscript,
  guessTranscript,
  locateTranscript,
  missingTranscript,
  readTargetTurns,
  TranscriptError,
} from "./agents.js";

/** Points CLAUDE_CONFIG_DIR at a scratch tree for one test. */
function withClaudeHome(run: (projects: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "fleece-agents-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const projects = join(home, "projects");
    mkdirSync(projects);
    run(projects);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const prompt = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const reply = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

test("agents: lookup is by Herdr's agent name", () => {
  assert.equal(agentTranscripts("claude")?.label, "Claude Code");
  assert.equal(agentTranscripts("aider"), undefined);
  assert.equal(agentTranscripts(undefined), undefined);
});

test("agents: an unknown agent is named in the message, a known one gets its home", () => {
  assert.match(
    missingTranscript({ paneId: "p", agent: "aider" }),
    /^agent "aider" is not supported yet — Fleece reads Claude Code/,
  );
  withClaudeHome((projects) => {
    assert.equal(
      missingTranscript({ paneId: "p", agent: "claude", sessionId: "s1" }),
      `no Claude Code transcript for session s1 under ${projects}`,
    );
  });
});

test("agents: a session id locates and reads the transcript", () => {
  withClaudeHome((projects) => {
    const dir = join(projects, "-work-app");
    mkdirSync(dir);
    const path = join(dir, "s1.jsonl");
    writeFileSync(path, `${prompt("hi")}\n${reply("hello")}\n`);

    const target = { paneId: "p", agent: "claude", sessionId: "s1", cwd: "/work/app" };
    assert.equal(locateTranscript(target), path);
    assert.equal(locateTranscript({ ...target, sessionId: undefined }), undefined);

    const turns = readTargetTurns({ ...target, transcriptPath: path });
    assert.deepEqual(
      turns.map((turn) => [turn.prompt, turn.text]),
      [["hi", "hello"]],
    );
  });
});

test("agents: reading without a transcript or for an unknown agent throws a TranscriptError", () => {
  assert.throws(() => readTargetTurns({ paneId: "p", agent: "claude" }), TranscriptError);
  assert.throws(() => readTargetTurns({ paneId: "p", agent: "aider", transcriptPath: "/x" }), TranscriptError);
  assert.throws(() => new AgentTranscriptWatch().read("aider", "/x"), TranscriptError);
});

test("agents: a guess takes the folder's newest transcript and is marked as one", () => {
  withClaudeHome((projects) => {
    const dir = join(projects, "-work-app");
    mkdirSync(dir);
    writeFileSync(join(dir, "s9.jsonl"), `${prompt("hi")}\n`);

    const target: Parameters<typeof guessTranscript>[0] = { paneId: "p", agent: "claude", cwd: "/work/app" };
    guessTranscript(target);
    assert.equal(target.transcriptPath, join(dir, "s9.jsonl"));
    assert.equal(target.sessionId, "s9");
    assert.equal(target.guessed, true);
    assert.equal(describeTranscript(target), `${join(dir, "s9.jsonl")} (guessed from folder)`);

    const nowhere: Parameters<typeof guessTranscript>[0] = { paneId: "p", agent: "claude", cwd: "/nowhere" };
    guessTranscript(nowhere);
    assert.equal(nowhere.transcriptPath, undefined);
    assert.equal(describeTranscript(nowhere), "(not found)");
  });
});
