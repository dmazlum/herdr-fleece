import { execFile } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CopyResult {
  /** Name of the local clipboard tool that accepted the text, if any. */
  tool?: string;
  /** Whether an OSC 52 sequence was written to a terminal. */
  osc52: boolean;
}

const TOOLS: Record<string, string[][]> = {
  darwin: [["pbcopy"]],
  linux: [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ],
};

export async function copyToClipboard(text: string): Promise<CopyResult> {
  const tool = await copyWithTool(text);
  const osc52 = writeOsc52(text);
  return { tool, osc52 };
}

async function copyWithTool(text: string): Promise<string | undefined> {
  for (const command of TOOLS[process.platform] ?? []) {
    const [bin, ...args] = command;
    if (!bin) continue;
    try {
      const child = run(bin, args);
      child.child.stdin?.end(text);
      await child;
      return bin;
    } catch {
      // Tool missing or unusable; try the next one.
    }
  }
  return undefined;
}

/**
 * OSC 52 puts the text on the clipboard of the machine the user is *viewing*
 * from, which is what makes copying work over SSH. It needs a terminal to write
 * to, so it is a no-op for headless plugin actions — those rely on the local
 * clipboard tool instead.
 */
export function writeOsc52(text: string): boolean {
  const payload = `]52;c;${Buffer.from(text, "utf8").toString("base64")}`;

  let fd: number;
  try {
    fd = openSync("/dev/tty", "w");
  } catch {
    if (process.stdout.isTTY) {
      process.stdout.write(payload);
      return true;
    }
    return false;
  }

  try {
    writeSync(fd, payload);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
