/**
 * Minimal TOML reader for Fleece's own config file.
 *
 * Deliberately a subset: comments, `[section]` headers, and scalar or
 * string-array values. Fleece has no runtime dependencies, and its config is
 * flat, so a full TOML implementation would cost more than it buys.
 */

export type TomlScalar = string | number | boolean | string[];
export type TomlTable = Record<string, TomlScalar | Record<string, TomlScalar>>;

export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let table: Record<string, TomlScalar> = root as Record<string, TomlScalar>;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;

    const section = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (section) {
      const name = section[1]!;
      const nested: Record<string, TomlScalar> = {};
      root[name] = nested;
      table = nested;
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = parseValue(pair[2]!.trim());
    if (value !== undefined) table[pair[1]!] = value;
  }

  return root;
}

/** Strips a trailing `#` comment, ignoring `#` inside a quoted string. */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(raw: string): TomlScalar | undefined {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(unquote);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return unquote(raw);
  }
  return undefined;
}

function unquote(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw;
}
