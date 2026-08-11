import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_PREFIX, STDERR_TAIL_BYTES } from "./constants.js";
import { consumeLines, parseProtocolLine } from "./protocol.js";
import type {
  ActiveWatch,
  StartManagerResult,
  WatchCloseEvent,
  WatchConfig,
  WatcherFinishEvent,
  WatcherInterruptEvent,
  WatcherProtocolEvent,
  WatcherReadyEvent,
} from "./types.js";

export type TerminalEvent = WatcherFinishEvent | WatcherInterruptEvent | WatchCloseEvent;
export type SpawnFunction = typeof spawn;

/** Owns one independent SSH child process per active watch. */
export class SshWatchManager {
  private readonly active = new Map<string, ActiveWatch>();
  private readonly ownership = new Map<string, ActiveWatch>();
  private readonly watcherSource: string;

  public constructor(
    private readonly onTerminal: (config: WatchConfig, event: TerminalEvent) => void,
    private readonly spawnProcess: SpawnFunction = spawn,
    watcherSource?: string,
  ) {
    this.watcherSource = watcherSource ?? readFileSync(fileURLToPath(new URL("./watcher.py", import.meta.url)), "utf8");
  }

  /** Starts SSH for an existing PID and resolves after ready. */
  public start(config: WatchConfig, signal?: AbortSignal): Promise<WatcherReadyEvent> {
    return this.startInternal(config, false, signal) as Promise<WatcherReadyEvent>;
  }

  /** Starts one remote process and resolves with watched or partial-success state. */
  public startLaunch(config: WatchConfig, signal?: AbortSignal): Promise<StartManagerResult> {
    return this.startInternal(config, true, signal) as Promise<StartManagerResult>;
  }

  /** Runs the shared SSH protocol while distinguishing launch from watch startup. */
  private startInternal(
    config: WatchConfig,
    launchMode: boolean,
    signal?: AbortSignal,
  ): Promise<WatcherReadyEvent | StartManagerResult> {
    if (signal?.aborted) return Promise.reject(new Error("watch 启动已取消"));
    if (this.active.has(config.watch_id)) throw new Error(`watch 已在运行: ${config.watch_id}`);
    const args = [...config.ssh_args, "--", config.host, "python3", "-"];
    // 密码认证：askpass 脚本只读环境变量，脚本本身不含密码明文。
    const askpassPath = config.password === undefined ? undefined : createAskpassScript();
    const env =
      askpassPath === undefined
        ? undefined
        : {
            ...process.env,
            SSH_ASKPASS: askpassPath,
            SSH_ASKPASS_REQUIRE: "force",
            SSH_TARGET_PASSWORD: config.password,
          };
    const child = this.spawnProcess("ssh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env === undefined ? {} : { env }),
    }) as ChildProcessWithoutNullStreams;
    const active: ActiveWatch = {
      config,
      child,
      stderrTail: Buffer.alloc(0),
      ready: false,
      terminalHandled: false,
      intentionalClose: false,
    };
    this.active.set(config.watch_id, active);
    this.ownership.set(config.watch_id, active);

    return new Promise<WatcherReadyEvent | StartManagerResult>((resolve, reject) => {
      let stdoutRest = "";
      let settled = false;
      let readyEvent: WatcherReadyEvent | undefined;

      /** Ends local startup after remote launch without terminating the task. */
      const resolveUnwatched = (error: Error): boolean => {
        if (!launchMode || !active.launched || settled) return false;
        settled = true;
        clearTimeout(timeout);
        active.intentionalClose = true;
        child.kill();
        this.deleteIfCurrent(active);
        this.releaseOwnership(active);
        resolve({
          outcome: "started_unwatched",
          launched: active.launched,
          error: error.message,
        });
        return true;
      };

      /** Rejects startup before launch and closes only the local SSH child. */
      const failStartup = (error: Error) => {
        if (settled || resolveUnwatched(error)) return;
        settled = true;
        clearTimeout(timeout);
        active.intentionalClose = true;
        child.kill();
        this.deleteIfCurrent(active);
        this.releaseOwnership(active);
        reject(error);
      };

      const timeout = setTimeout(() => {
        const tail = active.stderrTail.toString("utf8").trim();
        failStartup(new Error(`SSH Watcher 启动超时（${config.startup_timeout_seconds} 秒）${tail ? `: ${tail}` : ""}`));
      }, config.startup_timeout_seconds * 1000);

      child.stderr.on("data", (chunk: Buffer) => {
        active.stderrTail = Buffer.concat([active.stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const consumed = consumeLines(stdoutRest, chunk);
        stdoutRest = consumed.rest;
        for (const line of consumed.lines) {
          if (!line.startsWith(PROTOCOL_PREFIX)) continue;
          let event: WatcherProtocolEvent | undefined;
          try {
            event = parseProtocolLine(line);
          } catch (error) {
            const parsedError = error instanceof Error ? error : new Error(String(error));
            if (!active.ready) failStartup(parsedError);
            else {
              this.finishOnce(active, {
                event: "interrupt",
                watch_id: config.watch_id,
                host: config.host,
                root_pid: config.pid,
                process_count: 0,
                observed_at: new Date().toISOString(),
                state_file: readyEvent?.state_file ?? null,
                error_code: "protocol_error",
                error: parsedError.message,
              });
            }
            continue;
          }
          if (!event || event.watch_id !== config.watch_id) continue;
          if (event.event === "launched") {
            if (!launchMode || active.launched) continue;
            active.launched = event;
            config.pid = event.root_pid;
            config.stdout_path = event.stdout_path;
            config.stderr_path = event.stderr_path;
            continue;
          }
          if (event.event === "ready") {
            if (active.ready) continue;
            if (launchMode && !active.launched) {
              failStartup(new Error("远程启动协议缺少 launched 事件"));
              continue;
            }
            active.ready = true;
            readyEvent = event;
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              if (launchMode) {
                const launched = active.launched;
                if (!launched) {
                  failStartup(new Error("远程启动协议缺少 launched 事件"));
                  continue;
                }
                resolve({
                  outcome: "started_and_watched",
                  ready: event,
                  launched,
                });
              } else {
                resolve(event);
              }
            }
            continue;
          }
          if (!active.ready && !config.resume) {
            const message = event.event === "interrupt" ? event.error : event.event;
            failStartup(new Error(`远程 Watcher 启动失败: ${message}`));
            continue;
          }
          this.finishOnce(active, event);
        }
      });

      child.on("error", (error) => {
        // spawn 失败不会触发 close，这里兜底清理 askpass 脚本。
        if (askpassPath !== undefined) rmSync(askpassPath, { force: true });
        if (!active.ready) failStartup(error);
      });

      child.on("close", (code, closeSignal) => {
        if (askpassPath !== undefined) rmSync(askpassPath, { force: true });
        clearTimeout(timeout);
        this.deleteIfCurrent(active);
        if (!settled && !active.ready) {
          const error = new Error(this.startupExitMessage(code, closeSignal, active.stderrTail));
          if (!resolveUnwatched(error)) {
            settled = true;
            this.releaseOwnership(active);
            reject(error);
          }
          return;
        }
        if (active.intentionalClose || active.terminalHandled || !active.ready) return;
        this.finishOnce(active, {
          event: "close",
          watch_id: config.watch_id,
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
        host: config.host,
        root_pid: config.pid,
        interval_seconds: config.interval_seconds,
        resume: config.resume,
        ...(launchMode && config.command !== undefined ? { command: config.command } : {}),
        ...(launchMode && config.args !== undefined ? { args: config.args } : {}),
        ...(launchMode && config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(launchMode && config.env !== undefined ? { env: config.env } : {}),
        ...(launchMode && config.stdout_path !== undefined ? { stdout_path: config.stdout_path } : {}),
        ...(launchMode && config.stderr_path !== undefined ? { stderr_path: config.stderr_path } : {}),
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
    this.releaseOwnership(active);
    return true;
  }

  /** Intentionally closes every session-scoped child during reload or shutdown. */
  public closeAll(): void {
    for (const active of this.active.values()) {
      active.intentionalClose = true;
      active.child.kill();
      this.releaseOwnership(active);
    }
    this.active.clear();
    this.ownership.clear();
  }

  /** Returns whether the current extension instance owns a live child. */
  public has(watchId: string): boolean {
    return this.active.has(watchId);
  }

  /** Removes a watch only if this callback still owns the active map entry. */
  private deleteIfCurrent(active: ActiveWatch): void {
    if (this.active.get(active.config.watch_id) === active)
      this.active.delete(active.config.watch_id);
  }

  /** Releases callback ownership only when this lifecycle still owns the watch ID. */
  private releaseOwnership(active: ActiveWatch): void {
    if (this.ownership.get(active.config.watch_id) === active)
      this.ownership.delete(active.config.watch_id);
  }

  /** Delivers exactly one terminal event, then ensures the SSH child is cleaned up. */
  private finishOnce(active: ActiveWatch, event: TerminalEvent): void {
    if (active.terminalHandled || active.intentionalClose) return;
    active.terminalHandled = true;
    this.deleteIfCurrent(active);
    setImmediate(() => {
      if (this.ownership.get(active.config.watch_id) !== active) return;
      this.ownership.delete(active.config.watch_id);
      this.onTerminal(active.config, event);
    });
    active.child.kill();
  }

  /** Formats bounded startup diagnostics from an early SSH exit. */
  private startupExitMessage(code: number | null, signal: NodeJS.Signals | null, stderr: Buffer): string {
    const diagnostic = stderr.toString("utf8").trim();
    return `SSH Watcher 启动前退出（code=${String(code)}, signal=${String(signal)}）${diagnostic ? `: ${diagnostic}` : ""}`;
  }
}

/** 创建一次性 askpass 脚本：只输出环境变量中的密码，脚本本身不含明文。 */
function createAskpassScript(): string {
  const scriptPath = join(tmpdir(), `pi-ssh-target-askpass-${randomUUID()}`);
  writeFileSync(
    scriptPath,
    "#!/bin/sh\nprintf '%s\\n' \"$SSH_TARGET_PASSWORD\"\n",
    { mode: 0o700 },
  );
  return scriptPath;
}
