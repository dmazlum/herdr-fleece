import { loadConfig, type FleeceConfig } from "./config.js";
import { resolveTerminal } from "./core.js";
import { copyToClipboard } from "./export/clipboard.js";
import { codeOnly } from "./export/code.js";
import { buildMarkdown, saveMarkdown } from "./export/markdown.js";
import { launch, openArgs } from "./export/opener.js";
import { extractItems } from "./extract.js";
import { journalSummary, journalTurns } from "./journal.js";
import { pickKeys } from "./keys.js";
import { claudeProjectsDir } from "./resolve.js";
import { readTurns } from "./transcript/claude.js";
import type { Target, Turn } from "./transcript/types.js";
import { answers, windowLabel, windowOf } from "./window.js";

/**
 * The Herdr desktop app's side of Fleece. A mod is sandboxed JavaScript with no
 * Node APIs, so it runs this through `exec("node", [engine, ...])` and reads
 * one JSON object back. Everything that touches the transcript, the clipboard
 * or the disk stays here, in the same code the Herdr plugin uses.
 */

class EngineError extends Error {}

interface Flags {
  terminal?: string;
  turn?: number;
  pin?: number;
  text?: string;
  target?: string;
  code: boolean;
  full: boolean;
  link: boolean;
  journal: boolean;
}

type Reply = Record<string, unknown>;

async function main(): Promise<Reply> {
  const [command = "", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const config = loadConfig(true);

  switch (command) {
    case "state":
      return state(flags, config);
    case "copy":
      return copy(flags, config);
    case "clip":
      return clip(flags);
    case "save":
      return save(flags, config);
    case "journal":
      return journal(flags, config);
    case "open":
      return open(flags, config);
    case "doctor":
      return doctor(flags, config);
    default:
      throw new EngineError(`unknown command "${command}"`);
  }
}

/** Everything the dock and the frame draw: one window of answers and its items. */
async function state(flags: Flags, config: FleeceConfig): Promise<Reply> {
  const { target, turns } = await load(flags);
  const pinned = flags.pin ?? null;
  const window = windowOf(turns, pinned);
  const turn = window.at(-1);

  const picks = pickKeys(config.keys);
  const items = extractItems(window, { turns: config.dockTurns, cwd: target.cwd }).map(
    (item, index) => ({ ...item, key: picks[index] }),
  );

  const reply: Reply = {
    ok: true,
    target,
    answers: answers(turns).map((entry) => entry.index),
    pinned: pinned !== null && turn && turn.index !== answers(turns).at(-1)?.index ? pinned : null,
    label: windowLabel(turns, pinned, config.dockTurns),
    turn: turn ? view(turn) : null,
    items,
    keys: config.keys,
    exportDir: config.exportDir,
  };

  // Journal on the dock's refresh rather than in a daemon: an answer that has
  // landed is written the next time anyone looks, and twice is a no-op.
  if (flags.journal && config.journal) {
    reply.journal = journalSummary(journalTurns(turns, target, config)) ?? null;
  }
  return reply;
}

async function copy(flags: Flags, config: FleeceConfig): Promise<Reply> {
  const { target, turns } = await load(flags);
  const turn = pickTurn(turns, flags.turn);
  const text = flags.code
    ? codeOnly(turn.text)
    : flags.full
      ? buildMarkdown(turn, target, config)
      : turn.text;
  if (text.trim() === "") {
    throw new EngineError(flags.code ? "no code blocks in that answer" : "that answer has no text");
  }
  await toClipboard(text);
  return { ok: true, message: `copied ${flags.code ? "code" : "answer"} · turn ${turn.index}` };
}

async function clip(flags: Flags): Promise<Reply> {
  if (flags.text === undefined || flags.text === "") throw new EngineError("nothing to copy");
  await toClipboard(flags.text);
  return { ok: true, message: "copied" };
}

async function save(flags: Flags, config: FleeceConfig): Promise<Reply> {
  const { target, turns } = await load(flags);
  const turn = pickTurn(turns, flags.turn);
  const path = await saveMarkdown(turn, target, config);
  return { ok: true, path, message: `saved turn ${turn.index}` };
}

async function journal(flags: Flags, config: FleeceConfig): Promise<Reply> {
  const { target, turns } = await load(flags);
  const result = journalTurns(turns, target, config);
  const message =
    `${result.written.length} written · ${result.skipped} already there` +
    (result.failed > 0 ? ` · ${result.failed} failed` : "");
  return { ok: true, message, exportDir: config.exportDir };
}

async function open(flags: Flags, config: FleeceConfig): Promise<Reply> {
  if (!flags.target) throw new EngineError("nothing to open");
  const argv = openArgs(flags.target, { link: flags.link, command: config.openCommand });
  if (!argv) throw new EngineError("no system opener on this platform");
  await launch(argv);
  return { ok: true, message: `opened ${flags.target}` };
}

/** What Fleece resolves for a terminal, without failing on a missing piece. */
async function doctor(flags: Flags, config: FleeceConfig): Promise<Reply> {
  const lines: [string, string][] = [
    ["export dir", config.exportDir],
    ["claude projects", claudeProjectsDir()],
  ];
  for (const problem of config.keyProblems) lines.push(["keys", `IGNORED: ${problem}`]);
  try {
    const target = await resolveTerminal(requireTerminal(flags));
    lines.push(["terminal", target.paneId], ["agent", target.agent]);
    lines.push(["session", target.sessionId ?? "(none)"], ["cwd", target.cwd ?? "(unknown)"]);
    lines.push(["transcript", target.transcriptPath ?? "(not found)"]);
    if (target.transcriptPath) {
      const turns = readTurns(target.transcriptPath);
      lines.push(["turns", `${turns.length} (${answers(turns).length} with an answer)`]);
    }
  } catch (err) {
    lines.push(["resolve", `FAILED: ${message(err)}`]);
  }
  return { ok: true, lines };
}

async function load(flags: Flags): Promise<{ target: Target; turns: Turn[] }> {
  const target = await resolveTerminal(requireTerminal(flags));
  if (target.agent !== "claude") {
    throw new EngineError(`agent "${target.agent}" is not supported yet — Fleece reads Claude Code`);
  }
  if (!target.transcriptPath) {
    throw new EngineError(`no Claude transcript for ${target.paneId} under ${claudeProjectsDir()}`);
  }
  return { target, turns: readTurns(target.transcriptPath) };
}

function requireTerminal(flags: Flags): string {
  if (!flags.terminal) throw new EngineError("--terminal is required");
  return flags.terminal;
}

function pickTurn(turns: Turn[], requested?: number): Turn {
  if (requested !== undefined) {
    const turn = turns[requested - 1];
    if (!turn) throw new EngineError(`turn ${requested} does not exist (${turns.length} turns)`);
    return turn;
  }
  const latest = answers(turns).at(-1);
  if (!latest) throw new EngineError("this session has no answer yet");
  return latest;
}

/** The frame's share of a turn: no thinking, no usage, nothing it does not draw. */
function view(turn: Turn): Reply {
  return {
    index: turn.index,
    prompt: turn.prompt,
    text: turn.text,
    model: turn.model ?? null,
    endedAt: turn.endedAt ?? null,
    files: turn.files.length,
  };
}

async function toClipboard(text: string): Promise<void> {
  const result = await copyToClipboard(text);
  if (!result.tool) throw new EngineError("no clipboard tool — install pbcopy, wl-copy or xclip");
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { code: false, full: false, link: false, journal: false };
  const number = (value: string | undefined, name: string): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) throw new EngineError(`${name} needs a positive number`);
    return parsed;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--terminal":
        flags.terminal = args[++i];
        break;
      case "--turn":
        flags.turn = number(args[++i], "--turn");
        break;
      case "--pin":
        flags.pin = number(args[++i], "--pin");
        break;
      case "--text":
        flags.text = args[++i];
        break;
      case "--target":
        flags.target = args[++i];
        break;
      case "--code":
        flags.code = true;
        break;
      case "--full":
        flags.full = true;
        break;
      case "--link":
        flags.link = true;
        break;
      case "--journal":
        flags.journal = true;
        break;
      default:
        throw new EngineError(`unknown flag "${arg}"`);
    }
  }
  return flags;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main()
  .then((reply) => process.stdout.write(`${JSON.stringify(reply)}\n`))
  .catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message(err) })}\n`);
    process.exitCode = 1;
  });
