import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentTranscripts, guessTranscript, locateTranscript } from "./transcript/agents.js";
import { claudeHome } from "./transcript/claude-files.js";
import type { Target } from "./transcript/types.js";

const run = promisify(execFile);

/**
 * Resolves a herdr-core terminal (`t8`) to the agent transcript behind it, for
 * the Herdr desktop app. The app has no plugin context and no session id on its
 * agents, so the chain is: core terminal → its foreground process → the
 * session file Claude Code keeps per pid → the transcript. Codex keeps no such
 * file, so a Codex terminal gets the newest top-level rollout for its folder.
 */

export class CoreError extends Error {}

/** The subset of `hc get <t> --json` Fleece relies on. */
export interface CoreTerminal {
  address: string;
  cwd?: string;
  title?: string;
  foreground?: { argv?: string[]; cwd?: string; pid?: number };
  status?: { app?: string; state?: string } | string;
}

export const HC_BIN = process.env.FLEECE_HC ?? "hc";

export async function coreTerminal(address: string): Promise<CoreTerminal> {
  let stdout: string;
  try {
    ({ stdout } = await run(HC_BIN, ["get", address, "--json"], { maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CoreError(`hc get ${address} failed: ${message}`);
  }
  try {
    return JSON.parse(stdout) as CoreTerminal;
  } catch {
    throw new CoreError(`hc get ${address} did not return JSON`);
  }
}

/** What the agent reported over OSC 7501, e.g. "claude-code". */
export function agentApp(terminal: CoreTerminal): string | undefined {
  return typeof terminal.status === "object" ? terminal.status?.app : undefined;
}

export function isClaude(terminal: CoreTerminal): boolean {
  if (agentApp(terminal) === "claude-code") return true;
  const head = terminal.foreground?.argv?.[0] ?? "";
  return /(^|\/)claude$/.test(head);
}

/**
 * Codex runs as its native binary, or through the npm launcher as
 * `node …/bin/codex.js`, so both argv shapes count.
 */
export function isCodex(terminal: CoreTerminal): boolean {
  const app = agentApp(terminal);
  if (app === "codex" || app?.startsWith("codex-")) return true;
  const [head = "", script = ""] = terminal.foreground?.argv ?? [];
  if (/(^|\/)codex$/.test(head)) return true;
  return /(^|\/)node$/.test(head) && /(^|\/)codex(\.js)?$/.test(script);
}

/** Herdr's name for the agent in a terminal, as the transcript registry knows it. */
export function terminalAgent(terminal: CoreTerminal): string {
  if (isClaude(terminal)) return "claude";
  if (isCodex(terminal)) return "codex";
  return agentApp(terminal) ?? "unknown";
}

export function claudeSessionsDir(): string {
  return join(claudeHome(), "sessions");
}

/**
 * Claude Code writes `sessions/<pid>.json` for every interactive process and
 * keeps its `sessionId` current across `/clear` and `/resume`, which makes it
 * the one honest answer to "which conversation is this terminal showing".
 */
export function sessionIdForPid(
  pid: number,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | undefined {
  try {
    const record = JSON.parse(read(join(claudeSessionsDir(), `${pid}.json`)));
    return typeof record?.sessionId === "string" && record.sessionId !== ""
      ? record.sessionId
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveTerminal(address: string): Promise<Target> {
  const terminal = await coreTerminal(address);
  const cwd = terminal.foreground?.cwd ?? terminal.cwd;
  const target: Target = {
    paneId: terminal.address ?? address,
    agent: terminalAgent(terminal),
    cwd,
    title: terminal.title,
  };
  const agent = agentTranscripts(target.agent);
  if (!agent) return target;

  const pid = terminal.foreground?.pid;
  if (target.agent === "claude" && pid) target.sessionId = sessionIdForPid(pid);
  target.transcriptPath = locateTranscript(target);
  // The app has no session id for Codex at all, and Claude's pid file can lag.
  if (!target.transcriptPath) guessTranscript(target);
  return target;
}
