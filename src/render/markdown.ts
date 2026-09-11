import { clip, COLOR, dim, displayWidth, ESC, pad, padStart, RESET, stripControls } from "./text.js";

/**
 * A terminal Markdown renderer for answers.
 *
 * Styling is display-only: `fleece copy` and `fleece save` always use the raw
 * Markdown, so nothing here can lose information from an export. Text is kept
 * as styled spans until the last moment, because wrapping has to measure the
 * characters the reader sees rather than the escape sequences around them.
 */

export interface Style {
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
}

export interface Span {
  text: string;
  style: Style;
}

type Align = "left" | "center" | "right";

type Kind = "heading" | "rule" | "list" | "code" | "quote" | "table" | "text";

/**
 * Markdown puts a blank line between every block, which costs about a third of
 * a narrow pane's height. Blank source lines are treated as a request for
 * separation rather than a literal row, and headings and rules provide their
 * own, so nothing is doubled up.
 */
function separates(previous: Kind, next: Kind): boolean {
  if (previous === "heading" || previous === "rule") return false;
  if (next === "rule") return false;
  if (previous === "list" && next === "list") return false;
  return true;
}

export function renderMarkdown(text: string, width: number): string[] {
  const lines = stripControls(text).split("\n");
  const out: string[] = [];
  let index = 0;
  let pendingBlank = false;
  let previous: Kind | null = null;

  const emit = (block: string[], kind: Kind): void => {
    if (block.length === 0) return;
    if (pendingBlank && previous !== null && separates(previous, kind)) out.push("");
    pendingBlank = false;
    out.push(...block);
    previous = kind;
  };

  while (index < lines.length) {
    const line = lines[index]!;

    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const block: string[] = [];
      index = emitFence(lines, index, fence[1]!, width, block);
      emit(block, "code");
      continue;
    }

    if (line.trim() === "") {
      pendingBlank = true;
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      emit([dim("─".repeat(Math.max(1, width)))], "rule");
      index += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const style: Style = level <= 2 ? { bold: true } : { bold: true, dim: true };
      emit(wrapSpans(parseInline(heading[2]!, style), width), "heading");
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const source: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index]!)) {
        source.push(lines[index]!.replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      const inner = renderMarkdown(source.join("\n"), Math.max(4, width - 2));
      emit(
        inner.map((entry) => dim("│ ") + entry),
        "quote",
      );
      continue;
    }

    if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1]!)) {
      const source: string[] = [];
      while (index < lines.length && isTableRow(lines[index]!)) {
        source.push(lines[index]!);
        index += 1;
      }
      emit(renderTable(source, width), "table");
      continue;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const lead = " ".repeat(Math.min(item[1]!.length, Math.max(0, width - 8)));
      const marker = /^[-*+]$/.test(item[2]!) ? "•" : item[2]!;
      const prefix = `${lead}${marker} `;
      const body = wrapSpans(parseInline(item[3]!), Math.max(4, width - displayWidth(prefix)));
      emit(
        body.map((entry, position) =>
          position === 0 ? dim(prefix) + entry : " ".repeat(displayWidth(prefix)) + entry,
        ),
        "list",
      );
      index += 1;
      continue;
    }

    emit(wrapSpans(parseInline(line), width), "text");
    index += 1;
  }

  return out;
}

/* ------------------------------------------------------------------ inline */

export function parseInline(text: string, base: Style = {}): Span[] {
  const spans: Span[] = [];
  let literal = "";
  let index = 0;

  const flush = (): void => {
    if (literal !== "") {
      spans.push({ text: literal, style: base });
      literal = "";
    }
  };

  while (index < text.length) {
    const char = text[index]!;

    if (char === "\\" && index + 1 < text.length) {
      literal += text[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      const ticks = runLength(text, index, "`");
      const end = findTicks(text, index + ticks, ticks);
      if (end >= 0) {
        flush();
        spans.push({ text: text.slice(index + ticks, end).trim(), style: { ...base, code: true } });
        index = end + ticks;
        continue;
      }
    }

    if (char === "[") {
      const link = parseLink(text, index);
      if (link) {
        flush();
        spans.push(...parseInline(link.label, { ...base, underline: true }));
        if (link.url !== "") spans.push({ text: ` (${link.url})`, style: { ...base, dim: true } });
        index = link.end;
        continue;
      }
    }

    const opener = emphasisAt(text, index);
    if (opener) {
      const end = findEmphasisClose(text, index + opener.marker.length, opener.marker);
      if (end >= 0) {
        flush();
        const inner = text.slice(index + opener.marker.length, end);
        spans.push(...parseInline(inner, { ...base, ...opener.style }));
        index = end + opener.marker.length;
        continue;
      }
    }

    literal += char;
    index += 1;
  }

  flush();
  return spans;
}

interface Emphasis {
  marker: string;
  style: Style;
}

/**
 * Underscores never open emphasis inside a word, so `pane_id` and
 * `HERDR_PANE_ID` survive intact. Every marker must hug its content, which
 * keeps arithmetic like `2 * 3 * 4` out of the parser.
 */
function emphasisAt(text: string, index: number): Emphasis | null {
  const two = text.slice(index, index + 2);
  const one = text[index]!;
  const before = index === 0 ? "" : text[index - 1]!;

  if (two === "~~") {
    return flanking(text, index, 2) ? { marker: "~~", style: { strike: true } } : null;
  }
  if (two === "**") {
    return flanking(text, index, 2) ? { marker: "**", style: { bold: true } } : null;
  }
  if (two === "__") {
    if (isWordChar(before)) return null;
    return flanking(text, index, 2) ? { marker: "__", style: { bold: true } } : null;
  }
  if (one === "*") {
    return flanking(text, index, 1) ? { marker: "*", style: { italic: true } } : null;
  }
  if (one === "_") {
    if (isWordChar(before)) return null;
    return flanking(text, index, 1) ? { marker: "_", style: { italic: true } } : null;
  }
  return null;
}

function flanking(text: string, index: number, length: number): boolean {
  const next = text[index + length];
  return next !== undefined && !/\s/.test(next);
}

function findEmphasisClose(text: string, from: number, marker: string): number {
  for (let index = from; index <= text.length - marker.length; index++) {
    if (text[index - 1] === "\\") continue;
    if (text.slice(index, index + marker.length) !== marker) continue;
    if (index === from) continue;

    const before = text[index - 1];
    if (before === undefined || /\s/.test(before)) continue;

    // A closing underscore must not sit inside a word either.
    if (marker.startsWith("_") && isWordChar(text[index + marker.length] ?? "")) continue;
    return index;
  }
  return -1;
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9]/.test(char);
}

function runLength(text: string, index: number, char: string): number {
  let length = 0;
  while (text[index + length] === char) length += 1;
  return length;
}

function findTicks(text: string, from: number, count: number): number {
  for (let index = from; index <= text.length - count; index++) {
    if (text[index] !== "`") continue;
    if (runLength(text, index, "`") !== count) continue;
    return index;
  }
  return -1;
}

interface Link {
  label: string;
  url: string;
  end: number;
}

function parseLink(text: string, index: number): Link | null {
  let depth = 0;
  let close = -1;
  for (let scan = index; scan < text.length; scan++) {
    if (text[scan] === "[") depth += 1;
    else if (text[scan] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = scan;
        break;
      }
    }
  }
  if (close < 0 || text[close + 1] !== "(") return null;

  const end = text.indexOf(")", close + 2);
  if (end < 0) return null;

  return {
    label: text.slice(index + 1, close),
    url: text.slice(close + 2, end).split(/\s+/)[0] ?? "",
    end: end + 1,
  };
}

/* ----------------------------------------------------------------- styling */

function codes(style: Style): string {
  if (!COLOR) return "";
  const parts: number[] = [];
  if (style.bold) parts.push(1);
  if (style.dim) parts.push(2);
  if (style.italic) parts.push(3);
  if (style.underline) parts.push(4);
  if (style.strike) parts.push(9);
  if (style.code) parts.push(36);
  return parts.length === 0 ? "" : `${ESC}[${parts.join(";")}m`;
}

const STYLE_KEYS = ["bold", "italic", "dim", "underline", "strike", "code"] as const;

function sameStyle(left: Style, right: Style): boolean {
  return STYLE_KEYS.every((key) => (left[key] ?? false) === (right[key] ?? false));
}

/**
 * Wrapping splits text into words and spaces, so runs are coalesced here:
 * one escape sequence per styled stretch rather than one per word.
 */
export function renderSpans(spans: Span[]): string {
  let out = "";
  let buffer = "";
  let style: Style = {};

  const flush = (): void => {
    if (buffer === "") return;
    const code = codes(style);
    out += code === "" ? buffer : `${code}${buffer}${RESET}`;
    buffer = "";
  };

  for (const span of spans) {
    if (span.text === "") continue;
    if (buffer !== "" && !sameStyle(style, span.style)) flush();
    style = span.style;
    buffer += span.text;
  }
  flush();
  return out;
}

/** Wraps styled spans, measuring only the characters the reader sees. */
export function wrapSpans(spans: Span[], width: number): string[] {
  if (width < 4) return [renderSpans(spans)];

  const tokens: Span[] = [];
  for (const span of spans) {
    for (const piece of span.text.split(/(\s+)/)) {
      if (piece !== "") tokens.push({ text: piece, style: span.style });
    }
  }

  const lines: string[] = [];
  let current: Span[] = [];
  let used = 0;

  const push = (): void => {
    while (current.length > 0 && /^\s+$/.test(current[current.length - 1]!.text)) current.pop();
    lines.push(renderSpans(current));
    current = [];
    used = 0;
  };

  for (const token of tokens) {
    if (/^\s+$/.test(token.text)) {
      if (current.length === 0 || used + 1 > width) continue;
      current.push({ text: " ", style: token.style });
      used += 1;
      continue;
    }

    const tokenWidth = displayWidth(token.text);
    if (used + tokenWidth <= width) {
      current.push(token);
      used += tokenWidth;
      continue;
    }

    if (current.length > 0) push();

    let rest = token.text;
    while (displayWidth(rest) > width) {
      const head = clip(rest, width);
      if (head === "") break;
      current.push({ text: head, style: token.style });
      push();
      rest = rest.slice(head.length);
    }
    if (rest !== "") {
      current.push({ text: rest, style: token.style });
      used = displayWidth(rest);
    }
  }

  if (current.length > 0 || lines.length === 0) push();
  return lines;
}

/* ------------------------------------------------------------------ blocks */

function emitFence(
  lines: string[],
  start: number,
  fence: string,
  width: number,
  out: string[],
): number {
  const char = fence.charAt(0);
  const inner = Math.max(0, width - 2);
  out.push(dim(`│ ${clip(lines[start]!.trim(), inner)}`));

  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    const isClose = trimmed.length >= fence.length && trimmed.split("").every((ch) => ch === char);

    // Code must not be re-wrapped: a broken line is a broken paste.
    out.push(dim(`│ ${clip(isClose ? trimmed : line, inner)}`));
    index += 1;
    if (isClose) break;
  }
  return index;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.indexOf("|", 1) > 0;
}

function isTableDivider(line: string): boolean {
  if (!isTableRow(line)) return false;
  const parts = cells(line);
  return parts.length > 0 && parts.every((part) => /^:?-+:?$/.test(part));
}

function cells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

/**
 * Lays a pipe table out in columns. Cells wrap rather than truncate, so a
 * narrow dock still shows every value; a table that cannot fit at all falls
 * back to its raw Markdown.
 */
function renderTable(block: string[], width: number): string[] {
  const header = cells(block[0]!);
  const aligns = cells(block[1]!).map(alignOf);
  const rows = block.slice(2).map(cells);
  const columns = header.length;
  const gap = 3;

  const minimum = columns * 4 + (columns - 1) * gap;
  if (columns < 2 || width < minimum) {
    return block.flatMap((line) => wrapSpans(parseInline(line), width));
  }

  const natural = header.map((cell, column) =>
    Math.max(
      displayWidth(plain(cell)),
      ...rows.map((entry) => displayWidth(plain(entry[column] ?? ""))),
    ),
  );

  const widths = fit(natural, width - (columns - 1) * gap);
  const body = rows.map((entry) => row(entry, widths, aligns, {}));
  // Once any row needs two lines you cannot see where one ends, so rule them off.
  const ruled = body.some((entry) => entry.length > 1);
  const divider = dim(widths.map((size) => "─".repeat(size)).join("─┼─"));

  const out: string[] = [];
  out.push(...row(header, widths, aligns, { bold: true }));
  out.push(divider);
  body.forEach((entry, position) => {
    if (ruled && position > 0) out.push(divider);
    out.push(...entry);
  });
  return out;
}

/** Shrinks the widest columns first, so narrow columns keep their content. */
function fit(natural: number[], available: number): number[] {
  const widths = [...natural];
  let total = widths.reduce((sum, value) => sum + value, 0);

  while (total > available) {
    let widest = 0;
    for (let column = 1; column < widths.length; column++) {
      if (widths[column]! > widths[widest]!) widest = column;
    }
    if (widths[widest]! <= 4) break;
    widths[widest] = widths[widest]! - 1;
    total -= 1;
  }
  return widths;
}

function row(values: string[], widths: number[], aligns: Align[], style: Style): string[] {
  const columns = widths.map((size, column) =>
    wrapSpans(parseInline(values[column] ?? "", style), size),
  );
  const height = Math.max(...columns.map((lines) => lines.length));
  const out: string[] = [];

  for (let line = 0; line < height; line++) {
    const parts = columns.map((lines, column) =>
      align(lines[line] ?? "", widths[column]!, aligns[column] ?? "left"),
    );
    out.push(parts.join(dim(" │ ")));
  }
  return out;
}

function align(text: string, width: number, how: Align): string {
  if (how === "right") return padStart(text, width);
  if (how === "center") {
    const left = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
    return pad(" ".repeat(left) + text, width);
  }
  return pad(text, width);
}

function alignOf(divider: string): Align {
  const left = divider.startsWith(":");
  const right = divider.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** The text a cell shows once its markup is gone, for measuring columns. */
function plain(cell: string): string {
  return parseInline(cell)
    .map((span) => span.text)
    .join("");
}
