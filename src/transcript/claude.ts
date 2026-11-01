import type { TurnParser } from "./reader.js";
import type { FileEdit, TokenUsage, ToolUse, Turn } from "./types.js";

/**
 * Claude Code's JSONL transcript is not a documented format, so this parser is
 * deliberately defensive: unknown record types are skipped rather than treated
 * as errors, and every field access tolerates absence.
 */

interface RawRecord {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
  cwd?: string;
  version?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

/**
 * Tools that change a file, and the field each one puts the path in. Read,
 * Grep and Glob are deliberately absent: looking at a file is the agent's
 * research, not a result worth carrying away.
 */
const WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** Harness scaffolding that wraps a prompt but is not part of what the user typed. */
const WRAPPER_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "command-message",
  "command-args",
];

/** Builds turns from Claude Code records: a prompt opens a turn, assistant records fill it. */
class ClaudeParser implements TurnParser {
  #closed: Turn[] = [];
  #current: Turn | null = null;

  ingest(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const record = value as RawRecord;

    // Subagent traffic belongs to a different conversation.
    if (record.isSidechain === true) return;

    if (record.type === "user" && isPrompt(record)) {
      if (this.#current) this.#closed.push(finish(this.#current));
      this.#current = startTurn(this.#closed.length + 1, record);
      return;
    }

    if (record.type === "assistant" && this.#current) {
      accumulate(this.#current, record);
    }
  }

  snapshot(): Turn[] {
    if (!this.#current) return this.#closed.slice();
    return [...this.#closed, finish(cloneTurn(this.#current))];
  }
}

export const claudeParser = (): TurnParser => new ClaudeParser();

function cloneTurn(turn: Turn): Turn {
  return {
    ...turn,
    toolUses: turn.toolUses.map((use) => ({ ...use })),
    files: turn.files.map((file) => ({ ...file })),
    usage: { ...turn.usage },
  };
}

function isPrompt(record: RawRecord): boolean {
  if (record.isMeta === true) return false;
  const content = record.message?.content;

  if (typeof content === "string") return cleanPrompt(content) !== "";
  if (!Array.isArray(content)) return false;

  const blocks = content as ContentBlock[];
  // A tool result is Claude replying to itself, not the user starting a turn.
  if (blocks.some((block) => block?.type === "tool_result")) return false;
  return cleanPrompt(textOf(blocks)) !== "";
}

function startTurn(index: number, record: RawRecord): Turn {
  const content = record.message?.content;
  const raw = typeof content === "string" ? content : textOf(content as ContentBlock[]);
  return {
    index,
    prompt: cleanPrompt(raw),
    promptAt: record.timestamp,
    text: "",
    thinking: "",
    toolUses: [],
    files: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    gitBranch: record.gitBranch,
    cwd: record.cwd,
    agentVersion: record.version,
  };
}

function accumulate(turn: Turn, record: RawRecord): void {
  const content = record.message?.content;
  const blocks: ContentBlock[] = Array.isArray(content)
    ? (content as ContentBlock[])
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];

  for (const block of blocks) {
    if (!block) continue;
    if (block.type === "text" && block.text) {
      turn.text = turn.text === "" ? block.text : `${turn.text}\n\n${block.text}`;
    } else if (block.type === "thinking" && block.thinking) {
      turn.thinking =
        turn.thinking === "" ? block.thinking : `${turn.thinking}\n\n${block.thinking}`;
    } else if (block.type === "tool_use") {
      const name = block.name ?? "tool";
      addToolUse(turn.toolUses, name);
      addFileEdit(turn.files, name, block.input);
    }
  }

  if (record.message?.model) turn.model = record.message.model;
  if (record.timestamp) turn.endedAt = record.timestamp;
  if (record.gitBranch) turn.gitBranch = record.gitBranch;
  addUsage(turn.usage, record.message?.usage);
}

function finish(turn: Turn): Turn {
  turn.text = turn.text.trim();
  turn.thinking = turn.thinking.trim();
  // The file worked on hardest is usually the one the answer is about.
  turn.files.sort((left, right) => right.edits - left.edits);
  if (turn.promptAt && turn.endedAt) {
    const ms = Date.parse(turn.endedAt) - Date.parse(turn.promptAt);
    if (Number.isFinite(ms) && ms >= 0) turn.durationMs = ms;
  }
  return turn;
}

function addToolUse(uses: ToolUse[], name: string): void {
  const existing = uses.find((use) => use.name === name);
  if (existing) existing.count += 1;
  else uses.push({ name, count: 1 });
}

function addFileEdit(files: FileEdit[], name: string, input: unknown): void {
  const field = WRITE_TOOLS[name];
  if (field === undefined || typeof input !== "object" || input === null) return;

  const path = (input as Record<string, unknown>)[field];
  if (typeof path !== "string" || path.trim() === "") return;

  const existing = files.find((file) => file.path === path);
  if (existing) existing.edits += 1;
  else files.push({ path, edits: 1 });
}

function addUsage(usage: TokenUsage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return;
  usage.input += num(raw["input_tokens"]);
  usage.output += num(raw["output_tokens"]);
  usage.cacheRead += num(raw["cache_read_input_tokens"]);
  usage.cacheCreation += num(raw["cache_creation_input_tokens"]);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textOf(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n\n");
}

/**
 * Strips harness scaffolding so the framed prompt reads like what the user
 * actually typed. `<command-name>x</command-name>` survives as `/x`.
 */
export function cleanPrompt(raw: string): string {
  let text = raw;
  for (const tag of WRAPPER_TAGS) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  text = text.replace(/<command-name>([\s\S]*?)<\/command-name>/g, (_m, name: string) => {
    const trimmed = name.trim();
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  });
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
