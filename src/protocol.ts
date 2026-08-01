import { PROTOCOL_PREFIX } from "./constants.js";
import type { WatcherProtocolEvent } from "./types.js";

/** Parses one stdout line only when it matches the fixed watcher protocol. */
export function parseProtocolLine(line: string): WatcherProtocolEvent | undefined {
  if (!line.startsWith(PROTOCOL_PREFIX)) return undefined;
  const payload: unknown = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
  if (!isProtocolEvent(payload)) throw new Error("invalid watcher protocol event");
  return payload;
}

/** Checks the bounded fields required for local lifecycle handling. */
function isProtocolEvent(value: unknown): value is WatcherProtocolEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!(["ready", "finish", "interrupt"] as const).includes(event.event as never)) return false;
  if (typeof event.watch_id !== "string" || typeof event.job_id !== "string" || typeof event.host !== "string") return false;
  if (!Number.isInteger(event.root_pid) || !Number.isInteger(event.process_count)) return false;
  if (typeof event.observed_at !== "string") return false;
  if (event.state_file !== null && typeof event.state_file !== "string") return false;
  if (event.event === "interrupt") {
    return typeof event.error_code === "string" && typeof event.error === "string";
  }
  return true;
}

/** Splits arbitrary stdout chunks into complete lines while retaining a tail. */
export function consumeLines(buffer: string, chunk: Buffer): { lines: string[]; rest: string } {
  const combined = buffer + chunk.toString("utf8");
  const pieces = combined.split(/\r?\n/);
  return { lines: pieces.slice(0, -1), rest: pieces.at(-1) ?? "" };
}
