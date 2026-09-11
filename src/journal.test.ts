import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_KEYS } from "./keys.js";
import type { FleeceConfig } from "./config.js";
import { journalSummary, journalTurns, type JournalIO } from "./journal.js";
import type { Target, Turn } from "./transcript/types.js";

const config: FleeceConfig = {
  exportDir: "/exports",
  includePrompt: true,
  includeThinking: false,
  frontMatter: true,
  journal: true,
  dockTurns: 3,
  dockWidth: 46,
  keys: DEFAULT_KEYS,
  keyProblems: [],
};

const target: Target = { paneId: "w1:p1", agent: "claude", sessionId: "abc", cwd: "/repo" };

function turn(index: number, text = `answer ${index}`): Turn {
  return {
    index,
    prompt: "p",
    text,
    thinking: "",
    toolUses: [],
    files: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    endedAt: `2026-09-11T1${index}:00:00.000Z`,
  };
}

/** A disk that never touches the disk. */
function fake(seed: string[] = []): JournalIO & { files: Map<string, string> } {
  const files = new Map<string, string>(seed.map((path) => [path, "old"]));
  return {
    files,
    ensureDir: () => undefined,
    exists: (path) => files.has(path),
    write: (path, text) => void files.set(path, text),
  };
}

test("every answered turn is written once, into the export directory", () => {
  const io = fake();
  const result = journalTurns([turn(1), turn(2)], target, config, io);

  assert.equal(result.written.length, 2);
  assert.equal(result.skipped, 0);
  for (const path of result.written) {
    assert.match(path, /^\/exports\/repo-abc-turn0\d-\d{8}-\d{6}\.md$/);
  }
});

test("a prompt with no answer yet is not journalled", () => {
  // Mid-answer the newest turn has no text; writing an empty file helps nobody.
  const result = journalTurns([turn(1), turn(2, "")], target, config, fake());

  assert.equal(result.written.length, 1);
});

test("two sessions in the same project are journalled separately", () => {
  const io = fake();
  const other = { ...target, sessionId: "other" };
  journalTurns([turn(1)], target, config, io);
  const second = journalTurns([turn(1)], other, config, io);

  assert.equal(second.written.length, 1);
  assert.equal(second.skipped, 0);
  assert.notEqual(second.written[0], [...io.files.keys()][0]);
});

test("running it again writes nothing", () => {
  const io = fake();
  const first = journalTurns([turn(1), turn(2)], target, config, io);
  const second = journalTurns([turn(1), turn(2)], target, config, io);

  assert.equal(second.written.length, 0);
  assert.equal(second.skipped, 2);
  for (const path of first.written) assert.match(io.files.get(path) ?? "", /answer/);
});

test("a turn already saved by hand is left exactly as it is", () => {
  // `save` and the journal name a file the same way, so they cannot fight.
  const io = fake();
  const path = journalTurns([turn(1)], target, config, io).written[0]!;

  io.files.set(path, "edited by hand");
  journalTurns([turn(1)], target, config, io);

  assert.equal(io.files.get(path), "edited by hand");
});

test("one unwritable answer does not cost the rest of the session", () => {
  const io = fake();
  const broken: JournalIO = {
    ...io,
    write: (path, text) => {
      if (path.includes("turn02")) throw new Error("read-only");
      io.write(path, text);
    },
  };

  const result = journalTurns([turn(1), turn(2), turn(3)], target, config, broken);

  assert.equal(result.written.length, 2);
  assert.equal(result.failed, 1);
});

test("an export directory that cannot be created fails the whole run cleanly", () => {
  const io: JournalIO = {
    ...fake(),
    ensureDir: () => {
      throw new Error("permission denied");
    },
  };

  const result = journalTurns([turn(1), turn(2)], target, config, io);
  assert.deepEqual(result, { written: [], skipped: 0, failed: 2 });
});

test("the summary says nothing when there was nothing to do", () => {
  assert.equal(journalSummary({ written: [], skipped: 9, failed: 0 }), undefined);
  assert.equal(journalSummary({ written: ["a"], skipped: 0, failed: 0 }), "journalled 1 answer");
  assert.equal(journalSummary({ written: ["a", "b"], skipped: 0, failed: 0 }), "journalled 2 answers");
  assert.equal(
    journalSummary({ written: ["a"], skipped: 0, failed: 2 }),
    "journalled 1 answer · 2 failed",
  );
  assert.equal(journalSummary({ written: [], skipped: 0, failed: 3 }), "journal failed ×3");
});
