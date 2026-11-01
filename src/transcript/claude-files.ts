import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Where Claude Code keeps transcripts: `<config>/projects/<cwd, flattened>/<session>.jsonl`. */
export function claudeProjectsDir(): string {
  return join(claudeHome(), "projects");
}

function projectDir(cwd: string): string {
  return join(claudeProjectsDir(), cwd.replace(/[/.]/g, "-"));
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
    const direct = join(projectDir(cwd), file);
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

/**
 * Without a session id, the newest transcript in the project directory is the
 * best guess. It is only a guess — two agents in one folder share it — so it
 * is used last.
 */
export function newestClaudeTranscript(cwd: string): string | undefined {
  const dir = projectDir(cwd);
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
