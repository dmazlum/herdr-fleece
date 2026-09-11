import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { extractCodeBlocks } from "./export/code.js";
import { parseInline } from "./render/markdown.js";
import type { Turn } from "./transcript/types.js";

/**
 * Pulls the take-away pieces out of an answer: the things you would otherwise
 * select with the mouse. The agent pane already shows the prose, so the dock
 * shows only what you might want to carry somewhere else.
 */

export type ItemKind = "file" | "code" | "command" | "path" | "link";

export interface Item {
  kind: ItemKind;
  /** One line describing the item in the panel. */
  label: string;
  /** Exactly what lands on the clipboard. */
  text: string;
  /** Short left-hand tag, e.g. a fence language. */
  tag?: string;
  /** Right-aligned detail, e.g. "12 ln". */
  detail?: string;
  turn: number;
}

const SHELL_LANGUAGES = new Set(["sh", "bash", "zsh", "shell", "console", "terminal"]);

/** A shell block longer than this is a script to copy whole, not a list of commands. */
const MAX_COMMAND_LINES = 12;

const COMMAND_HEADS = new Set([
  "herdr", "npm", "npx", "pnpm", "yarn", "bun", "node", "deno",
  "git", "gh", "docker", "kubectl", "terraform", "terragrunt", "aws",
  "php", "composer", "artisan", "python", "python3", "pip", "cargo", "go",
  "make", "curl", "wget", "ssh", "scp", "rsync", "sed", "awk", "jq",
  "cd", "ls", "mkdir", "rm", "cp", "mv", "cat", "tail", "head", "grep", "find",
]);

const MAX_PER_KIND = 12;
const LONG_LINE = 800;

export interface ExtractOptions {
  /** How many of the most recent answered turns to scan. */
  turns?: number;
  /** Directory that relative paths are resolved against. */
  cwd?: string;
  /** Injected for tests; by default a path has to be on disk to be listed. */
  exists?: (path: string) => boolean;
}

/**
 * Resolves a path the way the reader would, so it can be checked for existence.
 * Returns null when there is nothing to check against.
 */
export function resolvePath(text: string, cwd?: string): string | null {
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  if (text.startsWith("/")) return text;
  if (!cwd) return null;
  return resolve(cwd, text);
}

/** One turn plus the answers to "where is this path, and is it there?". */
interface Scope {
  turn: Turn;
  /** The absolute form of a path as this turn wrote it, or null if unknowable. */
  resolve(text: string): string | null;
  exists(path: string): boolean;
  /** Directory the turn ran in, for shortening labels. */
  base?: string;
  /** Absolute paths already listed as edited files, shared across turns. */
  edited: Set<string>;
}

export function extractItems(turns: Turn[], options: ExtractOptions = {}): Item[] {
  const answered = turns.filter((turn) => turn.text !== "");
  const recent = answered.slice(-Math.max(1, options.turns ?? 3)).reverse();

  const items: Item[] = [];
  const seen = new Set<string>();

  const add = (item: Item): void => {
    const key = `${item.kind}:${item.text}`;
    if (seen.has(key)) return;
    if (items.filter((entry) => entry.kind === item.kind).length >= MAX_PER_KIND) return;
    seen.add(key);
    items.push(item);
  };

  /**
   * A path that is not on disk is almost always an illustration — `~/a`,
   * `src/a.ts` — and copying one helps nobody. Existence is the only reliable
   * way to tell an example apart from a file the reader actually has.
   */
  const exists = options.exists ?? existsSync;
  const edited = new Set<string>();

  const scopes = recent.map((turn): Scope => {
    // Each turn records the directory the agent was in, which beats a single
    // current cwd when a session has moved around.
    const base = turn.cwd ?? options.cwd;
    return { turn, base, exists, edited, resolve: (text) => resolvePath(text, base) };
  });

  // Files first, and in a pass of their own: a path the agent actually edited
  // must be claimed before the prose scan can list it again as a guess.
  for (const scope of scopes) collectFiles(scope, add);

  for (const scope of scopes) {
    collectBlocks(scope.turn, add);
    collectInline(scope, add);
    collectLinks(scope.turn, add);
  }

  const order: ItemKind[] = ["file", "code", "command", "path", "link"];
  return items.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));
}

/**
 * The files the agent wrote to, read off its own tool calls. Every other
 * section is inference from prose; this one is a record of what happened, so
 * it leads the panel and can never name a file the answer only imagined.
 */
function collectFiles(scope: Scope, add: (item: Item) => void): void {
  for (const file of scope.turn.files ?? []) {
    const path = scope.resolve(file.path) ?? file.path;
    // The agent may have written it and then moved or removed it again.
    if (!scope.exists(path)) continue;

    scope.edited.add(path);
    add({
      kind: "file",
      label: relative(path, scope.base),
      text: path,
      detail: file.edits > 1 ? `×${file.edits}` : undefined,
      turn: scope.turn.index,
    });
  }
}

/** A path under the working directory reads better without the prefix. */
function relative(path: string, base?: string): string {
  if (base === undefined || base === "") return path;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function collectBlocks(turn: Turn, add: (item: Item) => void): void {
  for (const block of extractCodeBlocks(turn.text)) {
    const lines = block.code.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;

    const shell = block.lang !== undefined && SHELL_LANGUAGES.has(block.lang);
    if (shell && lines.length <= MAX_COMMAND_LINES) {
      for (const line of lines) {
        const command = line.replace(/^\s*\$\s+/, "").trim();
        if (command === "" || command.startsWith("#")) continue;
        add({ kind: "command", label: command, text: command, turn: turn.index });
      }
      continue;
    }

    if (block.lang === undefined && !looksLikeCode(block.code)) continue;

    add({
      kind: "code",
      label: lines[0]!.trim(),
      text: block.code,
      tag: block.lang,
      detail: `${lines.length} ln`,
      turn: turn.index,
    });
  }
}

/** Inline code carries most of the paths and one-off commands in an answer. */
function collectInline(scope: Scope, add: (item: Item) => void): void {
  const turn = scope.turn;

  for (const line of withoutFences(turn.text).split("\n")) {
    if (line.length > LONG_LINE) continue;
    for (const span of parseInline(line)) {
      if (!span.style.code) continue;
      const text = span.text.trim();
      if (text === "") continue;

      if (isPath(text)) {
        const path = scope.resolve(text);
        // A file the agent edited is already listed above, under its own name.
        if (path === null || scope.edited.has(path) || !scope.exists(path)) continue;
        add({ kind: "path", label: text, text, turn: turn.index });
      } else if (isCommand(text)) {
        add({ kind: "command", label: text, text, turn: turn.index });
      }
    }
  }
}

function collectLinks(turn: Turn, add: (item: Item) => void): void {
  const matches = turn.text.match(/https?:\/\/[^\s)<>"'\]]+/g) ?? [];
  for (const match of matches) {
    const url = match.replace(/[.,;:]+$/, "");
    add({ kind: "link", label: url.replace(/^https?:\/\//, ""), text: url, turn: turn.index });
  }
}

export function isPath(text: string): boolean {
  if (/\s/.test(text) || /^https?:\/\//.test(text)) return false;
  if (!text.includes("/") || text.includes("://")) return false;
  // An anchored path says what it is — but only if it anchors to something.
  // `~/`, `./` and `/` on their own point nowhere.
  const anchor = /^(~\/|\.{1,2}\/|\/)/.exec(text);
  if (anchor) return /[\w.@-]/.test(text.slice(anchor[0].length));

  if (!/^[\w.@-]+(\/[\w.@-]+)+$/.test(text)) return false;

  // A bare `a/b` is usually prose — `j/k`, `and/or`, `km/h`. Require a file
  // extension on the last segment before calling it a path.
  const tail = text.slice(text.lastIndexOf("/") + 1);
  return /\.[A-Za-z][\w-]{0,8}$/.test(tail);
}

/**
 * A fence with no language is as often console output as it is code. Listing
 * test runs, error messages and ASCII diagrams as "CODE" is noise, so an
 * unlabelled block has to show some sign of being source before it counts.
 */
export function looksLikeCode(text: string): boolean {
  if (/[{}]|;\s*$|=>|\(\)|\)\s*[:{]|->|::/m.test(text)) return true;
  if (
    /^\s*(function|const|let|var|class|def|import|export|return|public|private|fn|package|#include|SELECT|CREATE)\b/m.test(
      text,
    )
  ) {
    return true;
  }
  // `key = value` on its own line covers config formats such as TOML and ini.
  return /^\s*[\w.-]+\s*=\s*\S/m.test(text);
}

/** Arrows and ellipses mark a command being *shown* with its result, not run. */
const NOT_RUNNABLE = /[→⇒↩…]|\.\.\.$/;

export function isCommand(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 160 || NOT_RUNNABLE.test(trimmed)) return false;

  const head = trimmed.split(/\s+/)[0] ?? "";
  if (!COMMAND_HEADS.has(head)) return false;
  // A bare binary name on its own is a mention, not something to run.
  return trimmed.includes(" ");
}

/** Removes fenced blocks so their contents are not scanned twice. */
function withoutFences(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker) {
        fence = marker[1]!.charAt(0);
        continue;
      }
      out.push(line);
      continue;
    }
    if (marker && marker[1]!.charAt(0) === fence) fence = null;
  }
  return out.join("\n");
}
