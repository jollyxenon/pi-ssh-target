import { statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piSshTarget from "../../src/index.js";

const originalPath = process.env.PATH;
let target: ChildProcess | undefined;

/** Minimal Pi double that resolves when terminal steer reaches the session. */
class EndToEndPi {
  public tool: any;
  public entries: any[] = [];
  private resolveMessage!: (message: any) => void;
  public terminalMessage = new Promise<any>((resolveMessage) => {
    this.resolveMessage = resolveMessage;
  });
  private handlers = new Map<string, Array<(event: any, context: any) => unknown>>();

  public on(name: string, handler: (event: any, context: any) => unknown): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }

  public registerTool(tool: any): void {
    this.tool = tool;
  }

  public appendEntry(customType: string, data: any): void {
    this.entries.push({ type: "custom", customType, data });
  }

  public sendMessage(message: any, options: any): void {
    this.resolveMessage({ message, options });
  }

  public async startSession(): Promise<void> {
    const context = {
      sessionManager: {
        getBranch: () => this.entries,
        getSessionId: () => "e2e-session",
      },
    };
    for (const handler of this.handlers.get("session_start") ?? []) await handler({}, context);
  }

  public async shutdown(): Promise<void> {
    for (const handler of this.handlers.get("session_shutdown") ?? []) await handler({}, {});
  }
}

afterEach(() => {
  process.env.PATH = originalPath;
  target?.kill("SIGKILL");
  target = undefined;
});

describe("Linux/WSL local end-to-end", () => {
  it("starts and watches a real detached process with private default logs", async () => {
    process.env.PATH = `${resolve("tests/fixtures/local-ssh")}:${originalPath ?? ""}`;
    const pi = new EndToEndPi();
    piSshTarget(pi as any);
    await pi.startSession();
    const startResult = await pi.tool.execute(
      "e2e-start",
      {
        action: "start",
        host: "local-test",
        job_id: "real-start",
        command: "python3",
        args: ["-c", "import time; print('started', flush=True); time.sleep(0.2)"],
        interval_seconds: 0.02,
        startup_timeout_seconds: 2,
      },
      undefined,
      undefined,
      {},
    );
    expect(startResult.details.outcome).toBe("started_and_watched");
    expect(startResult.details.launch.pid).toBeGreaterThan(0);
    expect(statSync(startResult.details.launch.stdout_path).mode & 0o777).toBe(0o600);
    expect(statSync(startResult.details.launch.stderr_path).mode & 0o777).toBe(0o600);

    const terminal = await Promise.race([
      pi.terminalMessage,
      new Promise((_, reject) => setTimeout(() => reject(new Error("start finish steer timeout")), 4000)),
    ]);
    expect(terminal.message.content).toContain("远程进程树已经结束");
    expect(pi.entries.map((entry) => entry.data.kind)).toEqual(["started", "finish"]);
    await pi.shutdown();
  });

  it("monitors a real parent-child process tree and steers Pi after finish", async () => {
    process.env.PATH = `${resolve("tests/fixtures/local-ssh")}:${originalPath ?? ""}`;
    target = spawn("python3", [
      "-c",
      "import subprocess,time; subprocess.Popen(['python3','-c','import time; time.sleep(0.35)']); time.sleep(0.15)",
    ]);
    if (!target.pid) throw new Error("failed to start target process");

    const pi = new EndToEndPi();
    piSshTarget(pi as any);
    await pi.startSession();
    const watchResult = await pi.tool.execute(
      "e2e-call",
      {
        action: "watch",
        host: "local-test",
        pid: target.pid,
        job_id: "real-process-tree",
        interval_seconds: 0.02,
        startup_timeout_seconds: 2,
      },
      undefined,
      undefined,
      {},
    );
    expect(watchResult.details.error).toBeUndefined();

    const terminal = await Promise.race([
      pi.terminalMessage,
      new Promise((_, reject) => setTimeout(() => reject(new Error("finish steer timeout")), 4000)),
    ]);
    expect(terminal.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(terminal.message.content).toContain("远程进程树已经结束");
    expect(pi.entries.at(-1)?.data.kind).toBe("finish");
    await pi.shutdown();
  });
});
