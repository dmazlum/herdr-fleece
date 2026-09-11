import { configPath, loadConfig, type FleeceConfig } from "./config.js";
import { copyToClipboard } from "./export/clipboard.js";
import { codeOnly } from "./export/code.js";
import { buildMarkdown, saveMarkdown } from "./export/markdown.js";
import { readDockState, writeFramePayload } from "./dockstate.js";
import {
  notify,
  openFrameOverlay,
  openPluginPane,
  paneClose,
  paneGet,
  paneLayout,
  paneResize,
} from "./herdr.js";
import { journalTurns } from "./journal.js";
import { COMMANDS } from "./keys.js";
import { renderFrame } from "./render/frame.js";
import { claudeProjectsDir, resolveTarget } from "./resolve.js";
import { readTurns } from "./transcript/claude.js";
import type { Target, Turn } from "./transcript/types.js";

class FleeceError extends Error {}

interface Flags {
  pane?: string;
  turn?: number;
  json: boolean;
  print: boolean;
  code: boolean;
  full: boolean;
}

const USAGE = `fleece — frame your agent's last answer, then copy, save or share it

  frame [--print] [--json]   open the framed answer in an overlay pane
  dock                       open a pane that follows the focused agent, or close it
  copy  [--code] [--full]    copy the answer to the clipboard
  save                       write the answer to the export directory
  journal                    write every answer of this session that is not saved yet
  doctor                     show what Fleece can see from here

  --turn N                   act on turn N instead of the latest answer
  --pane ID                  act on a specific pane instead of the focused one
`;

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case "frame":
      return frame(flags);
    case "dock":
      return dock(flags);
    case "copy":
      return copy(flags);
    case "save":
      return save(flags);
    case "journal":
      return journal(flags);
    case "doctor":
      return doctor(flags);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      throw new FleeceError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

async function frame(flags: Flags): Promise<void> {
  const { turn, target, config } = await load(flags);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ target, turn }, null, 2)}\n`);
    return;
  }
  if (flags.print) {
    const width = process.stdout.columns ?? 100;
    process.stdout.write(`${renderFrame(turn, target, config, { width })}\n`);
    return;
  }

  const payload = writeFramePayload({ turn, target });
  await openFrameOverlay(target.paneId, { FLEECE_PAYLOAD: payload });
}

/**
 * Opens the dock beside the focused agent, or closes the one already open.
 * The dock never takes focus — it is meant to sit there and keep up.
 */
async function dock(flags: Flags): Promise<void> {
  const open = readDockState();
  if (open && (await paneGet(open.paneId))) {
    await paneClose(open.paneId);
    process.stdout.write(`closed dock ${open.paneId}\n`);
    return;
  }

  const config = loadConfig();
  const target = await resolveTarget(flags.pane);
  await openPluginPane(
    "dock",
    { FLEECE_TARGET_PANE: target.paneId },
    { placement: "split", direction: "right", targetPaneId: target.paneId, focus: false },
  );
  await narrowDock(target.paneId, config.dockWidth);
  process.stdout.write(`dock opened beside ${target.paneId}\n`);
}

/**
 * A split opens at half the tab, which is far more than a list of items needs.
 * `--amount` shifts the split ratio, so the delta is worked out from the agent
 * pane alone — the dock has not necessarily finished starting up yet.
 */
async function narrowDock(agentPaneId: string, want: number): Promise<void> {
  const layout = await paneLayout(agentPaneId);
  const rect = layout?.panes.find((pane) => pane.pane_id === agentPaneId)?.rect;
  if (!layout || !rect) return;

  const area = layout.area.width;
  if (area <= want + 20) return; // Too narrow to be worth splitting further.

  const delta = (area - want - rect.width) / area;
  if (Math.abs(delta) < 0.02) return;

  try {
    await paneResize(agentPaneId, "right", Number(delta.toFixed(3)));
  } catch {
    // A layout Herdr will not resize is not worth failing the action over.
  }
}

async function copy(flags: Flags): Promise<void> {
  const { turn, target, config } = await load(flags);
  const text = flags.code
    ? codeOnly(turn.text)
    : flags.full
      ? buildMarkdown(turn, target, config)
      : turn.text;

  if (text.trim() === "") {
    throw new FleeceError(flags.code ? "no code blocks in that answer" : "that answer has no text");
  }

  const result = await copyToClipboard(text);
  if (!result.tool && !result.osc52) {
    throw new FleeceError("no clipboard available — install pbcopy, wl-copy or xclip");
  }

  const what = flags.code ? "code" : "answer";
  const summary = `copied ${what} · turn ${turn.index} · ${bytes(text)}`;
  await notify("Fleece", summary);
  process.stdout.write(`${summary}\n`);
}

async function save(flags: Flags): Promise<void> {
  const { turn, target, config } = await load(flags);
  const path = await saveMarkdown(turn, target, config);
  await notify("Fleece", `saved turn ${turn.index} → ${path}`);
  process.stdout.write(`${path}\n`);
}

/**
 * Catches the export directory up with the whole session, whether or not the
 * journal setting is on. Safe to run repeatedly: an answer already on disk is
 * left alone, so this is also how a session the dock never saw gets written.
 */
async function journal(flags: Flags): Promise<void> {
  const config = loadConfig();
  const target = await resolveTarget(flags.pane);
  if (!target.transcriptPath) throw new FleeceError("no transcript for that pane");

  const result = journalTurns(readTurns(target.transcriptPath), target, config);
  const summary =
    `${result.written.length} written · ${result.skipped} already there` +
    (result.failed > 0 ? ` · ${result.failed} failed` : "");

  await notify("Fleece", `journal: ${summary}`);
  process.stdout.write(`${config.exportDir}\n${summary}\n`);
}

/** Reports what Fleece resolves from here without failing on a missing piece. */
async function doctor(flags: Flags): Promise<void> {
  const config = loadConfig();
  const lines: string[] = [];

  lines.push(`herdr binary     ${process.env.HERDR_BIN_PATH ?? "herdr (from PATH)"}`);
  lines.push(`plugin config    ${configPath() ?? "(not running as a plugin)"}`);
  lines.push(`export dir       ${config.exportDir}`);
  lines.push(`claude projects  ${claudeProjectsDir()}`);
  lines.push(`dock keys        ${bindings(config)}`);
  for (const problem of config.keyProblems) lines.push(`  keys            IGNORED: ${problem}`);

  try {
    const target = await resolveTarget(flags.pane);
    lines.push(`pane             ${target.paneId}`);
    lines.push(`agent            ${target.agent}`);
    lines.push(`session          ${target.sessionId ?? "(none)"}`);
    lines.push(`cwd              ${target.cwd ?? "(unknown)"}`);
    lines.push(`transcript       ${target.transcriptPath ?? "(not found)"}`);

    if (target.transcriptPath) {
      const turns = readTurns(target.transcriptPath);
      const answered = turns.filter((entry) => entry.text !== "");
      lines.push(`turns            ${turns.length} (${answered.length} with an answer)`);
      const latest = answered.at(-1);
      if (latest) {
        lines.push(
          `latest answer    turn ${latest.index} · ${bytes(latest.text)} · ${latest.model ?? "?"}`,
        );
      }
    }
  } catch (err) {
    lines.push(`resolve          FAILED: ${message(err)}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function load(
  flags: Flags,
): Promise<{ turn: Turn; target: Target; config: FleeceConfig }> {
  const config = loadConfig();
  const target = await resolveTarget(flags.pane);

  if (!target.transcriptPath) {
    throw new FleeceError(
      target.agent === "claude"
        ? `no Claude transcript for session ${target.sessionId ?? "?"} under ${claudeProjectsDir()}`
        : `agent "${target.agent}" is not supported yet — Fleece 0.1.0 reads Claude Code only`,
    );
  }

  const turns = readTurns(target.transcriptPath);
  return { turn: pickTurn(turns, flags.turn), target, config };
}

/**
 * Without an explicit turn, the newest one that actually has text — while the
 * agent is mid-answer the latest turn is still empty.
 */
function pickTurn(turns: Turn[], requested?: number): Turn {
  if (requested !== undefined) {
    const turn = turns[requested - 1];
    if (!turn) throw new FleeceError(`turn ${requested} does not exist (${turns.length} turns)`);
    return turn;
  }
  const latest = turns.filter((turn) => turn.text !== "").at(-1);
  if (!latest) throw new FleeceError("this session has no answer to frame yet");
  return latest;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { json: false, print: false, code: false, full: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        flags.json = true;
        break;
      case "--print":
        flags.print = true;
        break;
      case "--code":
        flags.code = true;
        break;
      case "--full":
        flags.full = true;
        break;
      case "--turn": {
        const value = Number.parseInt(args[++i] ?? "", 10);
        if (!Number.isFinite(value) || value < 1) {
          throw new FleeceError("--turn needs a positive number");
        }
        flags.turn = value;
        break;
      }
      case "--pane":
        flags.pane = args[++i];
        break;
      default:
        throw new FleeceError(`unknown flag "${arg}"`);
    }
  }
  return flags;
}

/** The effective dock bindings, so a config that was ignored is visible. */
function bindings(config: FleeceConfig): string {
  return COMMANDS.map((command) => {
    const key = config.keys[command];
    return `${command}=${key === " " ? "space" : key}`;
  }).join(" ");
}

function bytes(text: string): string {
  const size = Buffer.byteLength(text, "utf8");
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch(async (err) => {
  const text = message(err);
  process.stderr.write(`fleece: ${text}\n`);
  // Headless actions have no visible stdout, so the toast is the real feedback.
  await notify("Fleece failed", text);
  process.exitCode = 1;
});
