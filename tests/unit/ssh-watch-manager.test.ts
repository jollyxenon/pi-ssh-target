import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SSH_KEEPALIVE_ARGS, PROTOCOL_PREFIX } from "../../src/constants.js";
import { SshWatchManager, type TerminalEvent } from "../../src/ssh-watch-manager.js";
import type { WatchConfig } from "../../src/types.js";

/** Builds a complete normalized watch config for unit tests. */
function config(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return {
    watch_id: "watch-1",
    session_id: "session-1",
    host: "gpu01",
    pid: 123,
    ssh_args: [],
    interval_seconds: 5,
    startup_timeout_seconds: 10,
    result_paths: [],
    log_paths: [],
    resume: false,
    ...overrides,
  };
}

/** Fake SSH child that emits a ready protocol event as soon as stdin ends. */
function fakeChild(watchId: string, host: string, rootPid: number): ChildProcessWithoutNullStreams {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { end: (chunk?: string) => void };
  stdin.end = () => {
    const ready = {
      event: "ready",
      watch_id: watchId,
      host,
      root_pid: rootPid,
      process_count: 1,
      observed_at: new Date().toISOString(),
      state_file: null,
    };
    stdout.emit("data", Buffer.from(`${PROTOCOL_PREFIX}${JSON.stringify(ready)}\n`));
  };
  return {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    on: vi.fn(),
    kill: vi.fn(),
  } as unknown as ChildProcessWithoutNullStreams;
}

type SpawnImpl = (
  command: string,
  args: string[],
  options: unknown,
) => ChildProcessWithoutNullStreams;

function managerWith(spawnMock: ReturnType<typeof vi.fn<SpawnImpl>>): SshWatchManager {
  return new SshWatchManager(
    (_config: WatchConfig, _event: TerminalEvent) => {},
    spawnMock as unknown as typeof import("node:child_process").spawn,
    "# fake watcher",
  );
}

describe("SshWatchManager default SSH keepalive args", () => {
  it("injects default keepalive options when user provides none", async () => {
    const spawnMock = vi.fn<SpawnImpl>(() => fakeChild("watch-1", "gpu01", 123));
    const manager = managerWith(spawnMock);
    const ready = await manager.start(config());
    expect(ready.event).toBe("ready");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual([
      ...DEFAULT_SSH_KEEPALIVE_ARGS,
      "--",
      "gpu01",
      "python3",
      "-",
    ]);
  });

  it("keeps user keepalive options before defaults so they override", async () => {
    const spawnMock = vi.fn<SpawnImpl>(() => fakeChild("watch-1", "gpu01", 123));
    const manager = managerWith(spawnMock);
    await manager.start(
      config({ ssh_args: ["-o", "ServerAliveInterval=60", "-o", "ServerAliveCountMax=5"] }),
    );
    expect(spawnMock.mock.calls[0]![1]).toEqual([
      "-o",
      "ServerAliveInterval=60",
      "-o",
      "ServerAliveCountMax=5",
      ...DEFAULT_SSH_KEEPALIVE_ARGS,
      "--",
      "gpu01",
      "python3",
      "-",
    ]);
  });

  it("keeps custom non-keepalive ssh args before defaults", async () => {
    const spawnMock = vi.fn<SpawnImpl>(() => fakeChild("watch-1", "gpu01", 123));
    const manager = managerWith(spawnMock);
    await manager.start(config({ ssh_args: ["-p", "2222", "-i", "/tmp/key"] }));
    expect(spawnMock.mock.calls[0]![1]).toEqual([
      "-p",
      "2222",
      "-i",
      "/tmp/key",
      ...DEFAULT_SSH_KEEPALIVE_ARGS,
      "--",
      "gpu01",
      "python3",
      "-",
    ]);
  });
});
