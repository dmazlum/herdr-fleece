import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentGet, paneCurrent, paneGet, type PaneAgent } from "./herdr.js";
import type { Target } from "./transcript/types.js";

export class ResolveError extends Error {}

/**
 * Works out which pane Fleece is acting on and where that agent's transcript
 * lives. Fleece reads the transcript rather than the pane scrollback: `pane.read`
 * caps out near 1000 lines, and its text carries soft-wrap and box-drawing
 * artefacts that would survive into every copy and export.
 */
export async function resolveTarget(explicitPaneId?: string): Promise<Target> {
  const pane =
    explicitPaneId !== undefined
      ? await requireAgentPane(explicitPaneId)
      : await inferAgentPane();

  return targetFrom(pane);
}

/**
 * `--pane` is a choice. A miss or a transient lookup failure must not silently
 * copy, save or journal a different conversation.
 */
export function agentPaneOrThrow(
  paneId: string,
  agent: PaneAgent | null,
  raw: PaneAgent | null,
): PaneAgent {
  if (paneId === "") {
    throw new ResolveError("pane id is empty");
  }
  if (agent?.agent) return agent;
  if (agent || raw) {
    throw new ResolveError(`pane ${paneId} has no agent Herdr can see`);
  }
  throw new ResolveError(`pane ${paneId} was not found`);
}

async function requireAgentPane(paneId: string): Promise<PaneAgent> {
  const agent = await agentGet(paneId);
  const raw = agent ?? (await paneGet(paneId));
  return agentPaneOrThrow(paneId, agent, raw);
}

async function inferAgentPane(): Promise<PaneAgent> {
  const paneId = contextPaneId();
  let pane: PaneAgent | null = paneId ? await agentGet(paneId) : null;
  if (!pane) pane = await paneCurrent();
  if (!pane.agent) {
    throw new ResolveError(`pane ${pane.pane_id} has no agent Herdr can see`);
  }
  return pane;
}

function targetFrom(pane: PaneAgent): Target {
  const agent = pane.agent!;
  const sessionId = pane.agent_session?.value;
  const cwd = pane.cwd ?? pane.foreground_cwd;

  const target: Target = {
    paneId: pane.pane_id,
    agent,
    sessionId,
    cwd,
    title: pane.terminal_title_stripped,
  };

  if (agent === "claude" && sessionId) {
    target.transcriptPath = findClaudeTranscript(sessionId, cwd) ?? undefined;
  }

  return target;
}

/**
 * Prefers the invocation context Herdr builds for the action over HERDR_PANE_ID,
 * so a Fleece pane asking again still resolves the agent pane behind it.
 */
function contextPaneId(): string | undefined {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      const context = JSON.parse(raw);
      const id =
        context?.focused_pane?.pane_id ??
        context?.focused_pane_id ??
        context?.pane?.pane_id ??
        context?.pane_id;
      if (typeof id === "string" && id !== "") return id;
    } catch {
      /* fall through to the env var */
    }
  }
  const envPane = process.env.HERDR_PANE_ID;
  return envPane && envPane !== "" ? envPane : undefined;
}

export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "projects");
}

/**
 * Claude Code names a project directory after its cwd with separators replaced.
 * That mapping is an implementation detail, so a miss falls back to scanning
 * for the session id, which is unique across projects.
 */
export function findClaudeTranscript(sessionId: string, cwd?: string): string | null {
  const projects = claudeProjectsDir();
  const file = `${sessionId}.jsonl`;

  if (cwd) {
    const direct = join(projects, cwd.replace(/[/.]/g, "-"), file);
    if (existsSync(direct)) return direct;
  }

  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const candidate = join(projects, entry, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
