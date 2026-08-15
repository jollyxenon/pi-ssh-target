import type {
  WatchConfig,
  WatchInput,
  WatchMetadataInput,
  WatchState,
  WatchTerminalKind,
} from "./types.js";

export const DEFAULT_INTERVAL_SECONDS = 5;
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 10;
export const DEFAULT_ACTIVE_LIMIT = 3;
export const DEFAULT_TERMINAL_LIMIT = 0;
export const MAX_LIST_LIMIT = 100;
export const MAX_DESCRIPTION = 2000;
export const MAX_NOTE = 2000;
export const MAX_PASSWORD_LENGTH = 512;
export const MAX_PATHS = 20;
export const MAX_PATH_LENGTH = 1000;
export const STDERR_TAIL_BYTES = 2000;
/** 默认 SSH 应用层保活参数：每 30 秒发保活，连续 3 次无响应（约 90 秒）客户端退出。
 * 放在用户 ssh_args 之后：OpenSSH 对重复 -o 选项第一个生效，因此用户同名选项（在前）可覆盖默认值。 */
export const DEFAULT_SSH_KEEPALIVE_ARGS = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
export const PROTOCOL_PREFIX = "@@PI_SSH_TARGET@@";
export const LIFECYCLE_ENTRY_TYPE = "pi-ssh-target-lifecycle";
export const AUDIT_ENTRY_TYPE = "pi-ssh-target-audit";
export const MESSAGE_TYPE = "pi-ssh-target-terminal";

/** Validates metadata shared by watch and start before SSH is created. */
function validateMetadata(input: WatchMetadataInput): string | undefined {
  if (!input.host) return "host 不能为空";
  if ((input.description?.length ?? 0) > MAX_DESCRIPTION)
    return `description 最多 ${MAX_DESCRIPTION} 字符`;
  if ((input.note?.length ?? 0) > MAX_NOTE) return `note 最多 ${MAX_NOTE} 字符`;
  if (input.password !== undefined && (input.password.length === 0 || input.password.length > MAX_PASSWORD_LENGTH))
    return `password 必须非空且最多 ${MAX_PASSWORD_LENGTH} 字符`;
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
    ...(input.description === undefined ? {} : { description: input.description }),
    ssh_args: [...(input.ssh_args ?? [])],
    ...(input.password === undefined ? {} : { password: input.password }),
    interval_seconds: input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
    startup_timeout_seconds: input.startup_timeout_seconds ?? DEFAULT_STARTUP_TIMEOUT_SECONDS,
    result_paths: [...(input.result_paths ?? [])],
    log_paths: [...(input.log_paths ?? [])],
    ...(input.note === undefined ? {} : { note: input.note }),
    resume,
  };
}

/** Returns true for states that must never be treated as active watches. */
export function isTerminalStatus(status: WatchState["status"]): status is WatchTerminalKind {
  return (["finish", "interrupt", "close", "cancelled"] as const).includes(status as WatchTerminalKind);
}
