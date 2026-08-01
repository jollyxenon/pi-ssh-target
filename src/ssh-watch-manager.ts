import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_PREFIX, STDERR_TAIL_BYTES } from "./constants.js";
import { consumeLines, parseProtocolLine } from "./protocol.js";
import type {
  ActiveWatch,
  WatchCloseEvent,
  WatchConfig,
  WatcherFinishEvent,
  WatcherInterruptEvent,
  WatcherReadyEvent,
} from "./types.js";

export type TerminalEvent = WatcherFinishEvent | WatcherInterruptEvent | WatchCloseEvent;
export type SpawnFunction = typeof spawn;

/** Owns one independent SSH child process per active watch. */
export class SshWatchManager {
  private readonly active = new Map<string, ActiveWatch>();
  private readonly watcherSource: string;

  public constructor(
    private readonly onTerminal: (config: WatchConfig, event: TerminalEvent) => void,
    private readonly spawnProcess: SpawnFunction = spawn,
    watcherSource?: string,
  ) {
    this.watcherSource = watcherSource ?? readFileSync(fileURLToPath(new URL("./watcher.py", import.meta.url)), "utf8");
  }

  /** Starts SSH and resolves after the fixed-prefix ready handshake. */
  public start(config: WatchConfig, signal?: AbortSignal): Promise<WatcherReadyEvent> {
    if (this.active.has(config.watch_id)) throw new Error(`watch 已在运行: ${config.watch_id}`);
    const args = [...config.ssh_args, "--", config.host, "python3", "-"];
    const child = this.spawnProcess("ssh", args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const active: ActiveWatch = {
      config,
      child,
      stderrTail: Buffer.alloc(0),
      ready: false,
      terminalHandled: false,
      intentionalClose: false,
    };
    this.active.set(config.watch_id, active);

    return new Promise<WatcherReadyEvent>((resolve, reject) => {
      let stdoutRest = "";
      let settled = false;
      let readyEvent: WatcherReadyEvent | undefined;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        active.intentionalClose = true;
        child.kill();
        this.active.delete(config.watch_id);
        reject(new Error(`SSH Watcher 启动超时（${config.startup_timeout_seconds} 秒）`));
      }, config.startup_timeout_seconds * 1000);

      /** Rejects startup once and closes the local child intentionally. */
      const failStartup = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        active.intentionalClose = true;
        child.kill();
        this.active.delete(config.watch_id);
        reject(error);
      };

      child.stderr.on("data", (chunk: Buffer) => {
        active.stderrTail = Buffer.concat([active.stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const consumed = consumeLines(stdoutRest, chunk);
        stdoutRest = consumed.rest;
        for (const line of consumed.lines) {
          if (!line.startsWith(PROTOCOL_PREFIX)) continue;
          let event;
          try {
            event = parseProtocolLine(line);
          } catch (error) {
            if (!active.ready) {
              failStartup(error instanceof Error ? error : new Error(String(error)));
            } else {
              this.finishOnce(active, {
                event: "interrupt",
                watch_id: config.watch_id,
                job_id: config.job_id,
                host: config.host,
                root_pid: config.pid,
                process_count: 0,
                observed_at: new Date().toISOString(),
                state_file: readyEvent?.state_file ?? null,
                error_code: "protocol_error",
                error: error instanceof Error ? error.message : String(error),
              });
            }
            continue;
          }
          if (!event || event.watch_id !== config.watch_id) continue;
          if (event.event === "ready") {
            if (active.ready) continue;
            active.ready = true;
            readyEvent = event;
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(event);
            }
            continue;
          }
          if (!active.ready && !config.resume) {
            failStartup(new Error(`远程 Watcher 启动失败: ${event.event === "interrupt" ? event.error : event.event}`));
            continue;
          }
          this.finishOnce(active, event);
        }
      });

      child.on("error", (error) => {
        if (!active.ready) failStartup(error);
      });

      child.on("close", (code, closeSignal) => {
        clearTimeout(timeout);
        this.active.delete(config.watch_id);
        if (!settled && !active.ready) {
          settled = true;
          reject(new Error(this.startupExitMessage(code, closeSignal, active.stderrTail)));
          return;
        }
        if (active.intentionalClose || active.terminalHandled || !active.ready) return;
        this.finishOnce(active, {
          event: "close",
          watch_id: config.watch_id,
          job_id: config.job_id,
          host: config.host,
          root_pid: config.pid,
          process_count: 0,
          observed_at: new Date().toISOString(),
          state_file: readyEvent?.state_file ?? null,
          exit_code: code,
          signal: closeSignal,
          stderr_tail: active.stderrTail.toString("utf8"),
        });
      });

      if (signal) {
        signal.addEventListener("abort", () => failStartup(new Error("watch 启动已取消")), { once: true });
      }

      const remoteConfig = {
        watch_id: config.watch_id,
        session_id: config.session_id,
        job_id: config.job_id,
        host: config.host,
        root_pid: config.pid,
        interval_seconds: config.interval_seconds,
        resume: config.resume,
      };
      const serialized = JSON.stringify(JSON.stringify(remoteConfig));
      child.stdin.end(`import json\nWATCHER_CONFIG = json.loads(${serialized})\n${this.watcherSource}`);
    });
  }

  /** Intentionally closes one active SSH child without creating close terminal state. */
  public cancel(watchId: string): boolean {
    const active = this.active.get(watchId);
    if (!active) return false;
    active.intentionalClose = true;
    active.child.kill();
    this.active.delete(watchId);
    return true;
  }

  /** Intentionally closes every session-scoped child during reload or shutdown. */
  public closeAll(): void {
    for (const active of this.active.values()) {
      active.intentionalClose = true;
      active.child.kill();
    }
    this.active.clear();
  }

  /** Returns whether the current extension instance owns a live child. */
  public has(watchId: string): boolean {
    return this.active.has(watchId);
  }

  /** Delivers exactly one terminal event, then ensures the SSH child is cleaned up. */
  private finishOnce(active: ActiveWatch, event: TerminalEvent): void {
    if (active.terminalHandled || active.intentionalClose) return;
    active.terminalHandled = true;
    this.active.delete(active.config.watch_id);
    setImmediate(() => this.onTerminal(active.config, event));
    active.child.kill();
  }

  /** Formats bounded startup diagnostics from an early SSH exit. */
  private startupExitMessage(code: number | null, signal: NodeJS.Signals | null, stderr: Buffer): string {
    const diagnostic = stderr.toString("utf8").trim();
    return `SSH Watcher 启动前退出（code=${String(code)}, signal=${String(signal)}）${diagnostic ? `: ${diagnostic}` : ""}`;
  }
}
