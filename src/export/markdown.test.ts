import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_KEYS } from "../keys.js";
import type { FleeceConfig } from "../config.js";
import type { Target, Turn } from "../transcript/types.js";
import { buildMarkdown, fileName } from "./markdown.js";

const config: FleeceConfig = {
  exportDir: "/tmp",
  includePrompt: true,
  includeThinking: false,
  frontMatter: true,
  journal: false,
  dockTurns: 3,
  dockWidth: 46,
  keys: DEFAULT_KEYS,
  keyProblems: [],
};

const turn: Turn = {
  index: 7,
  prompt: "add the migration",
  promptAt: "2026-09-11T10:00:00.000Z",
  text: "## Done\n\nAdded it.",
  thinking: "weighing options",
  toolUses: [
    { name: "Edit", count: 10 },
    { name: "Bash", count: 3 },
  ],
  files: [{ path: "/repo/src/a.ts", edits: 10 }],
  model: "claude-opus-5",
  endedAt: "2026-09-11T10:01:00.000Z",
  usage: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
  gitBranch: "master",
  cwd: "/repo",
};

const target: Target = { paneId: "w1:p1", agent: "claude", sessionId: "abc", cwd: "/repo" };

test("an export never carries a tool-use footer", () => {
  // The export is a document; which tools ran is session metadata, not content.
  const out = buildMarkdown(turn, target, config);

  assert.ok(!out.includes("Tools:"), out);
  assert.ok(!out.includes("Edit ×10"), out);
  assert.ok(out.trimEnd().endsWith("Added it."), out);
});

test("front matter carries the session facts instead", () => {
  const out = buildMarkdown(turn, target, config);

  assert.match(out, /^---\n/);
  assert.match(out, /model: "claude-opus-5"/);
  assert.match(out, /turn: 7/);
  assert.match(out, /branch: "master"/);
  assert.match(out, /input_tokens: 100/);
});

test("the prompt is quoted above the answer when asked for", () => {
  assert.match(buildMarkdown(turn, target, config), /## Prompt\n\n> add the migration/);
  assert.ok(
    !buildMarkdown(turn, target, { ...config, includePrompt: false }).includes("## Prompt"),
  );
});

test("thinking is opt-in", () => {
  assert.ok(!buildMarkdown(turn, target, config).includes("weighing options"));
  assert.ok(
    buildMarkdown(turn, target, { ...config, includeThinking: true }).includes("weighing options"),
  );
});

test("front matter can be turned off entirely", () => {
  const out = buildMarkdown(turn, target, { ...config, frontMatter: false });
  assert.ok(!out.startsWith("---"), out);
});

test("the filename carries project, session, turn and local time", () => {
  assert.match(fileName(turn, target), /^repo-abc-turn07-\d{8}-\d{6}\.md$/);
});

test("two sessions in the same project do not share a filename", () => {
  const other = { ...target, sessionId: "other-session" };
  assert.notEqual(fileName(turn, target), fileName(turn, other));
});
