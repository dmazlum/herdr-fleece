/** Terminal text measurement and wrapping, independent of any styling. */

export const ESC = String.fromCharCode(27);
export const RESET = `${ESC}[0m`;
export const COLOR = process.env.NO_COLOR === undefined;

/**
 * Bytes a terminal would treat as commands rather than text.
 *
 * Tab and newline stay: they are layout, not control. Everything else in C0
 * and C1 goes, including ESC, BEL and CR. That is what stops an answer from
 * rewriting the clipboard via OSC 52, or from closing a bracketed paste so
 * the next newline becomes Enter.
 */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function stripControls(text: string): string {
  return text.replace(CONTROLS, "");
}

export function dim(text: string): string {
  return COLOR ? `${ESC}[2m${text}${RESET}` : text;
}

export function bold(text: string): string {
  return COLOR ? `${ESC}[1m${text}${RESET}` : text;
}

/** Display width, ignoring ANSI escapes and counting wide glyphs as two cells. */
export function displayWidth(text: string): number {
  let width = 0;
  let inEscape = false;
  for (const char of text) {
    if (inEscape) {
      if (/[A-Za-z]/.test(char)) inEscape = false;
      continue;
    }
    if (char === ESC) {
      inEscape = true;
      continue;
    }
    width += charWidth(char);
  }
  return width;
}

/** Truncates to a display width, never splitting a wide glyph across the edge. */
export function clip(text: string, width: number): string {
  let used = 0;
  let out = "";
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > width) break;
    out += char;
    used += w;
  }
  return out;
}

export function pad(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

export function padStart(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? " ".repeat(gap) + text : text;
}

/** Greedy word wrap by display width; a word longer than the line is split. */
export function wrap(text: string, width: number): string[] {
  text = stripControls(text);
  if (width < 4) return text.split("\n");
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) {
      out.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (displayWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line !== "") {
        out.push(line);
        line = "";
      }
      let rest = word;
      while (displayWidth(rest) > width) {
        const head = clip(rest, width);
        out.push(head);
        rest = rest.slice(head.length);
      }
      line = rest;
    }
    if (line !== "") out.push(line);
  }

  return out;
}

export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  // Combining marks and joiners sit on the previous glyph.
  if (code >= 0x0300 && code <= 0x036f) return 0;
  if (code === 0xfe0f || code === 0x200d) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}
