import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FleeceConfig } from "../config.js";
import type { Target, Turn } from "../transcript/types.js";

/** The answer as a standalone Markdown document. */
export function buildMarkdown(turn: Turn, target: Target, config: FleeceConfig): string {
  const parts: string[] = [];

  if (config.frontMatter) parts.push(frontMatter(turn, target));
  if (config.includePrompt && turn.prompt !== "") {
    parts.push(`## Prompt\n\n${quote(turn.prompt)}`);
  }
  if (config.includeThinking && turn.thinking !== "") {
    parts.push(`<details>\n<summary>Thinking</summary>\n\n${turn.thinking}\n\n</details>`);
  }
  parts.push(turn.text === "" ? "_(no text in this answer)_" : turn.text);

  // Deliberately no tool-use footer: an export is a document to paste into a
  // PR or a doc, and which tools ran is session metadata, not content.
  return `${parts.join("\n\n")}\n`;
}

export async function saveMarkdown(
  turn: Turn,
  target: Target,
  config: FleeceConfig,
): Promise<string> {
  mkdirSync(config.exportDir, { recursive: true });
  const path = join(config.exportDir, fileName(turn, target));
  writeAtomic(path, buildMarkdown(turn, target, config));
  return path;
}

export function fileName(turn: Turn, target: Target): string {
  const project = slug(target.cwd ? basename(target.cwd) : "session");
  const session = slug(target.sessionId ?? target.paneId ?? "session").slice(0, 12);
  const index = String(turn.index).padStart(2, "0");
  return `${project}-${session}-turn${index}-${stamp(turn.endedAt)}.md`;
}

/** Write then rename so two sessions cannot interleave a half-written export. */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created, or already gone */
    }
    throw err;
  }
}

function frontMatter(turn: Turn, target: Target): string {
  const fields: [string, string | number | undefined][] = [
    ["agent", target.agent],
    ["model", turn.model],
    ["session", target.sessionId],
    ["turn", turn.index],
    ["date", turn.endedAt ?? turn.promptAt],
    ["cwd", turn.cwd ?? target.cwd],
    ["branch", turn.gitBranch],
    ["input_tokens", turn.usage.input || undefined],
    ["output_tokens", turn.usage.output || undefined],
  ];

  const lines = fields
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) =>
      typeof value === "number" ? `${key}: ${value}` : `${key}: ${yaml(value)}`,
    );

  return `---\n${lines.join("\n")}\n---`;
}

function yaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned === "" ? "session" : cleaned;
}

/** Local-time `YYYYMMDD-HHmmss`, so exports sort the way the user experienced them. */
function stamp(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  const when = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  );
}
