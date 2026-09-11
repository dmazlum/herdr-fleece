import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * The dock is a singleton, so the toggle action and the dock process itself
 * need to agree on whether one is already open. The dock owns this file:
 * it claims it on start and releases it on exit.
 */

export interface DockState {
  paneId: string;
  pid: number;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The overlay pane is a separate process, so the turn it should frame is handed
 * over through a state file rather than resolved twice.
 */
export function writeFramePayload(data: unknown): string {
  const dir = ensureStateDir();
  const path = join(dir, `frame-${randomBytes(16).toString("hex")}.json`);
  writePrivate(path, JSON.stringify(data), true);
  return path;
}

export function stateDir(): string {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  return join(tmpdir(), `fleece-${uid}`);
}

export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* a directory we cannot chmod is still better than /tmp */
  }
  return dir;
}

export function dockStatePath(): string {
  return join(stateDir(), "dock.json");
}

export function readDockState(): DockState | null {
  try {
    const parsed = JSON.parse(readPrivate(dockStatePath())) as DockState;
    if (typeof parsed?.paneId !== "string" || parsed.paneId === "") return null;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function claimDock(paneId: string): void {
  const dir = ensureStateDir();
  const tmp = join(dir, `dock.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writePrivate(tmp, JSON.stringify({ paneId, pid: process.pid }), true);
  try {
    renameSync(tmp, dockStatePath());
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

/** Only clears the claim if it is still ours, so a restarted dock is not orphaned. */
export function releaseDock(paneId: string): void {
  const current = readDockState();
  if (current?.paneId !== paneId) return;
  if (current.pid !== process.pid) return;
  try {
    unlinkSync(dockStatePath());
  } catch {
    /* already gone */
  }
}

/** Reads a handoff file only if it lives under the plugin state directory. */
export function readFramePayload(path: string): string {
  const resolved = resolve(path);
  const root = resolve(stateDir());
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error("payload is outside the plugin state directory");
  }
  return readPrivate(resolved);
}

function writePrivate(path: string, text: string, exclusive: boolean): void {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    (exclusive ? constants.O_EXCL : constants.O_TRUNC) |
    NOFOLLOW;
  const fd = openSync(path, flags, FILE_MODE);
  try {
    writeSync(fd, text, undefined, "utf8");
    try {
      fchmodSync(fd, FILE_MODE);
    } catch {
      /* mode was already set at open */
    }
  } finally {
    closeSync(fd);
  }
}

function readPrivate(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
