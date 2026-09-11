import net from "node:net";

/**
 * Herdr speaks newline-delimited JSON over a local socket. Subscriptions name
 * events with dots (`pane.focused`); the events pushed back name them with
 * underscores (`pane_focused`), so callers should match on `eventKind`.
 */

export interface Subscription {
  type: string;
  pane_id?: string;
  agent_status?: string;
}

export interface HerdrEvent {
  kind: string;
  data: Record<string, unknown>;
}

export type StreamState = "live" | "lost";

export interface EventStream {
  close(): void;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/**
 * Opens a subscription that survives a server restart. Returns immediately;
 * `onState` reports whether the stream is currently connected.
 */
export function subscribe(
  subscriptions: Subscription[],
  onEvent: (event: HerdrEvent) => void,
  onState: (state: StreamState) => void = () => {},
): EventStream {
  const path = process.env.HERDR_SOCKET_PATH;
  let socket: net.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let delay = RECONNECT_MIN_MS;
  let closed = false;

  function retry(): void {
    if (closed) return;
    onState("lost");
    timer = setTimeout(connect, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  }

  function connect(): void {
    if (closed) return;
    if (!path) {
      onState("lost");
      return;
    }

    let buffer = "";
    socket = net.createConnection(path);
    socket.setEncoding("utf8");

    socket.on("connect", () => {
      delay = RECONNECT_MIN_MS;
      const request = { id: "fleece", method: "events.subscribe", params: { subscriptions } };
      socket?.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const { lines, rest } = splitLines(buffer);
      buffer = rest;
      for (const line of lines) {
        const message = parseLine(line);
        if (!message) continue;
        if (isAck(message)) {
          onState("live");
          continue;
        }
        const kind = eventKind(message);
        if (kind !== "") onEvent({ kind, data: eventData(message) });
      }
    });

    socket.on("error", () => socket?.destroy());
    socket.on("close", () => {
      socket = null;
      retry();
    });
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.destroy();
      socket = null;
    },
  };
}

/** Splits a read buffer into complete lines, returning the unterminated remainder. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim() !== ""), rest };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isAck(message: Record<string, unknown>): boolean {
  const result = message["result"] as { type?: string } | undefined;
  return result?.type === "subscription_started";
}

/**
 * Normalises an event name to its underscore form, so a caller can match one
 * spelling regardless of which envelope the server used.
 */
export function eventKind(message: Record<string, unknown>): string {
  const data = message["data"] as { type?: unknown } | undefined;
  const raw = typeof message["event"] === "string" ? message["event"] : data?.type;
  return typeof raw === "string" ? raw.replace(/\./g, "_") : "";
}

export function eventData(message: Record<string, unknown>): Record<string, unknown> {
  const data = message["data"];
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}
