import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeProjectsDir, findClaudeTranscript } from "./resolve.js";
import type { Target } from "./transcript/types.js";

const run = promisify(execFile);

/**
 * Resolves a herdr-core terminal (`t8`) to the agent transcript behind it, for
 * the Herdr desktop app. The app has no plugin context and no session id on its
 * agents, so the chain is: core terminal → its foreground process → the
 * session file Claude Code keeps per pid → the transcript.
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

export function claudeSessionsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "sessions");
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

/**
 * Without a session file, the newest transcript in the project directory is
 * the best guess. It is only a guess — two agents in one folder share it — so
 * it is used last.
 */
export function newestTranscript(cwd: string): string | undefined {
  const dir = join(claudeProjectsDir(), cwd.replace(/[/.]/g, "-"));
  let best: { path: string; mtime: number } | undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      /* raced with a delete */
    }
  }
  return best?.path;
}

export async function resolveTerminal(address: string): Promise<Target> {
  const terminal = await coreTerminal(address);
  const cwd = terminal.foreground?.cwd ?? terminal.cwd;
  const target: Target = {
    paneId: terminal.address ?? address,
    agent: isClaude(terminal) ? "claude" : (agentApp(terminal) ?? "unknown"),
    cwd,
    title: terminal.title,
  };
  if (target.agent !== "claude") return target;

  const pid = terminal.foreground?.pid;
  target.sessionId = pid ? sessionIdForPid(pid) : undefined;
  if (target.sessionId) {
    target.transcriptPath = findClaudeTranscript(target.sessionId, cwd) ?? undefined;
  }
  if (!target.transcriptPath && cwd) {
    target.transcriptPath = newestTranscript(cwd);
    const file = target.transcriptPath?.split("/").pop();
    if (file) target.sessionId ??= file.replace(/\.jsonl$/, "");
  }
  return target;
}
