import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Terminal states persisted for one watch. */
export type WatchTerminalKind = "finish" | "interrupt" | "close" | "cancelled";

/** Public watch action parameters. */
export interface WatchInput {
  action: "watch";
  host: string;
  pid: number;
  job_id: string;
  ssh_args?: string[];
  interval_seconds?: number;
  startup_timeout_seconds?: number;
  result_paths?: string[];
  log_paths?: string[];
  note?: string;
}

/** Public cancel action parameters. */
export interface CancelInput {
  action: "cancel";
  watch_id: string;
}

/** Public list action parameters. */
export interface ListInput {
  action: "list";
  active_limit?: number;
  terminal_limit?: number;
}

/** Combined custom tool parameters. */
export type ToolInput = WatchInput | CancelInput | ListInput;

/** Complete restart configuration persisted in the Pi session. */
export interface WatchConfig {
  watch_id: string;
  session_id: string;
  host: string;
  pid: number;
  job_id: string;
  ssh_args: string[];
  interval_seconds: number;
  startup_timeout_seconds: number;
  result_paths: string[];
  log_paths: string[];
  note?: string;
  resume: boolean;
}

/** Common fields emitted by the remote watcher protocol. */
export interface WatcherProtocolBase {
  watch_id: string;
  job_id: string;
  host: string;
  root_pid: number;
  process_count: number;
  observed_at: string;
  state_file: string | null;
}

/** Remote watcher startup handshake. */
export interface WatcherReadyEvent extends WatcherProtocolBase {
  event: "ready";
}

/** Remote watcher normal terminal event. */
export interface WatcherFinishEvent extends WatcherProtocolBase {
  event: "finish";
}

/** Remote watcher interruption event. */
export interface WatcherInterruptEvent extends WatcherProtocolBase {
  event: "interrupt";
  error_code: string;
  error: string;
}

/** Every valid remote stdout protocol event. */
export type WatcherProtocolEvent = WatcherReadyEvent | WatcherFinishEvent | WatcherInterruptEvent;

/** Local close terminal metadata synthesized from SSH exit. */
export interface WatchCloseEvent extends WatcherProtocolBase {
  event: "close";
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stderr_tail: string;
}

/** Session lifecycle record stored as a Pi custom entry. */
export interface WatchLifecycleRecord {
  version: 1;
  kind: "started" | WatchTerminalKind;
  watch_id: string;
  at: string;
  config: WatchConfig;
  event?: WatcherFinishEvent | WatcherInterruptEvent | WatchCloseEvent;
}

/** Current state reconstructed from lifecycle records. */
export interface WatchState {
  config: WatchConfig;
  status: "started" | WatchTerminalKind;
  updated_at: string;
  event?: WatcherFinishEvent | WatcherInterruptEvent | WatchCloseEvent;
}

/** Active local process and protocol bookkeeping. */
export interface ActiveWatch {
  config: WatchConfig;
  child: ChildProcessWithoutNullStreams;
  stderrTail: Buffer;
  ready: boolean;
  terminalHandled: boolean;
  intentionalClose: boolean;
}

/** JSON schema persisted by the remote Python watcher. */
export interface RemoteStateFile {
  version: 1;
  config: Record<string, unknown>;
  boot_id: string;
  processes: Array<{
    pid: number;
    start_ticks: number;
    started_at: string;
    ended_at: string | null;
  }>;
  last_scanned_at: string | null;
  terminal: "finish" | null;
}

/** Bounded state summary returned by list. */
export interface WatchSummary {
  watch_id: string;
  status: WatchState["status"];
  host: string;
  pid: number;
  job_id: string;
  updated_at: string;
  process_count?: number;
  state_file?: string | null;
}

/** Compact result details returned by pi_ssh_target. */
export interface ToolDetails {
  action: ToolInput["action"];
  watch?: WatchState | WatchSummary;
  active?: WatchSummary[];
  terminal?: WatchSummary[];
  error?: string;
}
