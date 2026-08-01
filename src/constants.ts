import type { WatchConfig, WatchInput, WatchState, WatchTerminalKind } from "./types.js";

export const DEFAULT_INTERVAL_SECONDS = 5;
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 10;
export const DEFAULT_ACTIVE_LIMIT = 20;
export const DEFAULT_TERMINAL_LIMIT = 5;
export const MAX_LIST_LIMIT = 100;
export const MAX_JOB_ID = 200;
export const MAX_NOTE = 2000;
export const MAX_PATHS = 20;
export const MAX_PATH_LENGTH = 1000;
export const STDERR_TAIL_BYTES = 2000;
export const PROTOCOL_PREFIX = "@@PI_SSH_TARGET@@";
export const LIFECYCLE_ENTRY_TYPE = "pi-ssh-target-lifecycle";
export const MESSAGE_TYPE = "pi-ssh-target-terminal";

/** Validates watch metadata before any SSH process is created. */
export function validateWatchInput(input: WatchInput): string | undefined {
  if (!input.host) return "host 不能为空";
  if (!Number.isInteger(input.pid) || input.pid <= 0) return "pid 必须是正整数";
  if (!input.job_id) return "job_id 不能为空";
  if (input.job_id.length > MAX_JOB_ID) return `job_id 最多 ${MAX_JOB_ID} 字符`;
  if ((input.note?.length ?? 0) > MAX_NOTE) return `note 最多 ${MAX_NOTE} 字符`;
  for (const [name, paths] of [["result_paths", input.result_paths], ["log_paths", input.log_paths]] as const) {
    if ((paths?.length ?? 0) > MAX_PATHS) return `${name} 最多 ${MAX_PATHS} 项`;
    if (paths?.some((path) => path.length > MAX_PATH_LENGTH)) return `${name} 每项最多 ${MAX_PATH_LENGTH} 字符`;
  }
  if (input.interval_seconds !== undefined && (!Number.isFinite(input.interval_seconds) || input.interval_seconds <= 0)) {
    return "interval_seconds 必须大于 0";
  }
  if (
    input.startup_timeout_seconds !== undefined &&
    (!Number.isFinite(input.startup_timeout_seconds) || input.startup_timeout_seconds <= 0)
  ) {
    return "startup_timeout_seconds 必须大于 0";
  }
  return undefined;
}

/** Creates the normalized complete configuration stored for restoration. */
export function normalizeWatchConfig(
  input: WatchInput,
  watchId: string,
  sessionId: string,
  resume = false,
): WatchConfig {
  return {
    watch_id: watchId,
    session_id: sessionId,
    host: input.host,
    pid: input.pid,
    job_id: input.job_id,
    ssh_args: [...(input.ssh_args ?? [])],
    interval_seconds: input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
    startup_timeout_seconds: input.startup_timeout_seconds ?? DEFAULT_STARTUP_TIMEOUT_SECONDS,
    result_paths: [...(input.result_paths ?? [])],
    log_paths: [...(input.log_paths ?? [])],
    ...(input.note === undefined ? {} : { note: input.note }),
    resume,
  };
}

/** Returns true for states that must never be restored. */
export function isTerminalStatus(status: WatchState["status"]): status is WatchTerminalKind {
  return status !== "started";
}
