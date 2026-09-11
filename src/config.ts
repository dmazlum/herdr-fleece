import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_KEYS, type KeyBindings, resolveKeys } from "./keys.js";
import { parseToml, type TomlScalar, type TomlTable } from "./toml.js";

export interface FleeceConfig {
  /** Directory that `fleece save` writes into. */
  exportDir: string;
  /** Include the user prompt above the answer in exports. */
  includePrompt: boolean;
  /** Include the agent's thinking blocks. Off by default: they are noisy. */
  includeThinking: boolean;
  /** Emit YAML front matter (model, session, tokens) in saved Markdown. */
  frontMatter: boolean;
  /**
   * Write every answer to the export directory as it lands. Off by default:
   * a directory that fills up on its own should be something you asked for.
   */
  journal: boolean;
  /** How many recent turns the dock scans for take-away items. */
  dockTurns: number;
  /** Columns the dock aims for when it opens. */
  dockWidth: number;
  /** Dock command bindings, from the `[keys]` table. */
  keys: KeyBindings;
  /** Bindings that were ignored, for `fleece doctor` to explain. */
  keyProblems: string[];
}

const DEFAULTS: FleeceConfig = {
  exportDir: join(homedir(), "Documents", "fleece"),
  includePrompt: true,
  includeThinking: false,
  frontMatter: true,
  journal: false,
  dockTurns: 3,
  dockWidth: 46,
  keys: DEFAULT_KEYS,
  keyProblems: [],
};

export function configPath(): string | null {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  return dir ? join(dir, "config.toml") : null;
}

export function loadConfig(): FleeceConfig {
  const path = configPath();
  if (!path) return { ...DEFAULTS };

  let table: TomlTable;
  try {
    table = parseToml(readFileSync(path, "utf8"));
  } catch {
    // A missing or unreadable config is not an error: defaults are usable.
    return { ...DEFAULTS };
  }

  const bindings = resolveKeys(section(table, "keys"));

  return {
    keys: bindings.keys,
    keyProblems: bindings.problems,
    exportDir: expandHome(str(table, "export_dir") ?? DEFAULTS.exportDir),
    includePrompt: bool(table, "include_prompt") ?? DEFAULTS.includePrompt,
    includeThinking: bool(table, "include_thinking") ?? DEFAULTS.includeThinking,
    frontMatter: bool(table, "front_matter") ?? DEFAULTS.frontMatter,
    journal: bool(table, "journal") ?? DEFAULTS.journal,
    dockTurns: Math.max(1, int(table, "dock_turns") ?? DEFAULTS.dockTurns),
    dockWidth: Math.max(24, int(table, "dock_width") ?? DEFAULTS.dockWidth),
  };
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function section(table: TomlTable, key: string): Record<string, TomlScalar> | undefined {
  const value = table[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, TomlScalar>;
}

function str(table: TomlTable, key: string): string | undefined {
  const value = table[key];
  return typeof value === "string" ? value : undefined;
}

function bool(table: TomlTable, key: string): boolean | undefined {
  const value = table[key];
  return typeof value === "boolean" ? value : undefined;
}

function int(table: TomlTable, key: string): number | undefined {
  const value = table[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
