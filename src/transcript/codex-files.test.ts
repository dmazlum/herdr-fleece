import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexSessionId, findCodexTranscript, newestCodexTranscript, sessionMeta } from "./codex-files.js";

/** Points CODEX_HOME at a scratch tree for one test. */
function withCodexHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "fleece-codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    run(home);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

let seconds = 1_790_000_000;

/** Writes a rollout under `sessions/<day>` (or `archived_sessions` when day is null). */
function rollout(
  home: string,
  day: string | null,
  id: string,
  meta: Record<string, unknown> = {},
): string {
  const dir = day === null ? join(home, "archived_sessions") : join(home, "sessions", day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-11-01T10-00-00-${id}.jsonl`);
  const record = { type: "session_meta", payload: { id, cwd: "/work/app", source: "cli", ...meta } };
  writeFileSync(path, `${JSON.stringify(record)}\n{"type":"event_msg","payload":{}}\n`);
  seconds += 10;
  utimesSync(path, seconds, seconds);
  return path;
}

test("codex files: a session id finds its rollout in whichever day it started", () => {
  withCodexHome((home) => {
    rollout(home, "2026/11/01", "aaa");
    const old = rollout(home, "2026/09/30", "bbb");
    rollout(home, "2025/12/31", "ccc");
    assert.equal(findCodexTranscript("bbb"), old);
    assert.equal(findCodexTranscript("zzz"), null);
  });
});

test("codex files: an archived session is found when it is no longer under sessions", () => {
  withCodexHome((home) => {
    const archived = rollout(home, null, "old1");
    assert.equal(findCodexTranscript("old1"), archived);
  });
});

test("codex files: a session id cannot reach outside the sessions tree", () => {
  withCodexHome(() => {
    assert.equal(findCodexTranscript("../x"), null);
    assert.equal(findCodexTranscript(""), null);
  });
});

test("codex files: the newest guess is the latest top-level rollout for that folder", () => {
  withCodexHome((home) => {
    rollout(home, "2026/10/30", "older", { cwd: "/work/app" });
    const mine = rollout(home, "2026/10/31", "mine", { cwd: "/work/app" });
    rollout(home, "2026/11/01", "elsewhere", { cwd: "/work/other" });
    rollout(home, "2026/11/01", "guard", { cwd: "/work/app", source: { subagent: { other: "guardian" } } });
    assert.equal(newestCodexTranscript("/work/app"), mine);
    assert.equal(newestCodexTranscript("/nowhere"), undefined);
  });
});

test("codex files: session_meta is read even when its line is long", () => {
  withCodexHome((home) => {
    const path = rollout(home, "2026/11/01", "big", { base_instructions: "x".repeat(200_000) });
    assert.deepEqual(sessionMeta(path), { cwd: "/work/app", subagent: false });
  });
});

test("codex files: no Codex home at all is not an error", () => {
  withCodexHome((home) => {
    rmSync(home, { recursive: true, force: true });
    assert.equal(findCodexTranscript("aaa"), null);
    assert.equal(newestCodexTranscript("/work/app"), undefined);
  });
});

test("codex files: the session id is the UUID at the end of a rollout's name", () => {
  assert.equal(
    codexSessionId("/x/2026/11/01/rollout-2026-11-01T16-26-58-01a1974a-b713-7752-8148-321634d1c016.jsonl"),
    "01a1974a-b713-7752-8148-321634d1c016",
  );
  assert.equal(codexSessionId("/x/notes.jsonl"), undefined);
});
