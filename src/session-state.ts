import { LIFECYCLE_ENTRY_TYPE } from "./constants.js";
import type { WatchLifecycleRecord, WatchState } from "./types.js";

/** Replays lifecycle entries on the active Pi session branch. */
export function reconstructWatchStates(entries: readonly unknown[]): Map<string, WatchState> {
  const states = new Map<string, WatchState>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== LIFECYCLE_ENTRY_TYPE || !isLifecycleRecord(entry.data))
      continue;
    const record = entry.data;
    states.set(record.watch_id, {
      config: record.config,
      status: record.kind,
      updated_at: record.at,
      ...(record.origin === undefined ? {} : { origin: record.origin }),
      ...(record.event === undefined ? {} : { event: record.event }),
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  }
  return states;
}

/** Performs a minimal shape check before trusting persisted extension data. */
function isLifecycleRecord(value: unknown): value is WatchLifecycleRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WatchLifecycleRecord>;
  return (
    record.version === 1 &&
    typeof record.watch_id === "string" &&
    typeof record.at === "string" &&
    !!record.config &&
    typeof record.config === "object" &&
    typeof record.config.watch_id === "string" &&
    (["started", "finish", "interrupt", "close", "cancelled"] as const).includes(
      record.kind as never,
    )
  );
}
