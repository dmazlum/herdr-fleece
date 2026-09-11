import { unlinkSync } from "node:fs";
import { loadConfig } from "./config.js";
import { readFramePayload } from "./dockstate.js";
import type { Target, Turn } from "./transcript/types.js";
import { errorText, Viewer } from "./viewer.js";

/** The overlay: one answer, resolved by the action that opened this pane. */

interface Payload {
  turn: Turn;
  target: Target;
}

function fail(text: string): never {
  process.stderr.write(`fleece: ${text}\n`);
  process.exit(1);
}

function readPayload(): Payload {
  const path = process.env.FLEECE_PAYLOAD;
  if (!path) fail("FLEECE_PAYLOAD is not set — open this pane through a Fleece action");

  let raw: string;
  try {
    raw = readFramePayload(path);
  } catch (err) {
    fail(`cannot read ${path}: ${errorText(err)}`);
  }

  try {
    // The handoff file has done its job; leaving it behind would litter the state dir.
    unlinkSync(path);
  } catch {
    /* ignore */
  }

  return JSON.parse(raw) as Payload;
}

const payload = readPayload();
new Viewer({ state: () => payload }, loadConfig()).start();
