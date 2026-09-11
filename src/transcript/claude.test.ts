import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanPrompt,
  parseClaudeTranscript,
  readTurns,
  readTurnsGrowing,
  TranscriptWatch,
} from "./claude.js";

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

const prompt = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: "2026-09-11T10:00:00.000Z",
  gitBranch: "master",
  cwd: "/tmp/project",
  version: "2.0.0",
  message: { role: "user", content: text },
  ...extra,
});

const answer = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: "2026-09-11T10:00:30.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-5",
    content: blocks,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
  },
  ...extra,
});

test("pairs a prompt with the answer it produced", () => {
  const turns = parseClaudeTranscript(
    jsonl(prompt("add a migration"), answer([{ type: "text", text: "Done." }])),
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.index, 1);
  assert.equal(turns[0]!.prompt, "add a migration");
  assert.equal(turns[0]!.text, "Done.");
  assert.equal(turns[0]!.model, "claude-opus-5");
  assert.equal(turns[0]!.gitBranch, "master");
  assert.equal(turns[0]!.durationMs, 30_000);
});

test("a tool result does not start a new turn", () => {
  const toolResult = {
    type: "user",
    timestamp: "2026-09-11T10:00:10.000Z",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  };

  const turns = parseClaudeTranscript(
    jsonl(
      prompt("run the tests"),
      answer([{ type: "tool_use", name: "Bash" }]),
      toolResult,
      answer([{ type: "text", text: "All green." }]),
    ),
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.text, "All green.");
});

test("subagent traffic is left out", () => {
  const turns = parseClaudeTranscript(
    jsonl(
      prompt("investigate"),
      answer([{ type: "text", text: "sub" }], { isSidechain: true }),
      answer([{ type: "text", text: "main" }]),
    ),
  );

  assert.equal(turns[0]!.text, "main");
});

test("separates thinking and tallies tool use", () => {
  const turns = parseClaudeTranscript(
    jsonl(
      prompt("refactor"),
      answer([
        { type: "thinking", thinking: "weighing options" },
        { type: "tool_use", name: "Read" },
        { type: "tool_use", name: "Read" },
        { type: "tool_use", name: "Edit" },
        { type: "text", text: "Refactored." },
      ]),
    ),
  );

  assert.equal(turns[0]!.text, "Refactored.");
  assert.equal(turns[0]!.thinking, "weighing options");
  assert.deepEqual(turns[0]!.toolUses, [
    { name: "Read", count: 2 },
    { name: "Edit", count: 1 },
  ]);
});

test("records the files the agent wrote to, busiest first", () => {
  const turns = parseClaudeTranscript(
    jsonl(
      prompt("fix the dock"),
      answer([
        { type: "tool_use", name: "Read", input: { file_path: "/repo/README.md" } },
        { type: "tool_use", name: "Write", input: { file_path: "/repo/src/b.ts" } },
        { type: "tool_use", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
        { type: "tool_use", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
        { type: "text", text: "Done." },
      ]),
    ),
  );

  // Read is absent on purpose: looking at a file is research, not a result.
  assert.deepEqual(turns[0]!.files, [
    { path: "/repo/src/a.ts", edits: 2 },
    { path: "/repo/src/b.ts", edits: 1 },
  ]);
});

test("a tool call without a path records no file", () => {
  const turns = parseClaudeTranscript(
    jsonl(
      prompt("go"),
      answer([
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", name: "Write", input: {} },
        { type: "tool_use", name: "Edit" },
        { type: "text", text: "ok" },
      ]),
    ),
  );

  assert.deepEqual(turns[0]!.files, []);
  assert.equal(turns[0]!.toolUses.length, 3);
});

test("a notebook edit is recorded under its own path field", () => {
  const turns = parseClaudeTranscript(
    jsonl(
      prompt("go"),
      answer([
        { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/repo/a.ipynb" } },
        { type: "text", text: "ok" },
      ]),
    ),
  );

  assert.deepEqual(turns[0]!.files, [{ path: "/repo/a.ipynb", edits: 1 }]);
});

test("sums usage across every assistant message in a turn", () => {
  const turns = parseClaudeTranscript(
    jsonl(
      prompt("go"),
      answer([{ type: "text", text: "one" }]),
      answer([{ type: "text", text: "two" }]),
    ),
  );

  assert.equal(turns[0]!.text, "one\n\ntwo");
  assert.equal(turns[0]!.usage.input, 200);
  assert.equal(turns[0]!.usage.output, 40);
  assert.equal(turns[0]!.usage.cacheRead, 1800);
});

test("numbers turns in order and skips unknown record types", () => {
  const turns = parseClaudeTranscript(
    jsonl(
      { type: "attachment", content: "noise" },
      prompt("first"),
      answer([{ type: "text", text: "1" }]),
      { type: "ai-title", title: "noise" },
      prompt("second"),
      answer([{ type: "text", text: "2" }]),
    ),
  );

  assert.deepEqual(
    turns.map((turn) => [turn.index, turn.prompt, turn.text]),
    [
      [1, "first", "1"],
      [2, "second", "2"],
    ],
  );
});

test("tolerates a truncated trailing line from a live session", () => {
  const turns = parseClaudeTranscript(
    `${jsonl(prompt("go"), answer([{ type: "text", text: "ok" }]))}\n{"type":"assist`,
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.text, "ok");
});

test("meta records are not prompts", () => {
  const turns = parseClaudeTranscript(
    jsonl(prompt("real"), answer([{ type: "text", text: "a" }]), prompt("meta", { isMeta: true })),
  );

  assert.equal(turns.length, 1);
});

test("cleanPrompt strips harness scaffolding", () => {
  const raw =
    "<system-reminder>ignore me</system-reminder>\n<command-name>clear</command-name>\nreal question";
  assert.equal(cleanPrompt(raw), "/clear\nreal question");
});

test("a growing transcript is parsed from the new bytes only", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleece-transcript-"));
  const path = join(dir, "session.jsonl");
  const first = jsonl(prompt("first"), answer([{ type: "text", text: "1" }]));
  writeFileSync(path, `${first}\n`);

  const once = readTurnsGrowing(path);
  assert.equal(once.turns.length, 1);
  assert.equal(once.turns[0]!.text, "1");
  const firstOffset = once.cursor.offset;

  const second = jsonl(prompt("second"), answer([{ type: "text", text: "2" }]));
  appendFileSync(path, `${second}\n`);

  const twice = readTurnsGrowing(path, once.cursor);
  assert.deepEqual(
    twice.turns.map((turn) => [turn.index, turn.text]),
    [
      [1, "1"],
      [2, "2"],
    ],
  );
  assert.ok(twice.cursor.offset > firstOffset);

  rmSync(dir, { recursive: true, force: true });
});

test("TranscriptWatch starts over when the file is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleece-transcript-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${jsonl(prompt("old"), answer([{ type: "text", text: "old" }]))}\n`);

  const watch = new TranscriptWatch();
  assert.equal(watch.read(path)[0]!.text, "old");

  writeFileSync(path, `${jsonl(prompt("new"), answer([{ type: "text", text: "new" }]))}\n`);
  assert.equal(watch.read(path)[0]!.text, "new");

  rmSync(dir, { recursive: true, force: true });
});

test("a later assistant record does not change how the turn is joined", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleece-transcript-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${jsonl(prompt("go"), answer([{ type: "text", text: "Part 1" }]))}\n`);

  const once = readTurnsGrowing(path);
  appendFileSync(path, `${JSON.stringify(answer([{ type: "text", text: "Part 2" }]))}\n`);
  const twice = readTurnsGrowing(path, once.cursor);

  writeFileSync(path, `${jsonl(prompt("go"), answer([{ type: "text", text: "Part 1" }]), answer([{ type: "text", text: "Part 2" }]))}\n`);
  assert.equal(twice.turns[0]!.text, readTurns(path)[0]!.text);

  rmSync(dir, { recursive: true, force: true });
});

test("readTurns keeps a last record that has no trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleece-transcript-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, jsonl(prompt("go"), answer([{ type: "text", text: "Done." }])));

  assert.equal(readTurns(path)[0]!.text, "Done.");

  rmSync(dir, { recursive: true, force: true });
});
