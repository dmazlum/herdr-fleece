import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimDock,
  dockStatePath,
  readDockState,
  readFramePayload,
  releaseDock,
  stateDir,
  writeFramePayload,
} from "./dockstate.js";

function isolated(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleece-state-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  chmodSync(dir, 0o755);
  return dir;
}

test("the state directory is private to the user", () => {
  const dir = isolated();
  writeFramePayload({ ok: true });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

test("a frame payload has an unguessable name and mode 0600", () => {
  const dir = isolated();
  const path = writeFramePayload({ text: "secret" });

  assert.equal(path.startsWith(dir), true);
  assert.match(path, /frame-[0-9a-f]{32}\.json$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).text, "secret");

  rmSync(dir, { recursive: true, force: true });
});

test("a payload outside the state directory is refused", () => {
  const dir = isolated();
  const outsider = join(tmpdir(), `fleece-outside-${process.pid}.json`);
  writeFileSync(outsider, "{\"x\":1}");

  assert.throws(() => readFramePayload(outsider), /outside/);

  rmSync(outsider, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("releaseDock does not drop another process's claim", () => {
  const dir = isolated();
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  writeFileSync(dockStatePath(), JSON.stringify({ paneId: "w1:p1", pid: process.pid + 1 }));

  releaseDock("w1:p1");
  assert.equal(readDockState()?.pid, process.pid + 1);

  rmSync(dir, { recursive: true, force: true });
});

test("releaseDock clears a claim that this process still owns", () => {
  const dir = isolated();
  claimDock("w1:p1");
  assert.equal(readDockState()?.paneId, "w1:p1");

  releaseDock("w1:p1");
  assert.equal(readDockState(), null);
  assert.equal(existsSync(dockStatePath()), false);

  rmSync(dir, { recursive: true, force: true });
});

test("stateDir falls back to a user-private folder, not shared tmp", () => {
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  const dir = stateDir();
  if (previous === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = previous;

  assert.equal(dir.includes("fleece-"), true);
  assert.equal(dir === tmpdir(), false);
});
