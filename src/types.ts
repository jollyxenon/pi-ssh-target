import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Terminal states persisted for one watch. */
export type WatchTerminalKind = "finish" | "interrupt" | "close" | "cancelled";
export type WatchStatus = "started" | "started_unwatched" | WatchTerminalKind;
export type StartOutcome = "started_and_watched" | "started_unwatched" | "launch_failed";

/** Metadata shared by watch and start actions. */
export interface WatchMetadataInput {
  host: string;
  description?: string;
  ssh_args?: string[];
  interval_seconds?: number;
  startup_timeout_seconds?: number;
  result_paths?: string[];
  log_paths?: string[];
  note?: string;
}

/** Public watch action parameters. */
export interface WatchInput extends WatchMetadataInput {
  action: "watch";
  pid: number;
}

/** Public start action parameters. */
export interface StartInput extends WatchMetadataInput {
  action: "start";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdout_path?: string;
  stderr_path?: string;
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
export type ToolInput = WatchInput | StartInput | CancelInput | ListInput;

/** Complete restart configuration persisted in the Pi session. */
export interface WatchConfig {
  watch_id: string;
  session_id: string;
  host: string;
  pid: number;
  description?: string;
  ssh_args: string[];
  interval_seconds: number;
  startup_timeout_seconds: number;
  result_paths: string[];
  log_paths: string[];
  note?: string;
  resume: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdout_path?: string;
  stderr_path?: string;
}

/** Common fields emitted by the remote watcher protocol. */
export interface WatcherProtocolBase {
  watch_id: string;
  host: string;
  root_pid: number;
  process_count: number;
  observed_at: string;
  state_file: string | null;
}

/** Remote process launch handshake. */
export interface WatcherLaunchedEvent extends WatcherProtocolBase {
  event: "launched";
  stdout_path: string;
  stderr_path: string;
}

/** Remote watcher startup handshake. */
export interface WatcherReadyEvent extends WatcherProtocolBase {
  event: "ready";
  stdout_path?: string;
  stderr_path?: string;
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
export type WatcherProtocolEvent =
  | WatcherLaunchedEvent
  | WatcherReadyEvent
  | WatcherFinishEvent
  | WatcherInterruptEvent;

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
  kind: WatchStatus;
  watch_id: string;
  at: string;
  config: WatchConfig;
  origin?: "audit";
  event?: WatcherFinishEvent | WatcherInterruptEvent | WatchCloseEvent;
  error?: string;
}

/** Current state reconstructed from lifecycle records. */
export interface WatchState {
  config: WatchConfig;
  status: WatchStatus;
  updated_at: string;
  origin?: "audit";
  event?: WatcherFinishEvent | WatcherInterruptEvent | WatchCloseEvent;
  error?: string;
}

/** Active local process and protocol bookkeeping. */
export interface ActiveWatch {
  config: WatchConfig;
  child: ChildProcessWithoutNullStreams;
  stderrTail: Buffer;
  ready: boolean;
  launched?: WatcherLaunchedEvent;
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
  description?: string;
  updated_at: string;
  origin?: "audit";
  process_count?: number;
  state_file?: string | null;
  error?: string;
}

/** Bounded background audit summary returned by list. */
export interface AuditSummary {
  hash: string;
  status: "completed" | "failed" | "discarded";
  at: string;
  candidate_count: number;
  evidence_count: number;
  watch_ids: string[];
  error?: string;
}

/** Start result returned by SshWatchManager. */
export type StartManagerResult =
  | {
      outcome: "started_and_watched";
      ready: WatcherReadyEvent;
      launched: WatcherLaunchedEvent;
    }
  | {
      outcome: "started_unwatched";
      launched: WatcherLaunchedEvent;
      error: string;
    };

/** Compact result details returned by pi_ssh_target. */
export interface ToolDetails {
  action: ToolInput["action"];
  outcome?: StartOutcome;
  watch?: WatchState | WatchSummary;
  active?: WatchSummary[];
  unwatched?: WatchSummary[];
  terminal?: WatchSummary[];
  audits?: AuditSummary[];
  launch?: {
    host: string;
    pid: number;
    command: string;
    args: string[];
    stdout_path: string;
    stderr_path: string;
  };
  error?: string;
}
