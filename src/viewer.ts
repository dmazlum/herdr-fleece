import type { FleeceConfig } from "./config.js";
import { copyToClipboard } from "./export/clipboard.js";
import { codeOnly } from "./export/code.js";
import { saveMarkdown } from "./export/markdown.js";
import { bodyLines, CHROME_ROWS, renderFrame, renderMessage } from "./render/frame.js";
import { CLEAR, enterScreen, KEY, leaveScreen, onKeys, onResize, terminalSize } from "./screen.js";
import { StatusLine } from "./status.js";
import type { Target, Turn } from "./transcript/types.js";

export interface ViewerState {
  turn: Turn;
  target: Target;
}

export interface ViewerSource {
  /** The turn to show, or null when there is nothing yet. */
  state(): ViewerState | null;
  /** Drawing area, when the terminal size is not the pane size. */
  size?(): { width: number; height: number } | undefined;
  /** Right-aligned note in the action bar, e.g. "live" or "polling". */
  note?(): string | undefined;
  /** Shown in place of an answer when `state()` is null. */
  emptyMessage?(): string;
  /** Called once as the viewer tears down. */
  onQuit?(): void;
}

/**
 * The framed reader shared by the overlay and the dock. It owns scrolling,
 * keys and redraw; the source owns what is being shown and when it changes.
 */
export class Viewer {
  private scroll = 0;
  /** Receipts fade on their own, so the key hints come back. */
  private readonly statusLine = new StatusLine(() => this.draw());
  private shown: string | undefined;
  private started = false;

  constructor(
    private readonly source: ViewerSource,
    private readonly config: FleeceConfig,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    enterScreen();
    onResize(() => this.draw());
    onKeys((key) => void this.onKey(key));

    this.shown = this.identity();
    this.draw();
  }

  /** Redraws, resetting the scroll position when the answer itself changed. */
  refresh(): void {
    const identity = this.identity();
    if (identity !== this.shown) {
      this.scroll = 0;
      this.shown = identity;
      this.statusLine.clear();
    }
    this.draw();
  }

  /** The pane's drawing area, which is not always the terminal's size. */
  private area(): { width: number; height: number } {
    return this.source.size?.() ?? terminalSize();
  }

  draw(): void {
    const { width, height } = this.area();
    const state = this.source.state();

    if (!state) {
      const message = this.source.emptyMessage?.() ?? "nothing to frame yet";
      process.stdout.write(CLEAR + renderMessage(width, height, message));
      return;
    }

    this.scroll = Math.min(this.scroll, this.maxScroll(state));
    const frame = renderFrame(state.turn, state.target, this.config, {
      width,
      height,
      scroll: this.scroll,
      status: this.statusLine.value,
      note: this.source.note?.(),
    });
    process.stdout.write(CLEAR + frame);
  }

  private identity(): string | undefined {
    const state = this.source.state();
    if (!state) return undefined;
    return `${state.target.paneId}#${state.turn.index}@${state.turn.endedAt ?? ""}`;
  }

  private maxScroll(state: ViewerState): number {
    const { width, height } = this.area();
    const total = bodyLines(state.turn, this.config, width - 4).length;
    return Math.max(0, total - Math.max(1, height - CHROME_ROWS));
  }

  private async onKey(key: string): Promise<void> {
    const state = this.source.state();
    const page = Math.max(1, this.area().height - CHROME_ROWS - 1);
    const limit = state ? this.maxScroll(state) : 0;
    this.statusLine.clear();
    let message: string | undefined;

    switch (key) {
      case "q":
      case KEY.ESCAPE:
      case KEY.CTRL_C:
        this.quit();
        return;
      case "j":
      case KEY.DOWN:
        this.scroll = Math.min(limit, this.scroll + 1);
        break;
      case "k":
      case KEY.UP:
        this.scroll = Math.max(0, this.scroll - 1);
        break;
      case " ":
      case KEY.PAGE_DOWN:
        this.scroll = Math.min(limit, this.scroll + page);
        break;
      case "b":
      case KEY.PAGE_UP:
        this.scroll = Math.max(0, this.scroll - page);
        break;
      case "g":
        this.scroll = 0;
        break;
      case "G":
        this.scroll = limit;
        break;
      case "y":
        if (state) message = await copy(state.turn.text, "answer");
        break;
      case "c":
        if (state) message = await copy(codeOnly(state.turn.text), "code");
        break;
      case "m":
        if (state) message = await this.write(state);
        break;
      default:
        break;
    }

    this.statusLine.show(message);
    this.draw();
  }

  private async write(state: ViewerState): Promise<string> {
    try {
      const path = await saveMarkdown(state.turn, state.target, this.config);
      return `saved → ${path}`;
    } catch (err) {
      return `save failed: ${errorText(err)}`;
    }
  }

  private quit(): never {
    leaveScreen();
    this.source.onQuit?.();
    process.exit(0);
  }
}

async function copy(text: string, what: string): Promise<string> {
  if (text.trim() === "") return `nothing to copy (${what})`;
  const result = await copyToClipboard(text);
  if (!result.tool && !result.osc52) return "no clipboard available";
  const kb = (Buffer.byteLength(text, "utf8") / 1024).toFixed(1);
  return `copied ${what} · ${kb} KB`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
