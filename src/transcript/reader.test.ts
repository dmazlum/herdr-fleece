import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseTranscript, readTurnsGrowing, TranscriptWatch, type TurnParser } from "./reader.js";
import type { Turn } from "./types.js";

/** Records every value it is handed; one turn per record, prompt = its JSON. */
function recorder(): { seen: unknown[]; create: () => TurnParser } {
  const seen: unknown[] = [];
  return {
    seen,
    create: () => ({
      ingest: (record) => void seen.push(record),
      snapshot: (): Turn[] =>
        seen.map((record, i) => ({
          index: i + 1,
          prompt: JSON.stringify(record),
          text: "",
          thinking: "",
          toolUses: [],
          files: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        })),
    }),
  };
}

test("reader hands every parsed line to the parser, skipping blanks and garbage", () => {
  const { seen, create } = recorder();
  parseTranscript('{"a":1}\n\n   \nnot json\n[2]\nnull\n{"b":', create);
  assert.deepEqual(seen, [{ a: 1 }, [2], null]);
});

test("reader holds a partial trailing line until the rest arrives", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleece-reader-"));
  try {
    const path = join(dir, "t.jsonl");
    const { seen, create } = recorder();
    writeFileSync(path, '{"a":1}\n{"b":');
    const once = readTurnsGrowing(path, create);
    assert.deepEqual(seen, [{ a: 1 }]);

    appendFileSync(path, "2}\n");
    const twice = readTurnsGrowing(path, create, once.cursor);
    assert.equal(twice.cursor, once.cursor, "a grown file continues the same cursor");
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader starts a fresh parser when the file is rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleece-reader-"));
  try {
    const path = join(dir, "t.jsonl");
    let parsers = 0;
    const { create } = recorder();
    const counted = () => (parsers++, create());
    const watch = new TranscriptWatch(counted);

    writeFileSync(path, '{"a":1}\n{"a":2}\n');
    assert.equal(watch.read(path).length, 2);
    writeFileSync(path, '{"z":1}\n');
    watch.read(path);
    assert.equal(parsers, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
