import { agentGet, paneCurrent, paneGet, type PaneAgent } from "./herdr.js";
import { guessTranscript, locateTranscript } from "./transcript/agents.js";
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
    status: pane.agent_status,
  };

  target.transcriptPath = locateTranscript(target);
  // Herdr names the session once the agent reports it. Only when it never
  // did is the folder's newest transcript worth a guess; a named session that
  // is missing on disk must not silently become a different conversation.
  if (!sessionId) guessTranscript(target);
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

