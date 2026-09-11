export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ToolUse {
  name: string;
  count: number;
}

/** A file the agent created or changed, taken from its own tool calls. */
export interface FileEdit {
  /** The path exactly as the tool call gave it; in practice always absolute. */
  path: string;
  /** How many write-class tool calls landed on it. */
  edits: number;
}

/** One prompt and the answer it produced. */
export interface Turn {
  /** 1-based position in the session. */
  index: number;
  prompt: string;
  promptAt?: string;
  /** The answer as the agent wrote it: raw Markdown, no terminal artefacts. */
  text: string;
  thinking: string;
  toolUses: ToolUse[];
  /** Files the agent wrote to, busiest first. Recorded, not guessed from prose. */
  files: FileEdit[];
  model?: string;
  endedAt?: string;
  durationMs?: number;
  usage: TokenUsage;
  gitBranch?: string;
  cwd?: string;
  agentVersion?: string;
}

/** Which pane Fleece is acting on, and where that agent's transcript lives. */
export interface Target {
  paneId: string;
  agent: string;
  sessionId?: string;
  cwd?: string;
  title?: string;
  transcriptPath?: string;
}
