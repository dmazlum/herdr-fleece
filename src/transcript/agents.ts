import { claudeParser } from "./claude.js";
import { claudeProjectsDir, findClaudeTranscript, newestClaudeTranscript } from "./claude-files.js";
import { readTurnsGrowing, TranscriptWatch, type ParserFactory } from "./reader.js";
import type { Target, Turn } from "./types.js";

/**
 * Everything Fleece knows about one agent's transcripts, keyed by the name
 * Herdr reports for the agent ("claude"). Resolution, the dock, the CLI and
 * the app engine go through here, so supporting another agent is one entry.
 */
export interface AgentTranscripts {
  /** Herdr's name for the agent. */
  id: string;
  /** What a person calls it, for messages. */
  label: string;
  createParser: ParserFactory;
  /** The directory its transcripts live under, for `doctor` and error messages. */
  home(): string;
  /** The transcript for a session id, or null when there is none. */
  find(sessionId: string, cwd?: string): string | null;
  /** A guess when no session id is known: the newest transcript for that cwd. */
  newest(cwd: string): string | undefined;
}

const claude: AgentTranscripts = {
  id: "claude",
  label: "Claude Code",
  createParser: claudeParser,
  home: claudeProjectsDir,
  find: findClaudeTranscript,
  newest: newestClaudeTranscript,
};

const AGENTS: readonly AgentTranscripts[] = [claude];

export function agentTranscripts(agent: string | undefined): AgentTranscripts | undefined {
  return AGENTS.find((entry) => entry.id === agent);
}

export function supportedAgents(): readonly AgentTranscripts[] {
  return AGENTS;
}

export class TranscriptError extends Error {}

/** Where this target's transcript is, from its session id. */
export function locateTranscript(target: Target): string | undefined {
  const agent = agentTranscripts(target.agent);
  if (!agent || !target.sessionId) return undefined;
  return agent.find(target.sessionId, target.cwd) ?? undefined;
}

/** Why a target has no transcript to read: an agent Fleece cannot read, or a file not found. */
export function missingTranscript(target: Target): string {
  const agent = agentTranscripts(target.agent);
  if (!agent) {
    const names = AGENTS.map((entry) => entry.label).join(" and ");
    return `agent "${target.agent}" is not supported yet — Fleece reads ${names}`;
  }
  return `no ${agent.label} transcript for session ${target.sessionId ?? "?"} under ${agent.home()}`;
}

/** Every turn in the target's transcript, parsed as its agent writes them. */
export function readTargetTurns(target: Target): Turn[] {
  const agent = agentTranscripts(target.agent);
  if (!agent || !target.transcriptPath) throw new TranscriptError(missingTranscript(target));
  return readTurnsGrowing(target.transcriptPath, agent.createParser).turns;
}

/** A {@link TranscriptWatch} that follows the dock from one agent's pane to another's. */
export class AgentTranscriptWatch {
  #agent = "";
  #watch: TranscriptWatch | null = null;

  /** Throws {@link TranscriptError} for an agent Fleece cannot read. */
  read(agent: string, path: string, force = false): Turn[] {
    if (agent !== this.#agent || !this.#watch) {
      const entry = agentTranscripts(agent);
      if (!entry) throw new TranscriptError(`agent "${agent}" is not supported yet`);
      this.#agent = agent;
      this.#watch = new TranscriptWatch(entry.createParser);
    }
    return this.#watch.read(path, force);
  }

  reset(): void {
    this.#watch?.reset();
  }
}
