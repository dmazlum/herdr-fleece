import type { Turn } from "./transcript/types.js";

/**
 * Which answers the dock is scanning, and how paging back through them works.
 *
 * The window is described by a *pin* — the index of the newest answer it ends
 * at — rather than by a distance from the end of the session. A turn finishing
 * while you read an older one therefore does not shift what you are looking at.
 * A null pin means "follow the session".
 */

/** The answers in a session. A prompt with no answer is not something to page to. */
export function answers(turns: Turn[]): Turn[] {
  return turns.filter((turn) => turn.text !== "");
}

/** Every answer up to and including the pinned one; all of them when live. */
export function windowOf(turns: Turn[], pinned: number | null): Turn[] {
  const all = answers(turns);
  if (pinned === null) return all;

  const position = all.findIndex((turn) => turn.index === pinned);
  // A pin that no longer resolves — a retarget, a rewritten transcript — is
  // better treated as live than as an empty panel.
  return position === -1 ? all : all.slice(0, position + 1);
}

export interface Step {
  /** The pin to adopt, or null to follow the session again. */
  pinned: number | null;
  /** Why nothing moved, when nothing moved. */
  blocked?: string;
}

export function stepPin(turns: Turn[], pinned: number | null, direction: -1 | 1): Step {
  const all = answers(turns);
  if (all.length === 0) return { pinned, blocked: "no answers yet" };

  const here = windowOf(turns, pinned).length - 1;
  const next = here + direction;

  if (next < 0) return { pinned, blocked: "oldest answer" };
  // Stepping onto the newest answer unpins, so the dock resumes following.
  if (next >= all.length - 1) {
    return pinned === null ? { pinned, blocked: "newest answer" } : { pinned: null };
  }
  return { pinned: all[next]!.index };
}

/** Header text: the window size while live, the range and distance once pinned. */
export function windowLabel(turns: Turn[], pinned: number | null, size: number): string {
  const window = windowOf(turns, pinned);
  const shown = window.slice(-Math.max(1, size));
  if (shown.length === 0) return "";

  if (pinned === null) return `last ${shown.length} turn${shown.length === 1 ? "" : "s"}`;

  // Naming the newest answer in the window beats naming its span: the turns in
  // between are not all answers, so a range reads as more than it contains.
  // This is also the turn `y`, `m` and `o` act on.
  return `turn ${shown[shown.length - 1]!.index} · ${answers(turns).length - window.length} back`;
}
