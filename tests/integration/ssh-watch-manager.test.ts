import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SshWatchManager, type TerminalEvent } from "../../src/ssh-watch-manager.js";
import type { WatchConfig } from "../../src/types.js";

const fixtureDir = resolve("tests/fixtures");
const originalPath = process.env.PATH;
let temporaryDir = "";

/** Builds a complete normalized watch config for integration tests. */
function config(host: string, id = "watch-1"): WatchConfig {
  return {
    watch_id: id,
    session_id: "session-1",
    host,
    pid: 123,
    job_id: `job-${id}`,
    ssh_args: ["-o", "BatchMode=yes"],
    interval_seconds: 5,
    startup_timeout_seconds: 0.08,
    result_paths: [],
    log_paths: [],
    resume: false,
  };
}

/** Waits for one event-loop delay without polling. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

describe.sequential("SshWatchManager", () => {
  beforeEach(() => {
    temporaryDir = mkdtempSync(join(tmpdir(), "pi-ssh-target-test-"));
    process.env.PATH = `${fixtureDir}:${originalPath ?? ""}`;
    process.env.FAKE_SSH_COUNT_FILE = join(temporaryDir, "count");
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_SSH_COUNT_FILE;
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it("passes ssh args, handles ready, and accepts only one terminal event", async () => {
    const terminals: TerminalEvent[] = [];
    const manager = new SshWatchManager((_config, event) => terminals.push(event), undefined, "# fake watcher");
    const ready = await manager.start(config("duplicate-terminal"));
    expect(ready.event).toBe("ready");
    await delay(30);
    expect(terminals.map((event) => event.event)).toEqual(["finish"]);
    expect(readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("synthesizes close with exit code and only the last 2000 stderr bytes", async () => {
    const terminal = new Promise<TerminalEvent>((resolveTerminal) => {
      const manager = new SshWatchManager((_config, event) => resolveTerminal(event), undefined, "# fake watcher");
      void manager.start(config("close"));
    });
    const event = await terminal;
    expect(event.event).toBe("close");
    if (event.event !== "close") throw new Error("expected close");
    expect(event.exit_code).toBe(7);
    expect(Buffer.byteLength(event.stderr_tail)).toBe(2000);
  });

  it("times out startup, kills intentionally, and never retries", async () => {
    const terminals: TerminalEvent[] = [];
    const manager = new SshWatchManager((_config, event) => terminals.push(event), undefined, "# fake watcher");
    await expect(manager.start(config("no-ready"))).rejects.toThrow("启动超时");
    await delay(30);
    expect(terminals).toEqual([]);
    expect(readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("suppresses close after intentional session shutdown", async () => {
    const terminals: TerminalEvent[] = [];
    const manager = new SshWatchManager((_config, event) => terminals.push(event), undefined, "# fake watcher");
    await manager.start(config("hang"));
    manager.closeAll();
    await delay(30);
    expect(terminals).toEqual([]);
    expect(manager.has("watch-1")).toBe(false);
  });
});
