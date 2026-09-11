import { statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "./build.js";
import { loadConfig } from "./config.js";
import { claimDock, releaseDock, writeFramePayload } from "./dockstate.js";
import { copyToClipboard } from "./export/clipboard.js";
import { saveMarkdown } from "./export/markdown.js";
import { extractItems, type Item } from "./extract.js";
import {
  agentGet,
  openFrameOverlay,
  paneCurrent,
  paneRect,
  paneSendText,
  type PaneRect,
} from "./herdr.js";
import { journalSummary, journalTurns } from "./journal.js";
import { keyMap, PANEL_CHROME_ROWS, renderPanel } from "./render/panel.js";
import { findClaudeTranscript } from "./resolve.js";
import { CLEAR, enterScreen, KEY, leaveScreen, onKeys, onResize, terminalSize } from "./screen.js";
import { subscribe, type EventStream, type HerdrEvent, type StreamState } from "./socket.js";
import { StatusLine } from "./status.js";
import { TranscriptWatch } from "./transcript/claude.js";
import type { Target, Turn } from "./transcript/types.js";
import { stepPin, windowLabel, windowOf } from "./window.js";

/**
 * A pane that follows the focused agent and lists what is worth carrying out of
 * its recent answers — code blocks, commands, paths and links, each one
 * keystroke from the clipboard.
 *
 * It deliberately does not re-render the answer itself: that is already on
 * screen in the agent pane, and duplicating it wastes half the window. Press
 * `o` when you do want the framed reader.
 */

const POLL_MS = 3000;
/**
 * Split-ratio changes emit no subscribable event, so the drawing area is
 * re-measured on a heartbeat. One `pane layout` call is cheap, and this also
 * covers a split the user drags by hand.
 */
const MEASURE_MS = 2000;
/** Herdr can report idle a moment before the transcript is flushed. */
const SETTLE_MS = [0, 300, 1200];

const config = loadConfig();
const selfPaneId = process.env.HERDR_PANE_ID ?? "";

let target: Target | null = null;
const transcript = new TranscriptWatch();
let turns: Turn[] = [];
let items: Item[] = [];
let transcriptStamp = "";
let streamState: StreamState = "lost";
let statusStream: EventStream | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let rect: PaneRect | null = null;
let drawnArea = "";
let scroll = 0;
/** Receipts fade on their own; the armed-send prompt is held until answered. */
const statusLine = new StatusLine(() => draw());
/**
 * Where `s` sends. The dock only ever *targets* agent panes, but the pane you
 * came from is as often a shell, so this tracks focus separately.
 */
let lastFocused = "";
/** True between pressing `s` and choosing the item it should send. */
let awaitingSend = false;
/**
 * The newest answered turn the panel is showing, by its own index, or null to
 * follow the session. Pinning by index rather than by a distance from the end
 * means a turn finishing while you read does not shift what you are looking at.
 */
let pinned: number | null = null;
/** What the last journal run wrote, waiting to be shown once. */
let journalNote: string | undefined;

/* ----------------------------------------------------------------- drawing */

/**
 * Neither source of truth is reliable on its own: a freshly split plugin pane
 * can report a PTY far wider than its rect, and after a ratio change the rect
 * can read a few columns wider than the PTY actually is. Drawing to the
 * smaller of the two is correct in both directions.
 */
function area(): { width: number; height: number } {
  const terminal = terminalSize();
  if (!rect) return terminal;
  return {
    width: Math.min(terminal.width, rect.width),
    height: Math.min(terminal.height, rect.height),
  };
}

/**
 * A pane keeps the modules it started with, so a rebuilt plugin keeps running
 * the old code until it is reopened. Saying so beats debugging a fix that is
 * already on disk. Measured on the same heartbeat as the pane rect rather than
 * on every redraw: it changes about as often, and far less often than a keypress.
 */
const DIST = dirname(fileURLToPath(import.meta.url));
const builtFrom = fingerprint(DIST);
let stale = false;

/** In a narrow dock the key hints are worth more columns than the pane id. */
function note(): string {
  if (stale) return "rebuilt · reopen";
  const state = streamState === "live" ? "live" : "polling";
  if (area().width < 64) return target ? state : "no target";
  return `${target ? target.paneId : "no target"} · ${state}`;
}

function windowTurns(): Turn[] {
  return windowOf(turns, pinned);
}

function label(): string {
  return windowLabel(turns, pinned, config.dockTurns);
}

function draw(): void {
  const { width, height } = area();
  drawnArea = `${width}x${height}`;
  process.stdout.write(
    CLEAR +
      renderPanel(items, {
        width,
        height,
        scroll,
        status: statusLine.value,
        note: note(),
        label: label(),
        keys: config.keys,
      }),
  );
}

/* ---------------------------------------------------------------- tracking */

/**
 * Herdr can hand a split plugin pane a PTY wider than the pane itself, so the
 * layout rect is the only trustworthy drawing area.
 */
async function measure(): Promise<void> {
  if (selfPaneId !== "") {
    const next = await paneRect(selfPaneId);
    if (next) rect = next;
  }
  // An empty fingerprint means the build could not be read, which is not proof
  // of anything; only a fingerprint that differs is.
  const outdated = builtFrom !== "" && fingerprint(DIST) !== builtFrom;
  const { width, height } = area();

  if (`${width}x${height}` !== drawnArea || outdated !== stale) {
    stale = outdated;
    draw();
  }
}

/** Points the dock at a pane, ignoring panes with no agent so the last list stays up. */
async function retarget(paneId: string, force = false): Promise<void> {
  if (paneId === selfPaneId) return;
  if (!force && paneId === target?.paneId) return;

  const pane = await agentGet(paneId);
  if (!pane?.agent) return;

  const sessionId = pane.agent_session?.value;
  const cwd = pane.cwd ?? pane.foreground_cwd;

  target = {
    paneId: pane.pane_id,
    agent: pane.agent,
    sessionId,
    cwd,
    title: pane.terminal_title_stripped,
    transcriptPath:
      pane.agent === "claude" && sessionId
        ? (findClaudeTranscript(sessionId, cwd) ?? undefined)
        : undefined,
  };

  transcriptStamp = "";
  transcript.reset();
  pinned = null; // A different agent's turn numbers mean nothing to the old pin.
  watchStatus();
  if (reload()) refresh();
  else draw();
}

/** Re-reads the transcript. Returns whether the listed items changed. */
function reload(force = false): boolean {
  if (!target?.transcriptPath) {
    const had = items.length > 0;
    transcript.reset();
    turns = [];
    items = [];
    return had;
  }

  let stamp: string;
  try {
    const info = statSync(target.transcriptPath);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    return false;
  }
  if (!force && stamp === transcriptStamp) return false;
  transcriptStamp = stamp;

  try {
    turns = transcript.read(target.transcriptPath, force);
  } catch {
    return false;
  }

  // The transcript just changed, which is exactly when there is a new answer
  // to write. Journalling is idempotent, so the repeat cost is a stat per turn.
  if (config.journal && target) {
    journalNote = journalSummary(journalTurns(turns, target, config));
  }

  return recompute();
}

/** Rebuilds the list from the turns already in memory. */
function recompute(): boolean {
  const next = extractItems(windowTurns(), { turns: config.dockTurns, cwd: target?.cwd });
  const changed = signature(next) !== signature(items);
  items = next;
  return changed;
}

function signature(list: Item[]): string {
  return list.map((item) => `${item.kind}:${item.text}`).join(" ");
}

function refresh(): void {
  scroll = 0;
  statusLine.clear();
  // A journal run is worth one fading receipt, not a permanent line.
  statusLine.show(journalNote);
  journalNote = undefined;
  draw();
}

/**
 * A finished turn can land in the transcript just after Herdr reports idle,
 * so retry briefly rather than showing a stale list until the next event.
 */
function reloadSoon(): void {
  for (const delay of SETTLE_MS) {
    const timer = setTimeout(() => {
      if (reload()) refresh();
    }, delay);
    timer.unref?.();
  }
}

/** `pane.agent_status_changed` requires a pane id, so this is re-opened on every retarget. */
function watchStatus(): void {
  statusStream?.close();
  statusStream = null;
  if (!target) return;

  statusStream = subscribe(
    [{ type: "pane.agent_status_changed", pane_id: target.paneId }],
    (event) => {
      if (event.kind !== "pane_agent_status_changed") return;
      const state = event.data["agent_status"];
      if (state === "idle" || state === "done") reloadSoon();
    },
  );
}

function onLifecycle(event: HerdrEvent): void {
  const paneId = typeof event.data["pane_id"] === "string" ? event.data["pane_id"] : undefined;
  if (!paneId) return;

  switch (event.kind) {
    case "pane_focused":
      if (paneId !== selfPaneId) lastFocused = paneId;
      void retarget(paneId);
      break;
    case "pane_created":
    case "pane_moved":
      void measure();
      break;
    case "pane_agent_detected":
      if (paneId === target?.paneId) void retarget(paneId, true);
      break;
    case "pane_closed":
      void measure();
      if (paneId === target?.paneId) {
        target = null;
        transcript.reset();
        turns = [];
        items = [];
        statusStream?.close();
        statusStream = null;
        refresh();
      }
      break;
    default:
      break;
  }
}

const focusStream = subscribe(
  [
    { type: "pane.focused" },
    { type: "pane.closed" },
    { type: "pane.created" },
    { type: "pane.moved" },
    { type: "pane.agent_detected" },
  ],
  onLifecycle,
  (state) => {
    const changed = state !== streamState;
    streamState = state;
    setPolling(state === "lost");
    if (changed) draw();
  },
);

function setPolling(on: boolean): void {
  if (on && !pollTimer) {
    pollTimer = setInterval(() => void poll(), POLL_MS);
    pollTimer.unref?.();
  } else if (!on && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function poll(): Promise<void> {
  try {
    const pane = await paneCurrent();
    if (pane.pane_id !== selfPaneId) await retarget(pane.pane_id);
  } catch {
    /* the server may be restarting */
  }
  await measure();
  if (reload()) refresh();
}

/* -------------------------------------------------------------------- keys */

async function onKey(key: string): Promise<void> {
  const page = Math.max(1, area().height - PANEL_CHROME_ROWS - 1);
  const limit = maxScroll();
  const keys = config.keys;
  statusLine.clear();
  let message: string | undefined;

  // The send key arms a pick, so the next key names an item, not a command.
  if (awaitingSend) {
    awaitingSend = false;
    if (key === KEY.ESCAPE || key === KEY.CTRL_C) {
      message = "send cancelled";
    } else {
      const item = keyMap(items, keys).get(key);
      message = item ? await send(item) : "send cancelled";
    }
    statusLine.show(message);
    draw();
    return;
  }

  // Escape and Ctrl+C are not bindable: a way out must always be there.
  if (key === KEY.ESCAPE || key === KEY.CTRL_C || key === keys.close) {
    quit();
  } else if (key === keys.down || key === KEY.DOWN) {
    scroll = Math.min(limit, scroll + 1);
  } else if (key === keys.up || key === KEY.UP) {
    scroll = Math.max(0, scroll - 1);
  } else if (key === keys["page-down"] || key === KEY.PAGE_DOWN) {
    scroll = Math.min(limit, scroll + page);
  } else if (key === KEY.PAGE_UP) {
    scroll = Math.max(0, scroll - page);
  } else if (key === keys.top) {
    scroll = 0;
  } else if (key === keys.bottom) {
    scroll = limit;
  } else if (key === keys.reload) {
    const changed = reload(true);
    message = journalNote ?? (changed ? "reloaded" : "no change");
    journalNote = undefined;
  } else if (key === keys.send) {
    message = arm();
  } else if (key === keys.older) {
    message = step(-1);
  } else if (key === keys.newer) {
    message = step(1);
  } else if (key === keys.frame) {
    message = await openFrame();
  } else if (key === keys["copy-answer"]) {
    message = await copyAnswer();
  } else if (key === keys.save) {
    message = await saveAnswer();
  } else {
    const item = keyMap(items, keys).get(key);
    if (item) message = await copy(item);
  }

  // An armed send is a question, not a receipt: it waits rather than expiring.
  if (message !== undefined && awaitingSend) statusLine.hold(message);
  else statusLine.show(message);

  draw();
}

function maxScroll(): number {
  const { width, height } = area();
  const total = renderPanel(items, { width, keys: config.keys }).split("\n").length -
    PANEL_CHROME_ROWS;
  return Math.max(0, total - Math.max(1, height - PANEL_CHROME_ROWS));
}

async function copy(item: Item): Promise<string> {
  const result = await copyToClipboard(item.text);
  if (!result.tool && !result.osc52) return "no clipboard available";
  const size = Buffer.byteLength(item.text, "utf8");
  const amount = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
  return `copied ${item.kind} · ${amount}`;
}

/**
 * Walks the scanned window back through the session, so an answer that has
 * scrolled out of reach is still one or two keystrokes away. Stepping forward
 * past the newest answer unpins and starts following the session again.
 */
function step(direction: -1 | 1): string {
  const result = stepPin(turns, pinned, direction);
  if (result.blocked) return result.blocked;

  pinned = result.pinned;
  recompute();
  scroll = 0;
  return pinned === null ? `live · ${label()}` : label();
}

/** The pane `s` will send to: wherever you were before you came to the dock. */
function destination(): string {
  return lastFocused !== "" ? lastFocused : (target?.paneId ?? "");
}

function arm(): string {
  if (items.length === 0) return "nothing to send";
  const where = destination();
  if (where === "") return "no pane to send to";
  awaitingSend = true;
  return `send → ${where} · pick an item, esc cancels`;
}

/**
 * Puts an item on another pane's prompt and stops there. The text is
 * bracketed-pasted, so even a multi-line block arrives as one edit rather than
 * as lines a shell would run; pressing Enter stays the reader's decision.
 */
async function send(item: Item): Promise<string> {
  const where = destination();
  if (where === "") return "no pane to send to";

  try {
    await paneSendText(where, item.text);
  } catch {
    return `could not send to ${where}`;
  }

  const lines = item.text.trim().split("\n").length;
  return `sent ${item.kind} → ${where}${lines > 1 ? ` · ${lines} lines` : ""}`;
}

/**
 * The answer `y`, `m` and `o` act on: the newest one in the window, which is
 * the pinned turn once you have paged back.
 */
function latestAnswer(): Turn | undefined {
  return windowTurns().at(-1);
}

/** The whole answer, for when the extracted pieces are not what you wanted. */
async function copyAnswer(): Promise<string> {
  const latest = latestAnswer();
  if (!latest) return "no answer yet";

  const result = await copyToClipboard(latest.text);
  if (!result.tool && !result.osc52) return "no clipboard available";
  const kb = (Buffer.byteLength(latest.text, "utf8") / 1024).toFixed(1);
  return `copied answer · turn ${latest.index} · ${kb} KB`;
}

async function saveAnswer(): Promise<string> {
  const latest = latestAnswer();
  if (!latest || !target) return "no answer yet";
  try {
    return `saved → ${await saveMarkdown(latest, target, config)}`;
  } catch (err) {
    return `save failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Hands the newest answer to the overlay, for when the list is not enough. */
async function openFrame(): Promise<string> {
  const latest = latestAnswer();
  if (!latest || !target) return "nothing to frame yet";

  try {
    const payload = writeFramePayload({ turn: latest, target });
    await openFrameOverlay(target.paneId, { FLEECE_PAYLOAD: payload });
    return "opened frame";
  } catch {
    return "could not open the frame";
  }
}

function quit(): never {
  leaveScreen();
  statusStream?.close();
  focusStream.close();
  releaseDock(selfPaneId);
  process.exit(0);
}

/* ------------------------------------------------------------------- start */

async function start(): Promise<void> {
  if (selfPaneId !== "") claimDock(selfPaneId);
  process.on("exit", () => releaseDock(selfPaneId));
  // `pane close` signals the process rather than letting it exit on its own.
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, () => {
      releaseDock(selfPaneId);
      process.exit(0);
    });
  }

  enterScreen();
  onKeys((key) => void onKey(key));
  onResize(() => void measure());
  // Lost is the initial state. A missing socket reports it again (no change),
  // and a socket that has not acked yet reports nothing. Poll until live.
  setPolling(streamState === "lost");

  await measure();
  draw();
  setInterval(() => void measure(), MEASURE_MS).unref?.();

  const initial = process.env.FLEECE_TARGET_PANE;
  if (initial) {
    if (initial !== selfPaneId) lastFocused = initial;
    await retarget(initial);
  } else {
    try {
      const pane = await paneCurrent();
      // Remember it even when it has no agent: `s` sends to shells too.
      if (pane.pane_id !== selfPaneId) lastFocused = pane.pane_id;
      await retarget(pane.pane_id);
    } catch {
      /* leave the empty state up */
    }
  }
  draw();
}

void start();
