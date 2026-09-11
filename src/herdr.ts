import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stripControls } from "./render/text.js";

const run = promisify(execFile);

/** Herdr injects HERDR_BIN_PATH; falling back to PATH keeps manual runs working. */
export const HERDR_BIN = process.env.HERDR_BIN_PATH ?? "herdr";

export interface AgentSession {
  agent: string;
  kind: string;
  source: string;
  value: string;
}

/** The subset of Herdr's pane/agent record that Fleece relies on. */
export interface PaneAgent {
  agent?: string;
  agent_session?: AgentSession;
  agent_status?: string;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  terminal_title_stripped?: string;
}

export class HerdrError extends Error {}

async function call(args: string[]): Promise<any> {
  let stdout: string;
  try {
    ({ stdout } = await run(HERDR_BIN, args, { maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HerdrError(`herdr ${args.join(" ")} failed: ${message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new HerdrError(`herdr ${args.join(" ")} did not return JSON`);
  }

  if (parsed?.error) {
    const detail = parsed.error.message ?? JSON.stringify(parsed.error);
    throw new HerdrError(`herdr ${args.join(" ")}: ${detail}`);
  }
  return parsed.result ?? parsed;
}

/** Some pane commands print nothing at all on success, so nothing is parsed. */
async function callVoid(args: string[]): Promise<void> {
  try {
    await run(HERDR_BIN, args, { maxBuffer: 1024 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HerdrError(`herdr ${args.join(" ")} failed: ${message}`);
  }
}

const ESC = String.fromCharCode(27);

/**
 * Wraps text as a bracketed paste. `pane.send_text` writes literal bytes, so an
 * unwrapped newline is an Enter: a shell would run every line of a pasted block
 * and an agent would submit it. Bracketed, the whole thing lands on the prompt
 * as one edit that the reader still has to accept. Both zsh and Herdr's own
 * panes honour it.
 *
 * Control bytes are stripped first so a payload cannot emit ESC/CSI/OSC and
 * close the wrap — `ESC[201~` followed by a newline would otherwise run.
 */
export function pasteBody(text: string): string {
  const body = stripControls(text).replace(/\n+$/, "");
  return `${ESC}[200~${body}${ESC}[201~`;
}

/** Puts text on another pane's prompt. Never sends Enter — that stays the reader's call. */
export async function paneSendText(paneId: string, text: string): Promise<void> {
  await callVoid(["pane", "send-text", paneId, pasteBody(text)]);
}

/** The focused pane, including its agent identity when one is detected. */
export async function paneCurrent(): Promise<PaneAgent> {
  const result = await call(["pane", "current"]);
  const pane = result?.pane;
  if (!pane?.pane_id) throw new HerdrError("pane.current returned no pane");
  return pane as PaneAgent;
}

/** Returns null when the pane has no agent, which is a normal outcome. */
export async function agentGet(paneId: string): Promise<PaneAgent | null> {
  try {
    const result = await call(["agent", "get", paneId]);
    return (result?.agent as PaneAgent) ?? null;
  } catch {
    return null;
  }
}

/** Focus the agent in a pane so an overlay opens over that conversation. */
export function agentFocusArgs(target: string): string[] {
  return ["agent", "focus", target];
}

export async function agentFocus(target: string): Promise<void> {
  await callVoid(agentFocusArgs(target));
}

/** Overlay panes always cover the active pane, so a different target must be focused first. */
export function shouldFocusBeforeOverlay(
  currentPaneId: string | undefined,
  targetPaneId: string,
): boolean {
  return currentPaneId !== targetPaneId;
}

export async function openFrameOverlay(
  targetPaneId: string,
  env: Record<string, string>,
): Promise<void> {
  let currentId: string | undefined;
  try {
    currentId = (await paneCurrent()).pane_id;
  } catch {
    currentId = undefined;
  }
  if (shouldFocusBeforeOverlay(currentId, targetPaneId)) {
    await agentFocus(targetPaneId);
  }
  await openPluginPane("frame", env, { placement: "overlay" });
}

export async function paneGet(paneId: string): Promise<PaneAgent | null> {
  try {
    const result = await call(["pane", "get", paneId]);
    return (result?.pane as PaneAgent) ?? null;
  } catch {
    return null;
  }
}

export async function paneClose(paneId: string): Promise<void> {
  await call(["pane", "close", paneId]);
}

export interface PaneRect {
  width: number;
  height: number;
}

export interface PaneLayout {
  area: PaneRect;
  panes: { pane_id: string; rect: PaneRect }[];
}

export async function paneLayout(paneId: string): Promise<PaneLayout | null> {
  try {
    const result = await call(["pane", "layout", "--pane", paneId]);
    const layout = result?.layout as PaneLayout | undefined;
    if (!layout?.area?.width || !Array.isArray(layout.panes)) return null;
    return layout;
  } catch {
    return null;
  }
}

/**
 * A plugin pane's PTY can be wider than the pane it is drawn into, so the
 * layout rect — not `process.stdout.columns` — is the honest drawing width.
 */
export async function paneRect(paneId: string): Promise<PaneRect | null> {
  const layout = await paneLayout(paneId);
  const rect = layout?.panes.find((pane) => pane.pane_id === paneId)?.rect;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  return { width: rect.width, height: rect.height };
}

/** `--amount` shifts the split ratio, so callers pass a delta, not a target. */
export async function paneResize(
  paneId: string,
  direction: "left" | "right" | "up" | "down",
  amount: number,
): Promise<void> {
  const args = ["pane", "resize", "--pane", paneId, "--direction", direction];
  args.push("--amount", String(amount));
  await call(args);
}

export interface OpenPaneOptions {
  placement?: "overlay" | "split" | "tab" | "zoomed";
  direction?: "right" | "down";
  targetPaneId?: string;
  focus?: boolean;
}

/** Placements that launch next to a pane you name. */
const TARGETED_PLACEMENTS = new Set(["split", "tab", "zoomed"]);

/**
 * Builds the `plugin pane open` argv.
 *
 * Overlay and popup panes always launch over the *active* pane: naming a target
 * is rejected with `invalid_params`, so the target is dropped for them rather
 * than passed and refused.
 */
export function paneOpenArgs(
  pluginId: string,
  entrypoint: string,
  env: Record<string, string>,
  options: OpenPaneOptions = {},
): string[] {
  const args = ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", entrypoint];
  if (options.placement) args.push("--placement", options.placement);
  if (options.direction) args.push("--direction", options.direction);
  if (options.targetPaneId && TARGETED_PLACEMENTS.has(options.placement ?? "overlay")) {
    args.push("--target-pane", options.targetPaneId);
  }
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  args.push(options.focus === false ? "--no-focus" : "--focus");
  return args;
}

export async function openPluginPane(
  entrypoint: string,
  env: Record<string, string>,
  options: OpenPaneOptions = {},
): Promise<void> {
  const pluginId = process.env.HERDR_PLUGIN_ID ?? "fleece";
  await call(paneOpenArgs(pluginId, entrypoint, env, options));
}

/** Best-effort toast. Never throws: a failed notification must not fail an action. */
export async function notify(title: string, body?: string): Promise<void> {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  try {
    await call(args);
  } catch {
    /* ignore */
  }
}
