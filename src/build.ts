import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Telling a rebuilt plugin from a running one.
 *
 * A Herdr pane keeps the modules it loaded at startup, so `npm run build` never
 * reaches an open dock: it goes on running the old code until it is reopened.
 * That once cost a long hunt for a bug already fixed on disk, so the dock says
 * `rebuilt · reopen` when the build underneath it has moved on.
 *
 * The check is over content, not timestamps. `tsc` rewrites every output on
 * every build, so an mtime says "something was compiled", which is not the same
 * as "something changed" — running the test suite was enough to raise a false
 * alarm. It is also over every built module rather than the dock's own file:
 * editing any other module leaves `dock.js` byte-identical while still leaving
 * this process out of date, and that is the case that matters most.
 */

export interface BuildIO {
  list(dir: string): { name: string; directory: boolean }[];
  read(path: string): string | Uint8Array;
}

const DISK: BuildIO = {
  list(dir) {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
    }));
  },
  read: (path) => readFileSync(path),
};

/** Every built module, in a stable order. Tests are not part of what runs. */
export function moduleFiles(dir: string, io: BuildIO = DISK): string[] {
  let entries: { name: string; directory: boolean }[];
  try {
    entries = io.list(dir);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.directory) out.push(...moduleFiles(path, io));
    else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(path);
  }
  return out;
}

/**
 * A hash of the built code. Empty means "cannot tell", and a check that cannot
 * tell must never claim staleness.
 */
export function fingerprint(dir: string, io: BuildIO = DISK): string {
  const files = moduleFiles(dir, io);
  if (files.length === 0) return "";

  const hash = createHash("sha1");
  for (const file of files) {
    // The name counts too: a module appearing or vanishing is a changed build.
    hash.update(file);
    try {
      hash.update(io.read(file));
    } catch {
      return "";
    }
  }
  return hash.digest("hex");
}
