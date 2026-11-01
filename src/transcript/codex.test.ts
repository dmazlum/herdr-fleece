import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseTranscript, readTurnsGrowing, TranscriptWatch } from "./reader.js";
import { answerText, codexParser } from "./codex.js";

const parseCodexTranscript = (source: string) => parseTranscript(source, codexParser);
const readCodexTurns = (path: string) => readTurnsGrowing(path, codexParser).turns;

/**
 * Records follow the shapes Codex 0.166 writes (`item_completed` items,
 * `phase` on assistant messages) and the older ones (`user_message`,
 * `apply_patch` calls, no phase). Values are invented.
 */

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 1, 10, 0, clock++)).toISOString();

const meta = (extra: Record<string, unknown> = {}) => ({
  timestamp: at(),
  type: "session_meta",
  payload: {
    id: "0001",
    session_id: "0001",
    cwd: "/work/app",
    cli_version: "0.166.0",
    source: "cli",
    git: { branch: "main" },
    ...extra,
  },
});

const context = (model = "gpt-6.1-sol", cwd = "/work/app") => ({
  timestamp: at(),
  type: "turn_context",
  payload: { turn_id: "t", cwd, model },
});

const event = (payload: Record<string, unknown>) => ({ timestamp: at(), type: "event_msg", payload });
const item = (payload: Record<string, unknown>) => ({ timestamp: at(), type: "response_item", payload });

const userItem = (text: string) =>
  event({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text }] } });

/** What the model sees as the user's message: harness context plus the prompt. */
const modelUser = (text: string) =>
  item({ type: "message", role: "user", content: [{ type: "input_text", text }] });

const say = (text: string, phase?: string) =>
  item({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
    ...(phase ? { phase } : {}),
  });

const tokens = (input: number, cached: number, output: number) =>
  event({
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    },
  });

const fileChange = (changes: Record<string, unknown>) =>
  event({ type: "item_completed", item: { type: "FileChange", changes, status: "completed" } });

test("codex: the answer is the final message, not the commentary between tool calls", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      context(),
      modelUser("# AGENTS.md instructions\n\n<INSTRUCTIONS>…</INSTRUCTIONS>"),
      modelUser("<environment_context><cwd>/work/app</cwd></environment_context>"),
      modelUser("Fix the build"),
      userItem("Fix the build\n"),
      say("I'll look at the build first.", "commentary"),
      item({ type: "custom_tool_call", name: "exec", input: "…" }),
      say("The build passes now.", "final_answer"),
      event({ type: "task_complete", last_agent_message: "The build passes now.", duration_ms: 4200 }),
    ),
  );

  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn!.prompt, "Fix the build");
  assert.equal(turn!.text, "The build passes now.");
  assert.equal(turn!.durationMs, 4200);
  assert.equal(turn!.model, "gpt-6.1-sol");
  assert.equal(turn!.cwd, "/work/app");
  assert.equal(turn!.gitBranch, "main");
  assert.equal(turn!.agentVersion, "0.166.0");
  assert.deepEqual(turn!.toolUses, [{ name: "exec", count: 1 }]);
});

test("codex: a turn with only commentary so far has no answer yet", () => {
  const turns = parseCodexTranscript(
    jsonl(meta(), userItem("Refactor it"), say("Reading the module.", "commentary")),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.text, "");
});

test("codex: each prompt opens a turn, and the model's copy of it is not a second prompt", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      context("gpt-a"),
      userItem("one"),
      say("first", "final_answer"),
      context("gpt-b"),
      modelUser("two"),
      userItem("two"),
      say("second", "final_answer"),
    ),
  );
  assert.deepEqual(
    turns.map((turn) => [turn.index, turn.prompt, turn.text, turn.model]),
    [
      [1, "one", "first", "gpt-a"],
      [2, "two", "second", "gpt-b"],
    ],
  );
});

test("codex: older builds — user_message events, no phase, last message wins", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta({ cli_version: "0.40.0", source: undefined }),
      event({ type: "user_message", message: "<user_instructions>x</user_instructions>", kind: "user_instructions" }),
      event({ type: "user_message", message: "Add a test", kind: "plain" }),
      say("Let me check the suite."),
      item({ type: "function_call", name: "shell", arguments: '{"command":["ls"]}' }),
      say("Added `test/a.test.ts`."),
      event({ type: "agent_message", message: "Added `test/a.test.ts`." }),
    ),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.prompt, "Add a test");
  assert.equal(turns[0]!.text, "Added `test/a.test.ts`.");
});

test("codex: the same prompt reported by two event kinds opens one turn", () => {
  const turns = parseCodexTranscript(
    jsonl(meta(), event({ type: "user_message", message: "hi" }), userItem("hi"), say("hello", "final_answer")),
  );
  assert.equal(turns.length, 1);
});

test("codex: task_complete supplies the answer when no message was recorded", () => {
  assert.equal(answerText([], "from task_complete"), "from task_complete");
  assert.equal(answerText([{ text: "own" }], "from task_complete"), "own");
});

test("codex: a subagent rollout is not the user's conversation", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta({ source: { subagent: { other: "guardian" } } }),
      userItem("judge this action"),
      say("{\"outcome\":\"allow\"}", "final_answer"),
    ),
  );
  assert.deepEqual(turns, []);
});

test("codex: files come from FileChange items, moves land on the new path, deletes are left out", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      userItem("edit"),
      fileChange({ "/work/app/a.ts": { type: "update", unified_diff: "@@", move_path: null } }),
      fileChange({
        "/work/app/a.ts": { type: "update", unified_diff: "@@", move_path: null },
        "/work/app/new.ts": { type: "add", content: "x" },
      }),
      fileChange({ "/work/app/old.ts": { type: "update", unified_diff: "@@", move_path: "/work/app/moved.ts" } }),
      fileChange({ "/work/app/gone.ts": { type: "delete", content: "x" } }),
      say("done", "final_answer"),
    ),
  );
  assert.deepEqual(turns[0]!.files, [
    { path: "/work/app/a.ts", edits: 2 },
    { path: "/work/app/new.ts", edits: 1 },
    { path: "/work/app/moved.ts", edits: 1 },
  ]);
});

test("codex: without FileChange items, apply_patch text supplies the files, resolved against cwd", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+export {};",
    "*** Update File: /abs/kept.ts",
    "@@",
    "*** Update File: src/old.ts",
    "*** Move to: src/renamed.ts",
    "*** Delete File: src/gone.ts",
    "*** End Patch",
  ].join("\n");
  const turns = parseCodexTranscript(
    jsonl(
      meta({ cwd: "/work/app" }),
      userItem("patch"),
      item({ type: "custom_tool_call", name: "apply_patch", input: patch }),
      item({ type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: "*** Update File: src/new.ts\n" }) }),
      say("patched", "final_answer"),
    ),
  );
  assert.deepEqual(turns[0]!.files, [
    { path: "/work/app/src/new.ts", edits: 2 },
    { path: "/abs/kept.ts", edits: 1 },
    { path: "/work/app/src/renamed.ts", edits: 1 },
  ]);
});

test("codex: FileChange items win over apply_patch text so a patch is not counted twice", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      userItem("patch"),
      item({ type: "custom_tool_call", name: "apply_patch", input: "*** Update File: a.ts\n" }),
      fileChange({ "/work/app/a.ts": { type: "update" } }),
    ),
  );
  assert.deepEqual(turns[0]!.files, [{ path: "/work/app/a.ts", edits: 1 }]);
});

test("codex: usage is the turn's growth in running totals, cache split out of input", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      tokens(100, 40, 10), // before any prompt: earlier context, not this turn's
      userItem("one"),
      tokens(1100, 640, 60),
      tokens(1100, 640, 60), // written twice; totals do not double count
      say("a", "final_answer"),
      userItem("two"),
      tokens(1600, 1040, 90),
    ),
  );
  assert.deepEqual(turns[0]!.usage, { input: 400, output: 50, cacheRead: 600, cacheCreation: 0 });
  assert.deepEqual(turns[1]!.usage, { input: 100, output: 30, cacheRead: 400, cacheCreation: 0 });
});

test("codex: reasoning summaries become thinking; encrypted content is ignored", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      userItem("why"),
      item({ type: "reasoning", summary: [], encrypted_content: "gAAAA" }),
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "**Plan**\n\nCheck it." }] }),
      say("because", "final_answer"),
    ),
  );
  assert.equal(turns[0]!.thinking, "**Plan**\n\nCheck it.");
});

test("codex: unknown records and non-object lines are skipped", () => {
  const turns = parseCodexTranscript(
    jsonl(meta(), { type: "world_state", payload: { full: true } }, null, [1], userItem("ok"), {
      type: "compacted",
      payload: { message: "…" },
    }),
  );
  assert.equal(turns.length, 1);
});

test("codex: a live rollout read incrementally matches a full read", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleece-codex-"));
  try {
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, jsonl(meta(), userItem("go"), say("working", "commentary")));
    const watch = new TranscriptWatch(codexParser);
    assert.equal(watch.read(path)[0]!.text, "");

    appendFileSync(path, jsonl(say("finished", "final_answer"), userItem("again")));
    const live = watch.read(path);
    assert.deepEqual(live, readCodexTurns(path));
    assert.deepEqual(
      live.map((turn) => [turn.prompt, turn.text]),
      [
        ["go", "finished"],
        ["again", ""],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: a failed or declined FileChange is not an edit", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      userItem("edit"),
      event({ type: "item_completed", item: { type: "FileChange", status: "failed", changes: { "/w/a.ts": { type: "update" } } } }),
      event({ type: "item_completed", item: { type: "FileChange", status: "declined", changes: { "/w/b.ts": { type: "update" } } } }),
      event({ type: "item_completed", item: { type: "FileChange", status: "completed", changes: { "/w/c.ts": { type: "update" } } } }),
      event({ type: "item_completed", item: { type: "FileChange", changes: { "/w/d.ts": { type: "update" } } } }),
    ),
  );
  assert.deepEqual(
    turns[0]!.files.map((file) => file.path),
    ["/w/c.ts", "/w/d.ts"],
  );
});

test("codex: an apply_patch call counts its files only once its output shows success", () => {
  const call = (id: string, file: string) =>
    item({ type: "custom_tool_call", name: "apply_patch", call_id: id, input: `*** Update File: ${file}\n` });
  const output = (id: string, text: string) => item({ type: "custom_tool_call_output", call_id: id, output: text });
  const legacy = (id: string, code: number) =>
    item({
      type: "function_call_output",
      call_id: id,
      output: JSON.stringify({ output: code === 0 ? "Success." : "boom", metadata: { exit_code: code } }),
    });

  const turns = parseCodexTranscript(
    jsonl(
      meta({ cwd: "/w" }),
      userItem("patch"),
      call("c1", "ok.ts"),
      output("c1", "Success. Updated the following files:\nM ok.ts"),
      call("c2", "bad.ts"),
      output("c2", "apply_patch verification failed: Failed to find expected lines in bad.ts"),
      call("c3", "legacy-ok.ts"),
      legacy("c3", 0),
      call("c4", "legacy-bad.ts"),
      legacy("c4", 1),
      call("c5", "pending.ts"), // still running: no output yet
    ),
  );
  assert.deepEqual(
    turns[0]!.files.map((file) => file.path),
    ["/w/ok.ts", "/w/legacy-ok.ts"],
  );
});

test("codex: endedAt is when the answer was written, and does not move after it", () => {
  const source = jsonl(
    meta(),
    userItem("go"),
    say("on it", "commentary"),
    { timestamp: "2026-11-01T10:05:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done" }] } },
  );
  const before = parseCodexTranscript(source)[0]!;
  const after = parseCodexTranscript(
    source +
      jsonl(
        { timestamp: "2026-11-01T10:05:03.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", changes: { "/w/late.ts": { type: "add" } } } } },
        { timestamp: "2026-11-01T10:05:04.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "done", duration_ms: 9000 } },
      ),
  )[0]!;
  assert.equal(before.endedAt, "2026-11-01T10:05:00.000Z");
  assert.equal(after.endedAt, before.endedAt);
  assert.equal(after.durationMs, 9000);
});

test("codex: a completed turn with only commentary takes its answer from task_complete", () => {
  const turns = parseCodexTranscript(
    jsonl(
      meta(),
      userItem("quick one"),
      say("Checked; nothing to change.", "commentary"),
      { timestamp: "2026-11-01T11:00:00.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Checked; nothing to change." } },
    ),
  );
  assert.equal(turns[0]!.text, "Checked; nothing to change.");
  assert.equal(turns[0]!.endedAt, "2026-11-01T11:00:00.000Z");
});
