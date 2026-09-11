import type { FleeceConfig } from "../config.js";
import type { Target, Turn } from "../transcript/types.js";
import { renderMarkdown } from "./markdown.js";
import { bold, clip, dim, displayWidth, pad, stripControls, wrap } from "./text.js";

export { displayWidth } from "./text.js";

export interface FrameOptions {
  width: number;
  /** Total rows available. Omit to render the whole answer without clipping. */
  height?: number;
  /** First body line to show. */
  scroll?: number;
  /** Transient message shown in the action bar, e.g. "copied 2.3 KB". */
  status?: string;
  /** Persistent right-aligned note, e.g. "live" or "polling". Replaces the scroll percentage. */
  note?: string;
}

/** Rows the border and chrome consume, leaving the rest for the answer. */
export const CHROME_ROWS = 4;

export function renderFrame(
  turn: Turn,
  target: Target,
  config: FleeceConfig,
  options: FrameOptions,
): string {
  const width = Math.max(24, options.width);
  const inner = width - 2;
  const textWidth = inner - 2;
  const body = bodyLines(turn, config, textWidth);

  const visible = options.height ? Math.max(1, options.height - CHROME_ROWS) : body.length;
  const maxScroll = Math.max(0, body.length - visible);
  const scroll = Math.min(Math.max(0, options.scroll ?? 0), maxScroll);
  const slice = body.slice(scroll, scroll + visible);
  while (slice.length < visible) slice.push("");

  const lines: string[] = [];
  lines.push(header(width, meta(turn, target)));
  for (const line of slice) lines.push(`${dim("│")} ${pad(line, textWidth)} ${dim("│")}`);
  lines.push(dim(`├${"─".repeat(inner)}┤`));
  const bar = actionBar(options.status, options.note, scroll, maxScroll, textWidth);
  lines.push(`${dim("│")} ${pad(bar, textWidth)} ${dim("│")}`);
  lines.push(dim(`└${"─".repeat(inner)}┘`));
  return lines.join("\n");
}

/** The same box with a centred message, for when there is nothing to frame. */
export function renderMessage(width: number, height: number, message: string): string {
  const inner = Math.max(24, width) - 2;
  const textWidth = inner - 2;
  const body = Math.max(1, height - CHROME_ROWS);
  const text = clip(message, textWidth);
  const middle = Math.floor((body - 1) / 2);

  const lines: string[] = [header(Math.max(24, width), "")];
  for (let row = 0; row < body; row++) {
    const content = row === middle ? centre(text, textWidth) : "";
    lines.push(`${dim("│")} ${pad(dim(content), textWidth)} ${dim("│")}`);
  }
  lines.push(dim(`├${"─".repeat(inner)}┤`));
  lines.push(`${dim("│")} ${pad(dim("q close"), textWidth)} ${dim("│")}`);
  lines.push(dim(`└${"─".repeat(inner)}┘`));
  return lines.join("\n");
}

/**
 * The prompt and the rendered answer, and nothing else.
 *
 * There is deliberately no tool-use footer. Which tools ran is session
 * metadata: it is already in the agent pane, it is the first thing to go stale,
 * and in a frame you opened to read an answer it is noise between you and the
 * last paragraph. The header still carries the facts worth keeping — model,
 * turn, duration, tokens, branch.
 */
export function bodyLines(turn: Turn, config: FleeceConfig, width: number): string[] {
  const out: string[] = [];

  if (config.includePrompt && turn.prompt !== "") {
    for (const line of wrap(firstLines(turn.prompt, 3), width - 2)) {
      out.push(dim(`❯ ${line}`));
    }
    out.push("");
  }

  out.push(...renderMarkdown(turn.text === "" ? "(no text in this answer)" : turn.text, width));
  return out;
}

function header(width: number, label: string): string {
  const head = "┌─ Fleece ";
  // The label is surrounded by "── " and a space, and still has to leave a dash
  // of rule and the closing "┐". Clipping to less than that overflows the box.
  const room = width - head.length - 6;
  const middle = room >= 6 ? `── ${clip(label, room)} ` : "";
  const fill = Math.max(1, width - head.length - displayWidth(middle) - 1);
  return dim(`${head}${middle}${"─".repeat(fill)}┐`);
}

function meta(turn: Turn, target: Target): string {
  const bits: string[] = [];
  if (turn.model) bits.push(turn.model);
  bits.push(`turn ${turn.index}`);
  if (turn.endedAt) bits.push(clockOf(turn.endedAt));
  if (turn.durationMs !== undefined) bits.push(duration(turn.durationMs));
  if (turn.usage.input || turn.usage.output) {
    bits.push(`${tokens(turn.usage.input)}↑ ${tokens(turn.usage.output)}↓`);
  }
  if (turn.gitBranch) bits.push(turn.gitBranch);
  else if (target.cwd) bits.push(target.cwd.split("/").pop() ?? "");
  return stripControls(bits.filter((bit) => bit !== "").join(" · "));
}

/** Keys on the left, scroll position or a status note on the right. */
function actionBar(
  status: string | undefined,
  note: string | undefined,
  scroll: number,
  maxScroll: number,
  width: number,
): string {
  if (status) return bold(clip(status, width));

  const right = note ?? (maxScroll > 0 ? `${Math.round((scroll / maxScroll) * 100)}%` : "");
  const rightWidth = displayWidth(right);
  const keys = clip(
    "y copy · c code · m save · j/k scroll · q close",
    Math.max(0, width - rightWidth - 2),
  );
  const gap = Math.max(1, width - displayWidth(keys) - rightWidth);
  return dim(keys + " ".repeat(gap) + right);
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function tokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

function clockOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function firstLines(text: string, count: number): string {
  const lines = text.split("\n");
  if (lines.length <= count) return text;
  return `${lines.slice(0, count).join("\n")} …`;
}

function centre(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
  return " ".repeat(left) + text;
}
