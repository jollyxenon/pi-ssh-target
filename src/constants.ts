import type {
  StartInput,
  WatchConfig,
  WatchInput,
  WatchMetadataInput,
  WatchState,
  WatchTerminalKind,
} from "./types.js";

export const DEFAULT_INTERVAL_SECONDS = 5;
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 10;
export const DEFAULT_ACTIVE_LIMIT = 20;
export const DEFAULT_TERMINAL_LIMIT = 5;
export const MAX_LIST_LIMIT = 100;
export const MAX_JOB_ID = 200;
export const MAX_NOTE = 2000;
export const MAX_PATHS = 20;
export const MAX_PATH_LENGTH = 1000;
export const MAX_COMMAND_LENGTH = 1000;
export const MAX_ARGS = 100;
export const MAX_ARG_LENGTH = 4000;
export const MAX_ENV = 100;
export const MAX_ENV_VALUE_LENGTH = 4000;
export const STDERR_TAIL_BYTES = 2000;
export const PROTOCOL_PREFIX = "@@PI_SSH_TARGET@@";
export const LIFECYCLE_ENTRY_TYPE = "pi-ssh-target-lifecycle";
export const AUDIT_ENTRY_TYPE = "pi-ssh-target-audit";
export const MESSAGE_TYPE = "pi-ssh-target-terminal";
export const AUDIT_MESSAGE_TYPE = "pi-ssh-target-audit-request";

/** Validates metadata shared by watch and start before SSH is created. */
function validateMetadata(input: WatchMetadataInput): string | undefined {
  if (!input.host) return "host 不能为空";
  if (!input.job_id) return "job_id 不能为空";
  if (input.job_id.length > MAX_JOB_ID) return `job_id 最多 ${MAX_JOB_ID} 字符`;
  if ((input.note?.length ?? 0) > MAX_NOTE) return `note 最多 ${MAX_NOTE} 字符`;
  for (const [name, paths] of [
    ["result_paths", input.result_paths],
    ["log_paths", input.log_paths],
  ] as const) {
    if ((paths?.length ?? 0) > MAX_PATHS) return `${name} 最多 ${MAX_PATHS} 项`;
    if (paths?.some((path) => path.length > MAX_PATH_LENGTH)) return `${name} 每项最多 ${MAX_PATH_LENGTH} 字符`;
  }
  if (
    input.interval_seconds !== undefined &&
    (!Number.isFinite(input.interval_seconds) || input.interval_seconds <= 0)
  ) {
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

/** Validates watch metadata before any SSH process is created. */
export function validateWatchInput(input: WatchInput): string | undefined {
  const metadataError = validateMetadata(input);
  if (metadataError) return metadataError;
  if (!Number.isInteger(input.pid) || input.pid <= 0) return "pid 必须是正整数";
  return undefined;
}

/** Validates structured remote launch input before any SSH process is created. */
export function validateStartInput(input: StartInput): string | undefined {
  const metadataError = validateMetadata(input);
  if (metadataError) return metadataError;
  if (!input.command) return "command 不能为空";
  if (input.command.length > MAX_COMMAND_LENGTH) return `command 最多 ${MAX_COMMAND_LENGTH} 字符`;
  if (!Array.isArray(input.args)) return "args 必须是字符串数组";
  if (input.args.length > MAX_ARGS) return `args 最多 ${MAX_ARGS} 项`;
  if (input.args.some((argument) => typeof argument !== "string" || argument.length > MAX_ARG_LENGTH)) {
    return `args 每项必须是字符串且最多 ${MAX_ARG_LENGTH} 字符`;
  }
  for (const [name, path] of [
    ["cwd", input.cwd],
    ["stdout_path", input.stdout_path],
    ["stderr_path", input.stderr_path],
  ] as const) {
    if (path !== undefined && (!path || path.length > MAX_PATH_LENGTH))
      return `${name} 必须非空且最多 ${MAX_PATH_LENGTH} 字符`;
  }
  const entries = Object.entries(input.env ?? {});
  if (entries.length > MAX_ENV) return `env 最多 ${MAX_ENV} 项`;
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `env 变量名无效: ${name}`;
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE_LENGTH) {
      return `env 变量值必须是字符串且最多 ${MAX_ENV_VALUE_LENGTH} 字符`;
    }
  }
  return undefined;
}

/** Creates the normalized complete configuration stored for restoration. */
export function normalizeWatchConfig(
  input: WatchInput | StartInput,
  watchId: string,
  sessionId: string,
  resume = false,
): WatchConfig {
  const base: WatchConfig = {
    watch_id: watchId,
    session_id: sessionId,
    host: input.host,
    pid: input.action === "watch" ? input.pid : 0,
    job_id: input.job_id,
    ssh_args: [...(input.ssh_args ?? [])],
    interval_seconds: input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
    startup_timeout_seconds: input.startup_timeout_seconds ?? DEFAULT_STARTUP_TIMEOUT_SECONDS,
    result_paths: [...(input.result_paths ?? [])],
    log_paths: [...(input.log_paths ?? [])],
    ...(input.note === undefined ? {} : { note: input.note }),
    resume,
  };
  if (input.action === "start") {
    return {
      ...base,
      command: input.command,
      args: [...input.args],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: { ...input.env } }),
      ...(input.stdout_path === undefined ? {} : { stdout_path: input.stdout_path }),
      ...(input.stderr_path === undefined ? {} : { stderr_path: input.stderr_path }),
    };
  }
  return base;
}

/** Returns true for states that must never be treated as active watches. */
export function isTerminalStatus(status: WatchState["status"]): status is WatchTerminalKind {
  return (["finish", "interrupt", "close", "cancelled"] as const).includes(status as WatchTerminalKind);
}
