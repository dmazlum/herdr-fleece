import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FleeceConfig } from "./config.js";
import { buildMarkdown, fileName, writeAtomic } from "./export/markdown.js";
import type { Target, Turn } from "./transcript/types.js";

/**
 * Keeping every answer in the export directory as Markdown.
 *
 * This is not about durability. The agent's transcript already holds every
 * answer it has ever written, and `[`/`]` pages back to any of them. It is about
 * having those answers as ordinary files — greppable, syncable, readable without
 * the agent running, and diffable next to the code they describe.
 *
 * There is deliberately no daemon and no state file to go stale. An export is
 * named after the turn that produced it, so "already journalled" is just a file
 * that exists: running this twice writes nothing the second time, and a manual
 * `save` of the same turn lands on the same path.
 */

export interface JournalIO {
  ensureDir(path: string): void;
  exists(path: string): boolean;
  write(path: string, text: string): void;
}

export interface JournalResult {
  /** Paths written by this run. */
  written: string[];
  /** Answers that were already on disk. */
  skipped: number;
  /** Answers that could not be written. */
  failed: number;
}

const DISK: JournalIO = {
  ensureDir(path) {
    mkdirSync(path, { recursive: true });
  },
  exists: existsSync,
  write(path, text) {
    writeAtomic(path, text);
  },
};

export function journalTurns(
  turns: Turn[],
  target: Target,
  config: FleeceConfig,
  io: JournalIO = DISK,
): JournalResult {
  const result: JournalResult = { written: [], skipped: 0, failed: 0 };

  const answered = turns.filter((turn) => turn.text !== "");
  if (answered.length === 0) return result;

  try {
    io.ensureDir(config.exportDir);
  } catch {
    result.failed = answered.length;
    return result;
  }

  for (const turn of answered) {
    const path = join(config.exportDir, fileName(turn, target));
    if (io.exists(path)) {
      result.skipped += 1;
      continue;
    }

    try {
      io.write(path, buildMarkdown(turn, target, config));
      result.written.push(path);
    } catch {
      // One unwritable answer must not cost the rest of the session.
      result.failed += 1;
    }
  }

  return result;
}

/**
 * What to put in the action bar, or nothing at all. A journal that had nothing
 * to do should say nothing: it is meant to be forgotten about.
 */
export function journalSummary(result: JournalResult): string | undefined {
  const count = result.written.length;
  if (count === 0) return result.failed > 0 ? `journal failed ×${result.failed}` : undefined;

  const wrote = `journalled ${count} answer${count === 1 ? "" : "s"}`;
  return result.failed > 0 ? `${wrote} · ${result.failed} failed` : wrote;
}
