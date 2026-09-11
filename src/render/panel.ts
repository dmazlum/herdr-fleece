import type { Item, ItemKind } from "../extract.js";
import { DEFAULT_KEYS, hintLines, type KeyBindings, pickKeys } from "../keys.js";
import { bold, clip, dim, displayWidth, pad, stripControls } from "./text.js";

/**
 * Rows the border and chrome consume, leaving the rest for the list: a header,
 * a rule, two hint rows and the footer. The hints get two rows because one row
 * of eight abbreviations reads as decoration, and the keys are the whole point
 * of a panel you drive without a mouse.
 */
export const PANEL_CHROME_ROWS = 5;

const SECTIONS: { kind: ItemKind; title: string }[] = [
  // Files lead: they are recorded fact, everything below is read out of prose.
  { kind: "file", title: "FILES" },
  { kind: "code", title: "CODE" },
  { kind: "command", title: "COMMANDS" },
  { kind: "path", title: "PATHS" },
  { kind: "link", title: "LINKS" },
];

export interface PanelOptions {
  width: number;
  height?: number;
  scroll?: number;
  /** Transient message, e.g. "copied 1.2 KB". */
  status?: string;
  /** Right-aligned note, e.g. "wC:p1 · live". */
  note?: string;
  /** Header label, e.g. "last 3 turns". */
  label?: string;
  /** Command bindings, which decide both the hints and the free pick keys. */
  keys?: KeyBindings;
}

/** Maps each pick key to its item, in the order the panel lists them. */
export function keyMap(items: Item[], keys: KeyBindings = DEFAULT_KEYS): Map<string, Item> {
  const map = new Map<string, Item>();
  const pick = pickKeys(keys);
  let index = 0;

  for (const section of SECTIONS) {
    for (const item of items.filter((entry) => entry.kind === section.kind)) {
      const key = pick[index];
      if (key === undefined) return map;
      map.set(key, item);
      index += 1;
    }
  }
  return map;
}

export function renderPanel(items: Item[], options: PanelOptions): string {
  const width = Math.max(24, options.width);
  const inner = width - 2;
  const textWidth = inner - 2;
  const body = items.length === 0 ? [dim("nothing to take away yet")] : listLines(items, textWidth);

  const visible = options.height ? Math.max(1, options.height - PANEL_CHROME_ROWS) : body.length;
  const maxScroll = Math.max(0, body.length - visible);
  const scroll = Math.min(Math.max(0, options.scroll ?? 0), maxScroll);
  const slice = body.slice(scroll, scroll + visible);
  while (slice.length < visible) slice.push("");

  const lines: string[] = [header(width, options.label ?? "")];
  for (const line of slice) lines.push(`${dim("│")} ${pad(line, textWidth)} ${dim("│")}`);
  lines.push(dim(`├${"─".repeat(inner)}┤`));
  for (const row of bars(options, scroll, maxScroll, textWidth)) {
    lines.push(`${dim("│")} ${pad(row, textWidth)} ${dim("│")}`);
  }
  lines.push(dim(`└${"─".repeat(inner)}┘`));
  return lines.join("\n");
}

export function listLines(items: Item[], width: number): string[] {
  const byItem = new Map<Item, string>();
  for (const [key, item] of keyMap(items)) byItem.set(item, key);

  const out: string[] = [];
  for (const section of SECTIONS) {
    const members = items.filter((entry) => entry.kind === section.kind);
    if (members.length === 0) continue;

    if (out.length > 0) out.push("");
    out.push(dim(section.title));
    for (const item of members) out.push(row(item, byItem.get(item), width));
  }
  return out;
}

function row(item: Item, key: string | undefined, width: number): string {
  const marker = key === undefined ? "   " : ` ${key} `;
  const tag = item.tag === undefined ? "" : `${pad(clip(stripControls(item.tag), 5), 5)} `;
  const detail = stripControls(item.detail ?? "");

  const fixed = displayWidth(marker) + displayWidth(tag);
  const room = Math.max(4, width - fixed - (detail === "" ? 0 : displayWidth(detail) + 2));
  const text = collapse(item.label);
  // A path's filename is the part you recognise, so drop the middle, not the end.
  const anchored = item.kind === "path" || item.kind === "file";
  const label = anchored ? shortenPath(text, room) : clip(text, room);

  const left = dim(marker) + (tag === "" ? "" : dim(tag)) + label;
  if (detail === "") return left;

  const gap = Math.max(1, width - displayWidth(left) - displayWidth(detail));
  return left + " ".repeat(gap) + dim(detail);
}

function collapse(text: string): string {
  return stripControls(text).replace(/\s+/g, " ").trim();
}

/** Keeps the head and the filename, eliding whole segments in between. */
export function shortenPath(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;

  const parts = text.split("/");
  const tail = parts[parts.length - 1] ?? text;
  if (parts.length < 3 || displayWidth(tail) + 2 >= width) {
    // Nothing to elide, so keep the end rather than the beginning.
    const kept = clip([...text].reverse().join(""), width - 1);
    return `…${[...kept].reverse().join("")}`;
  }

  // An absolute path's first segment is empty, and its slash is the head.
  const head = parts[0] === "" ? "/" : `${parts[0]!}/`;
  let out = `${head}…/${tail}`;
  for (let index = parts.length - 2; index > 0; index--) {
    const candidate = `${head}…/${parts.slice(index).join("/")}`;
    if (displayWidth(candidate) > width) break;
    out = candidate;
  }
  return displayWidth(out) <= width ? out : `…/${clip(tail, Math.max(1, width - 2))}`;
}

function header(width: number, label: string): string {
  const head = "┌─ Fleece ";
  // The label is surrounded by "── " and a space, and still has to leave a dash
  // of rule and the closing "┐". Clipping to less than that overflows the box.
  const room = width - head.length - 6;
  const middle = room >= 6 && label !== "" ? `── ${clip(label, room)} ` : "";
  const fill = Math.max(1, width - head.length - displayWidth(middle) - 1);
  return dim(`${head}${middle}${"─".repeat(fill)}┐`);
}

/**
 * Two rows: what to do with an item, then what to do with the answer. A status
 * takes the first row, where the eye already is, and leaves the second — so a
 * receipt never costs you the whole key reference.
 */
function bars(
  options: PanelOptions,
  scroll: number,
  maxScroll: number,
  width: number,
): [string, string] {
  const note = options.note ?? "";
  const percent = maxScroll > 0 ? `${Math.round((scroll / maxScroll) * 100)}%` : "";
  const hints = hintLines(options.keys ?? DEFAULT_KEYS, [
    width - displayWidth(note) - 2,
    width - displayWidth(percent) - 2,
  ]);

  const top = options.status
    ? bold(clip(options.status, width - displayWidth(note) - 2))
    : dim(hints[0]);

  return [align(top, note, width), align(dim(hints[1]), percent, width)];
}

function align(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
  return left + " ".repeat(gap) + dim(right);
}
