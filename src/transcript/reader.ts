import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";
import type { Turn } from "./types.js";

/**
 * Reads an agent's JSONL transcript incrementally. Everything here is agent
 * neutral: it splits bytes into lines, parses each as JSON, and hands the
 * record to a parser that knows what one agent's records mean. A truncated
 * trailing line is normal while a session is live, so it is held back until
 * the rest arrives.
 */

/** Turns one agent's records into turns. One instance per transcript read. */
export interface TurnParser {
  /** Consumes one parsed JSON record. Unknown shapes must be ignored, not thrown on. */
  ingest(record: unknown): void;
  /** The turns so far, the open one finished on a copy. Must not disturb parser state. */
  snapshot(): Turn[];
}

export type ParserFactory = () => TurnParser;

export interface TranscriptCursor {
  /** Bytes already read from the file, including an incomplete trailing line. */
  offset: number;
  pending: Buffer;
  parser: TurnParser;
  ino: number;
  dev: number;
  mtimeMs: number;
  prefix: Buffer;
}

const PREFIX_BYTES = 32;

export function emptyCursor(parser: TurnParser): TranscriptCursor {
  return {
    offset: 0,
    pending: Buffer.alloc(0),
    parser,
    ino: 0,
    dev: 0,
    mtimeMs: 0,
    prefix: Buffer.alloc(0),
  };
}

/**
 * Continues a previous read when the transcript has only grown. A shrink or
 * rewrite starts over. The dock calls this on every refresh so a long session
 * is not re-parsed from byte zero each time.
 */
export function readTurnsGrowing(
  path: string,
  createParser: ParserFactory,
  previous?: TranscriptCursor | null,
): { turns: Turn[]; cursor: TranscriptCursor } {
  const info = statSync(path);
  const cursor =
    previous && canContinue(previous, info, path) ? previous : emptyCursor(createParser());
  if (cursor.offset === info.size && cursor.pending.length === 0) {
    return { turns: cursor.parser.snapshot(), cursor };
  }

  const fd = openSync(path, "r");
  try {
    const length = info.size - cursor.offset;
    if (length > 0) {
      const chunk = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, chunk, read, length - read, cursor.offset + read);
        if (n === 0) break;
        read += n;
      }
      ingestBytes(cursor, chunk.subarray(0, read));
      cursor.offset += read;
    }
    flushPending(cursor);
    rememberFile(cursor, info, fd);
  } finally {
    closeSync(fd);
  }
  return { turns: cursor.parser.snapshot(), cursor };
}

/** Parses a whole transcript held in memory. */
export function parseTranscript(source: string, createParser: ParserFactory): Turn[] {
  const cursor = emptyCursor(createParser());
  ingestBytes(cursor, Buffer.from(source, "utf8"));
  flushPending(cursor);
  return cursor.parser.snapshot();
}

/** Keeps a cursor against one path so the dock does not hold parser state itself. */
export class TranscriptWatch {
  #cursor: TranscriptCursor | null = null;
  #path = "";
  readonly #createParser: ParserFactory;

  constructor(createParser: ParserFactory) {
    this.#createParser = createParser;
  }

  read(path: string, force = false): Turn[] {
    if (force || path !== this.#path) {
      this.#cursor = null;
      this.#path = path;
    }
    const loaded = readTurnsGrowing(path, this.#createParser, this.#cursor);
    this.#cursor = loaded.cursor;
    return loaded.turns;
  }

  reset(): void {
    this.#cursor = null;
    this.#path = "";
  }
}

function canContinue(previous: TranscriptCursor, info: Stats, path: string): boolean {
  if (previous.offset === 0) return true;
  if (info.size < previous.offset) return false;
  if (previous.ino !== 0 && (info.ino !== previous.ino || info.dev !== previous.dev)) return false;
  if (info.size === previous.offset && info.mtimeMs !== previous.mtimeMs) return false;
  if (previous.prefix.length === 0) return true;

  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(previous.prefix.length);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === previous.prefix.length && buf.equals(previous.prefix);
  } finally {
    closeSync(fd);
  }
}

function rememberFile(cursor: TranscriptCursor, info: Stats, fd: number): void {
  cursor.ino = info.ino;
  cursor.dev = info.dev;
  cursor.mtimeMs = info.mtimeMs;
  if (cursor.prefix.length > 0 || info.size === 0) return;
  const n = Math.min(PREFIX_BYTES, info.size);
  const buf = Buffer.alloc(n);
  if (readSync(fd, buf, 0, n, 0) === n) cursor.prefix = buf;
}

/** A final line without a newline is ingested only once it parses as complete JSON. */
function flushPending(cursor: TranscriptCursor): void {
  if (cursor.pending.length === 0) return;
  const line = cursor.pending.toString("utf8");
  if (line.trim() === "") {
    cursor.pending = Buffer.alloc(0);
    return;
  }
  const record = parseLine(line);
  if (record === undefined) return;
  cursor.parser.ingest(record);
  cursor.pending = Buffer.alloc(0);
}

function ingestBytes(cursor: TranscriptCursor, chunk: Buffer): void {
  const data = cursor.pending.length === 0 ? chunk : Buffer.concat([cursor.pending, chunk]);
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0x0a) continue;
    const record = parseLine(data.subarray(start, i).toString("utf8"));
    if (record !== undefined) cursor.parser.ingest(record);
    start = i + 1;
  }
  cursor.pending = start === 0 ? data : Buffer.from(data.subarray(start));
}

/** `undefined` for a blank or unparseable line; a truncated line is normal while live. */
function parseLine(line: string): unknown {
  if (line.trim() === "") return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
