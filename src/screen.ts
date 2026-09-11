/** Alternate-screen and raw-key plumbing shared by the overlay and the dock. */

const ESC = String.fromCharCode(27);

export const KEY = {
  ESCAPE: ESC,
  CTRL_C: String.fromCharCode(3),
  UP: `${ESC}[A`,
  DOWN: `${ESC}[B`,
  PAGE_UP: `${ESC}[5~`,
  PAGE_DOWN: `${ESC}[6~`,
} as const;

const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

export const CLEAR = `${ESC}[2J${ESC}[H`;

export function enterScreen(): void {
  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
}

export function leaveScreen(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

export function onKeys(handler: (key: string) => void): void {
  process.stdin.on("data", (chunk: string) => handler(chunk));
}

export function onResize(handler: () => void): void {
  process.stdout.on("resize", handler);
}

export function terminalSize(): { width: number; height: number } {
  return { width: process.stdout.columns ?? 100, height: process.stdout.rows ?? 30 };
}
