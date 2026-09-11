import type { TomlScalar } from "./toml.js";

/**
 * What the dock's keys do, in one place.
 *
 * Three things have to agree: what a key does, which keys are still free to
 * hand out as item picks, and what the hint bar claims. Keeping them in three
 * hand-maintained lists is how they drift — add a command, forget to remove its
 * letter from the pick pool, and the new key silently copies an item instead.
 * So the binding table is the source of truth and the other two are derived.
 *
 * Escape, Ctrl+C, the arrows and Page Up/Down are deliberately not bindable.
 * They are conventions rather than preferences, and a config that can unbind
 * "get me out of here" is a config that can lock someone in.
 */

export const COMMANDS = [
  "close",
  "down",
  "up",
  "page-down",
  "top",
  "bottom",
  "reload",
  "send",
  "older",
  "newer",
  "frame",
  "copy-answer",
  "save",
] as const;

export type Command = (typeof COMMANDS)[number];

export type KeyBindings = Record<Command, string>;

export const DEFAULT_KEYS: KeyBindings = {
  close: "q",
  down: "j",
  up: "k",
  "page-down": " ",
  top: "g",
  bottom: "G",
  reload: "r",
  send: "s",
  older: "[",
  newer: "]",
  frame: "o",
  "copy-answer": "y",
  save: "m",
};

export interface ResolvedKeys {
  keys: KeyBindings;
  /** Anything ignored, in words, for `fleece doctor` to show. */
  problems: string[];
}

/**
 * Reads the `[keys]` table. A binding Fleece cannot honour is reported and
 * dropped rather than failing the config: a typo in one key should not take the
 * dock down with it.
 */
export function resolveKeys(table: Record<string, TomlScalar> | undefined): ResolvedKeys {
  const keys: KeyBindings = { ...DEFAULT_KEYS };
  const problems: string[] = [];
  if (!table) return { keys, problems };

  const known = new Set<string>(COMMANDS);

  for (const [name, value] of Object.entries(table)) {
    const command = name.replace(/_/g, "-") as Command;
    if (!known.has(command)) {
      problems.push(`unknown command "${name}"`);
      continue;
    }
    if (typeof value !== "string" || [...value].length !== 1) {
      problems.push(`${name}: a binding is one character, not ${JSON.stringify(value)}`);
      continue;
    }
    keys[command] = value;
  }

  // A key bound twice leaves one command unreachable, and which one is an
  // accident of ordering. Report it rather than quietly picking a winner.
  const taken = new Map<string, Command>();
  for (const command of COMMANDS) {
    const other = taken.get(keys[command]);
    if (other !== undefined) {
      problems.push(`"${keys[command]}" is bound to both ${other} and ${command}`);
      continue;
    }
    taken.set(keys[command], command);
  }

  return { keys, problems };
}

/** Characters an item can be picked with: everything a command has not claimed. */
const POOL = "123456789abcdefghijklmnopqrstuvwxyz";

export function pickKeys(keys: KeyBindings = DEFAULT_KEYS): string[] {
  const bound = new Set(Object.values(keys));
  return [...POOL].filter((char) => !bound.has(char));
}

interface Segment {
  text: string;
  /** Higher survives longer when the bar runs out of room. */
  keep: number;
}

function segments(keys: KeyBindings): [Segment[], Segment[]] {
  return [
    [
      { text: "key copy", keep: 3 },
      { text: `${keys.send} send`, keep: 2 },
    ],
    [
      { text: `${keys["copy-answer"]} all`, keep: 3 },
      { text: `${keys.save} save`, keep: 3 },
      { text: `${keys.frame} frame`, keep: 2 },
      { text: `${keys.older} ${keys.newer} turn`, keep: 2 },
      { text: `${keys.reload} reload`, keep: 1 },
      { text: `${keys.close} close`, keep: 3 },
    ],
  ];
}

/** The two hint rows, each shrunk to fit by dropping its least useful parts. */
export function hintLines(keys: KeyBindings, room: [number, number]): [string, string] {
  const [first, second] = segments(keys);
  return [fit(first, room[0]), fit(second, room[1])];
}

function fit(all: Segment[], room: number): string {
  // Drop the least important first, and among equals the one furthest right.
  const order = all
    .map((segment, index) => ({ index, keep: segment.keep }))
    .sort((left, right) => left.keep - right.keep || right.index - left.index);

  const dropped = new Set<number>();
  for (let step = 0; step <= order.length; step++) {
    const text = all
      .filter((_, index) => !dropped.has(index))
      .map((segment) => segment.text)
      .join(" · ");
    if (text.length <= room || dropped.size === all.length) return text;
    dropped.add(order[step]!.index);
  }
  return "";
}
