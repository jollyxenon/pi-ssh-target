import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
    description: `job-${id}`,
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

  it("rejects a pre-aborted start before spawning SSH", async () => {
    const manager = new SshWatchManager(() => {}, undefined, "# fake watcher");
    const controller = new AbortController();
    controller.abort();
    await expect(manager.start(config("hang"), controller.signal)).rejects.toThrow("启动已取消");
    const countFile = process.env.FAKE_SSH_COUNT_FILE;
    if (!countFile) throw new Error("missing fake SSH count file");
    expect(existsSync(countFile)).toBe(false);
  });

  it("never relaunches a persisted start config through the watch-only path", async () => {
    const manager = new SshWatchManager(() => {}, undefined, "# fake watcher");
    const persistedStartConfig = {
      ...config("hang"),
      resume: true,
    };
    const ready = await manager.start(persistedStartConfig);
    expect(ready.root_pid).toBe(123);
    manager.closeAll();
  });

  it("injects askpass env for password auth and deletes the script on close", async () => {
    const reportFile = join(temporaryDir, "env-report");
    process.env.FAKE_SSH_REPORT_ENV_FILE = reportFile;
    const manager = new SshWatchManager(() => {}, undefined, "# fake watcher");
    const ready = await manager.start({
      ...config("password-auth"),
      password: "s3cret-pass",
    });
    expect(ready.event).toBe("ready");
    const lines = readFileSync(reportFile, "utf8").trim().split("\n");
    const report = JSON.parse(lines[0]!);
    expect(report.password).toBe("s3cret-pass");
    expect(report.require).toBe("force");
    expect(report.askpass).toBeTruthy();
    expect(report.scriptContent).toContain("$SSH_TARGET_PASSWORD");
    expect(report.scriptContent).not.toContain("s3cret-pass");
    // askpass 脚本 0700 可执行，且运行期间存在。
    expect(statSync(report.askpass).mode & 0o777).toBe(0o700);
    manager.closeAll();
    await delay(50);
    expect(existsSync(report.askpass)).toBe(false);
  });

  it("does not inject askpass env without a password", async () => {
    const reportFile = join(temporaryDir, "env-report-plain");
    process.env.FAKE_SSH_REPORT_ENV_FILE = reportFile;
    const manager = new SshWatchManager(() => {}, undefined, "# fake watcher");
    const ready = await manager.start(config("plain-auth"));
    expect(ready.event).toBe("ready");
    const report = JSON.parse(readFileSync(reportFile, "utf8").trim());
    expect(report.askpass).toBe("");
    expect(report.password).toBe("");
    manager.closeAll();
  });
});
