import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSubagentSource } from "./codex.js";

/**
 * Codex writes one rollout per session at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, in the folder
 * of the day the session started, and moves archived ones flat into
 * `archived_sessions/`. A resumed session keeps writing to its original file,
 * so a lookup cannot assume today's folder.
 */

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexSessionsDir(): string {
  return join(codexHome(), "sessions");
}

function archivedDir(): string {
  return join(codexHome(), "archived_sessions");
}

/** `rollout-<time>-<id>.jsonl` → `<id>`. Codex ids are UUIDs, so the id is the last five dash groups. */
export function codexSessionId(path: string): string | undefined {
  const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return match?.[1];
}

/** Found paths by session id. A rollout never moves while live, but one may be archived. */
const found = new Map<string, string>();

/** The rollout for a session id, newest day first, then the archive. */
export function findCodexTranscript(sessionId: string): string | null {
  if (sessionId === "" || /[/\\]/.test(sessionId)) return null;
  const cached = found.get(sessionId);
  if (cached && existsSync(cached)) return cached;

  const suffix = `-${sessionId}.jsonl`;
  for (const dir of [...dayDirs(codexSessionsDir()), archivedDir()]) {
    const name = list(dir).find((entry) => entry.startsWith("rollout-") && entry.endsWith(suffix));
    if (name) {
      const path = join(dir, name);
      found.set(sessionId, path);
      return path;
    }
  }
  return null;
}

/** How many recent top-level rollouts {@link newestCodexTranscript} checks before giving up. */
const NEWEST_SCAN_LIMIT = 200;
/** A bound on all rollouts opened, subagent ones included, so a busy reviewer cannot stall it. */
const NEWEST_OPEN_LIMIT = 1000;

/**
 * Without a session id, the most recently written rollout of a top-level
 * session started in `cwd` is the best guess. Like Claude's, it is only a
 * guess — two Codex sessions in one folder share it — so it is used last.
 * Subagent rollouts (a guardian review, a spawned worker) are skipped.
 */
export function newestCodexTranscript(cwd: string): string | undefined {
  const candidates: { path: string; mtime: number }[] = [];
  for (const dir of dayDirs(codexSessionsDir())) {
    for (const entry of list(dir)) {
      if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        candidates.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        /* raced with a delete or an archive */
      }
    }
  }
  candidates.sort((left, right) => right.mtime - left.mtime);

  // Ordered by last write, not by folder: a resumed session keeps writing to
  // the folder of the day it started, so stopping at the newest day would miss it.
  let topLevel = 0;
  for (const { path } of candidates.slice(0, NEWEST_OPEN_LIMIT)) {
    const meta = sessionMeta(path);
    if (!meta || meta.subagent) continue;
    if (meta.cwd === cwd) return path;
    if (++topLevel >= NEWEST_SCAN_LIMIT) break;
  }
  return undefined;
}

/** `YYYY/MM/DD` folders under `root`, newest first. */
function dayDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const year of numbered(root)) {
    for (const month of numbered(join(root, year))) {
      for (const day of numbered(join(root, year, month))) {
        dirs.push(join(root, year, month, day));
      }
    }
  }
  return dirs;
}

/** Entries of `dir` that are all digits, highest first. */
function numbered(dir: string): string[] {
  return list(dir)
    .filter((entry) => /^\d+$/.test(entry))
    .sort((left, right) => Number(right) - Number(left));
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * How much of a rollout {@link sessionMeta} reads. The first record carries
 * the base instructions and can run long, but `cwd` and `source` come before
 * them, so a prefix is enough.
 */
const META_HEAD_BYTES = 64 * 1024;

/** The `session_meta` record a rollout opens with: where it ran and whether a subagent wrote it. */
export function sessionMeta(path: string): { cwd?: string; subagent: boolean } | undefined {
  const head = readHead(path);
  if (head === undefined) return undefined;

  const newline = head.indexOf("\n");
  if (newline !== -1) {
    try {
      const record = JSON.parse(head.slice(0, newline)) as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (record.type !== "session_meta" || typeof record.payload !== "object" || !record.payload) {
        return undefined;
      }
      const cwd = record.payload["cwd"];
      return {
        cwd: typeof cwd === "string" ? cwd : undefined,
        subagent: isSubagentSource(record.payload["source"]),
      };
    } catch {
      return undefined;
    }
  }
  return scanMeta(head);
}

/**
 * Reads `cwd` and `source` out of a first record too long to parse whole.
 * They are top-level fields written before the instructions, so the first
 * occurrence of each is the record's own.
 */
function scanMeta(head: string): { cwd?: string; subagent: boolean } | undefined {
  if (!/^\{"(?:timestamp|type)"/.test(head) || !head.includes('"type":"session_meta"')) {
    return undefined;
  }
  const match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head);
  let cwd: string | undefined;
  if (match) {
    try {
      cwd = JSON.parse(match[1]!) as string;
    } catch {
      cwd = undefined;
    }
  }
  return { cwd, subagent: /"source":\{"subagent"/.test(head) };
}

function readHead(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(META_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n > 0 ? buf.subarray(0, n).toString("utf8") : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
