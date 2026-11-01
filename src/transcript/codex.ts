import { isAbsolute, resolve } from "node:path";
import { parseTranscript, readTurnsGrowing, type TurnParser } from "./reader.js";
import type { FileEdit, TokenUsage, ToolUse, Turn } from "./types.js";

/**
 * Codex keeps a rollout per session: `{timestamp, type, payload}` per line.
 * It is not a documented format and it changes between releases, so, like the
 * Claude parser, this one skips what it does not recognise and tolerates any
 * missing field.
 *
 * Where a record has two copies (a model-side `response_item` and a UI-side
 * `event_msg`), one is picked so nothing is counted twice:
 *
 * - prompts come from `event_msg`: `item_completed` → `UserMessage` in newer
 *   builds, `user_message` in older ones. `response_item` user messages also
 *   carry AGENTS.md, environment context and app scaffolding, so they are not
 *   read at all.
 * - answers, reasoning and tool calls come from `response_item`, which every
 *   build writes.
 * - edited files come from `FileChange` items, which hold absolute paths for
 *   every patch however it was invoked. Builds without them fall back to the
 *   paths in an `apply_patch` call's patch text.
 * - usage is the growth of the session's running `total_token_usage` over the
 *   turn, which is immune to a `token_count` being written twice.
 */

interface RawRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface Totals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

/** A turn plus what is needed to finish it but never shown. */
interface OpenTurn {
  turn: Turn;
  /** Assistant messages in order; `phase` is absent in older builds. */
  messages: { text: string; phase?: string }[];
  /** `task_complete.last_agent_message`, used only when no message was recorded. */
  lastAgentMessage?: string;
  /** Files from `FileChange` items. */
  changed: FileEdit[];
  /** Files from `apply_patch` patch text, for builds that write no `FileChange`. */
  patched: FileEdit[];
  baseline: Totals;
  latest: Totals;
}

const ZERO: Totals = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

/** Lines that open a file section in an `apply_patch` patch. */
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;

class CodexParser implements TurnParser {
  #closed: Turn[] = [];
  #current: OpenTurn | null = null;
  /** A subagent's rollout (a guardian review, a spawned worker) is not the user's conversation. */
  #ignored = false;
  #cwd?: string;
  #model?: string;
  #gitBranch?: string;
  #version?: string;
  #totals: Totals = { ...ZERO };

  ingest(value: unknown): void {
    if (this.#ignored || typeof value !== "object" || value === null) return;
    const record = value as RawRecord;
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null) return;

    switch (record.type) {
      case "session_meta":
        this.#meta(payload);
        return;
      case "turn_context":
        this.#context(payload);
        return;
      case "event_msg":
        this.#event(payload, record.timestamp);
        return;
      case "response_item":
        this.#item(payload, record.timestamp);
        return;
    }
  }

  snapshot(): Turn[] {
    if (!this.#current) return this.#closed.slice();
    return [...this.#closed, finish(cloneOpen(this.#current))];
  }

  #meta(payload: Record<string, unknown>): void {
    const source = payload["source"];
    if (typeof source === "object" && source !== null && "subagent" in source) {
      this.#ignored = true;
      return;
    }
    this.#cwd = str(payload["cwd"]) ?? this.#cwd;
    this.#version = str(payload["cli_version"]) ?? this.#version;
    const git = payload["git"];
    if (typeof git === "object" && git !== null) {
      this.#gitBranch = str((git as Record<string, unknown>)["branch"]) ?? this.#gitBranch;
    }
  }

  /** Settings for the turn about to run. It lands before that turn's prompt. */
  #context(payload: Record<string, unknown>): void {
    this.#cwd = str(payload["cwd"]) ?? this.#cwd;
    this.#model = str(payload["model"]) ?? this.#model;
  }

  #event(payload: Record<string, unknown>, at?: string): void {
    switch (payload["type"]) {
      case "user_message": {
        // Older builds tagged injected context as a non-plain kind.
        const kind = str(payload["kind"]);
        if (kind !== undefined && kind !== "plain") return;
        this.#prompt(str(payload["message"]) ?? "", at);
        return;
      }
      case "item_completed": {
        const item = payload["item"];
        if (typeof item !== "object" || item === null) return;
        const typed = item as Record<string, unknown>;
        if (typed["type"] === "UserMessage") this.#prompt(contentText(typed["content"]), at);
        else if (typed["type"] === "FileChange" && this.#current) {
          addChanges(this.#current.changed, typed["changes"]);
          touch(this.#current, at);
        }
        return;
      }
      case "token_count": {
        const totals = totalsOf(payload["info"]);
        if (!totals) return;
        this.#totals = totals;
        if (this.#current) this.#current.latest = totals;
        return;
      }
      case "task_complete": {
        const open = this.#current;
        if (!open) return;
        open.lastAgentMessage = str(payload["last_agent_message"]) ?? open.lastAgentMessage;
        const ms = payload["duration_ms"];
        if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) open.turn.durationMs = ms;
        touch(open, at);
        return;
      }
    }
  }

  #item(payload: Record<string, unknown>, at?: string): void {
    const open = this.#current;
    if (!open) return;

    switch (payload["type"]) {
      case "message": {
        if (payload["role"] !== "assistant") return;
        const text = contentText(payload["content"]);
        if (text === "") return;
        open.messages.push({ text, phase: str(payload["phase"]) });
        touch(open, at);
        return;
      }
      case "reasoning": {
        const summary = summaryText(payload["summary"]);
        if (summary === "") return;
        open.turn.thinking =
          open.turn.thinking === "" ? summary : `${open.turn.thinking}\n\n${summary}`;
        return;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = str(payload["name"]) ?? "tool";
        addToolUse(open.turn.toolUses, name);
        if (name === "apply_patch") {
          const patch = patchText(payload["input"] ?? payload["arguments"]);
          addPatchPaths(open.patched, patch, open.turn.cwd);
        }
        touch(open, at);
        return;
      }
      case "local_shell_call":
        addToolUse(open.turn.toolUses, "shell");
        touch(open, at);
        return;
      case "web_search_call":
        addToolUse(open.turn.toolUses, "web_search");
        touch(open, at);
        return;
    }
  }

  #prompt(raw: string, at?: string): void {
    const prompt = raw.trim();
    if (prompt === "") return;

    // The same prompt from a second event kind, before anything answered it.
    const open = this.#current;
    if (open && open.turn.prompt === prompt && !hasActivity(open)) return;

    if (open) this.#closed.push(finish(open));
    this.#current = {
      turn: {
        index: this.#closed.length + 1,
        prompt,
        promptAt: at,
        text: "",
        thinking: "",
        toolUses: [],
        files: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        model: this.#model,
        gitBranch: this.#gitBranch,
        cwd: this.#cwd,
        agentVersion: this.#version,
      },
      messages: [],
      changed: [],
      patched: [],
      baseline: this.#totals,
      latest: this.#totals,
    };
  }
}

export const codexParser = (): TurnParser => new CodexParser();

export function readCodexTurns(path: string): Turn[] {
  return readTurnsGrowing(path, codexParser).turns;
}

export function parseCodexTranscript(source: string): Turn[] {
  return parseTranscript(source, codexParser);
}

/**
 * The answer is the final message, not the running commentary Codex writes
 * between tool calls. A build that marks no phases gets its last message; a
 * turn still working, with only commentary so far, has no answer yet.
 */
export function answerText(
  messages: { text: string; phase?: string }[],
  lastAgentMessage?: string,
): string {
  let text: string;
  if (messages.some((message) => message.phase !== undefined)) {
    text = messages
      .filter((message) => message.phase === "final_answer")
      .map((message) => message.text)
      .join("\n\n");
  } else {
    text = messages.at(-1)?.text ?? "";
  }
  if (text.trim() === "" && messages.length === 0) text = lastAgentMessage ?? "";
  return text.trim();
}

function finish(open: OpenTurn): Turn {
  const turn = open.turn;
  turn.text = answerText(open.messages, open.lastAgentMessage);
  turn.thinking = turn.thinking.trim();
  turn.files = (open.changed.length > 0 ? open.changed : open.patched).slice();
  // The file worked on hardest is usually the one the answer is about.
  turn.files.sort((left, right) => right.edits - left.edits);
  turn.usage = usageBetween(open.baseline, open.latest);
  if (turn.durationMs === undefined && turn.promptAt && turn.endedAt) {
    const ms = Date.parse(turn.endedAt) - Date.parse(turn.promptAt);
    if (Number.isFinite(ms) && ms >= 0) turn.durationMs = ms;
  }
  return turn;
}

function cloneOpen(open: OpenTurn): OpenTurn {
  return {
    ...open,
    turn: {
      ...open.turn,
      toolUses: open.turn.toolUses.map((use) => ({ ...use })),
      files: [],
      usage: { ...open.turn.usage },
    },
    messages: open.messages.slice(),
    changed: open.changed.map((file) => ({ ...file })),
    patched: open.patched.map((file) => ({ ...file })),
  };
}

function hasActivity(open: OpenTurn): boolean {
  return (
    open.messages.length > 0 ||
    open.turn.toolUses.length > 0 ||
    open.changed.length > 0 ||
    open.turn.thinking !== ""
  );
}

function touch(open: OpenTurn, at?: string): void {
  if (at) open.turn.endedAt = at;
}

/**
 * Codex's `input_tokens` includes the cached part; Fleece's `input`, as with
 * Claude, is only what was not read from cache.
 */
function usageBetween(from: Totals, to: Totals): TokenUsage {
  const delta = (key: keyof Totals) => Math.max(0, to[key] - from[key]);
  const cached = delta("cached");
  return {
    input: Math.max(0, delta("input") - cached),
    output: delta("output"),
    cacheRead: cached,
    cacheCreation: delta("cacheWrite"),
  };
}

function totalsOf(info: unknown): Totals | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const total = (info as Record<string, unknown>)["total_token_usage"];
  if (typeof total !== "object" || total === null) return undefined;
  const raw = total as Record<string, unknown>;
  return {
    input: num(raw["input_tokens"]),
    cached: num(raw["cached_input_tokens"]),
    cacheWrite: num(raw["cache_write_input_tokens"]),
    output: num(raw["output_tokens"]),
  };
}

/**
 * `FileChange.changes` maps an absolute path to what happened to it. A
 * deleted file is left out: there is nothing left to copy the path of or open.
 */
function addChanges(files: FileEdit[], changes: unknown): void {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) return;
  for (const [path, change] of Object.entries(changes as Record<string, unknown>)) {
    const detail = typeof change === "object" && change !== null ? (change as Record<string, unknown>) : {};
    if (detail["type"] === "delete") continue;
    addFile(files, str(detail["move_path"]) ?? path);
  }
}

/** `apply_patch` takes the patch as freeform text, or as `{"input": …}` JSON in older builds. */
function patchText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return str(parsed["input"]) ?? str(parsed["patch"]) ?? "";
    } catch {
      return raw;
    }
  }
  return raw;
}

function addPatchPaths(files: FileEdit[], patch: string, cwd?: string): void {
  const seen = new Set<string>();
  let section: string | undefined;
  for (const line of patch.split("\n")) {
    const match = PATCH_FILE.exec(line.trimEnd());
    if (!match) continue;
    const [, action, target, movedTo] = match;
    const raw = (target ?? movedTo ?? "").trim();
    if (raw === "") continue;
    const path = isAbsolute(raw) || !cwd ? raw : resolve(cwd, raw);
    if (movedTo !== undefined) {
      // A move lands the file at its new path; the old one is gone.
      if (section !== undefined) seen.delete(section);
      seen.add(path);
    } else if (action === "Delete") {
      seen.delete(path);
      section = undefined;
    } else {
      seen.add(path);
      section = path;
    }
  }
  for (const path of seen) addFile(files, path);
}

function addFile(files: FileEdit[], path: string): void {
  if (path.trim() === "") return;
  const existing = files.find((file) => file.path === path);
  if (existing) existing.edits += 1;
  else files.push({ path, edits: 1 });
}

function addToolUse(uses: ToolUse[], name: string): void {
  const existing = uses.find((use) => use.name === name);
  if (existing) existing.count += 1;
  else uses.push({ name, count: 1 });
}

/** Text of a content array: `input_text`, `output_text`, or an item's `text`/`Text`. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null ? str((part as Record<string, unknown>)["text"]) : undefined,
    )
    .filter((text): text is string => text !== undefined && text !== "")
    .join("\n\n");
}

function summaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return summary
    .map((part) =>
      typeof part === "string"
        ? part
        : typeof part === "object" && part !== null
          ? str((part as Record<string, unknown>)["text"])
          : undefined,
    )
    .filter((text): text is string => text !== undefined && text.trim() !== "")
    .join("\n\n");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
