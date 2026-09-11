/**
 * The one-line receipt in an action bar.
 *
 * A status message answers "did that work?" and then has no further job. Left
 * up until the next keypress it becomes a lie: a dock glanced at an hour later
 * still claims something was just copied, and the key hints it covers are the
 * thing actually worth showing. So a receipt fades on its own.
 *
 * A prompt is not a receipt. `hold` exists for the message that is waiting on
 * an answer — expiring that would leave the reader in a mode with nothing on
 * screen to say so.
 */

/** How long a receipt stays up. Long enough to read, short enough to forget. */
export const STATUS_MS = 3000;

export class StatusLine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private text: string | undefined;

  /**
   * @param redraw Called when a receipt expires. Nothing else repaints then.
   * @param ms How long a receipt lasts.
   */
  constructor(
    private readonly redraw: () => void,
    private readonly ms: number = STATUS_MS,
  ) {}

  get value(): string | undefined {
    return this.text;
  }

  /** Shows a receipt that clears itself, and redraws when it does. */
  show(text: string | undefined): void {
    this.clear();
    if (text === undefined) return;

    this.text = text;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.text = undefined;
      this.redraw();
    }, this.ms);
    // A pending receipt must never be the reason a process stays alive.
    this.timer.unref?.();
  }

  /** Shows a message that waits for the reader rather than expiring. */
  hold(text: string): void {
    this.clear();
    this.text = text;
  }

  /** Drops the message and any pending expiry. The caller owns the redraw. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.text = undefined;
  }
}
