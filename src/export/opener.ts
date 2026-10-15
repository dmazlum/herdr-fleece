import { spawn } from "node:child_process";

/**
 * Hands a file, directory or URL to whatever the desktop would open it with.
 *
 * Links always go to the system opener: a browser is the only sensible place
 * for them. Files and directories can be sent elsewhere — an editor such as
 * `code` — with `open_command`, which is split on whitespace and given the
 * path as its last argument. Nothing goes through a shell, so a path with
 * spaces or quotes in it is one argument, not several.
 */

const SYSTEM: Record<string, string> = {
  darwin: "open",
  linux: "xdg-open",
};

export function systemOpener(platform: NodeJS.Platform = process.platform): string | undefined {
  return SYSTEM[platform];
}

/** The argv that opens `target`, or null when this platform has no opener. */
export function openArgs(
  target: string,
  options: { link?: boolean; command?: string[]; platform?: NodeJS.Platform } = {},
): string[] | null {
  if (!options.link && options.command && options.command.length > 0) {
    return [...options.command, target];
  }
  const opener = systemOpener(options.platform);
  return opener ? [opener, target] : null;
}

export function parseCommand(text: string | undefined): string[] | undefined {
  const parts = text?.trim().split(/\s+/).filter((part) => part !== "") ?? [];
  return parts.length > 0 ? parts : undefined;
}

/**
 * Starts the opener and lets it go. Only a failure to start is reported: an
 * editor can stay open for hours, and the dock must not wait on it.
 */
export function launch(argv: string[]): Promise<void> {
  const [bin, ...args] = argv;
  if (!bin) return Promise.reject(new Error("no command to open with"));

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
