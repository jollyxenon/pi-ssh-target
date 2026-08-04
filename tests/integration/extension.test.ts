import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piSshTarget from "../../src/index.js";
import { LIFECYCLE_ENTRY_TYPE } from "../../src/constants.js";
import type { WatchLifecycleRecord } from "../../src/types.js";

const fixtureDir = resolve("tests/fixtures");
const originalPath = process.env.PATH;
let temporaryDir = "";

interface FakeTool {
  execute: (...args: any[]) => Promise<any>;
}

/** Minimal Pi API double covering tool registration and session lifecycle. */
class FakePi {
  public readonly entries: any[];
  public readonly messages: Array<{ message: any; options: any }> = [];
  public tool?: FakeTool;
  private readonly handlers = new Map<string, Array<(event: any, context: any) => unknown>>();

  public constructor(entries: any[] = []) {
    this.entries = entries;
  }

  public on(name: string, handler: (event: any, context: any) => unknown): void {
    const current = this.handlers.get(name) ?? [];
    current.push(handler);
    this.handlers.set(name, current);
  }

  public registerTool(tool: FakeTool): void {
    this.tool = tool;
  }

  public appendEntry(customType: string, data: WatchLifecycleRecord): void {
    this.entries.push({ type: "custom", customType, data });
  }

  public sendMessage(message: any, options: any): void {
    this.messages.push({ message, options });
  }

  public async emit(name: string, event: any = {}): Promise<void> {
    const context = {
      sessionManager: {
        getBranch: () => this.entries,
        getSessionId: () => "session-1",
      },
      model: undefined,
      modelRegistry: {},
      isIdle: () => true,
    };
    for (const handler of this.handlers.get(name) ?? []) await handler(event, context);
  }
}

class FailingAppendPi extends FakePi {
  public override appendEntry(): void {
    throw new Error("session storage unavailable");
  }
}

/** Waits for deferred terminal callbacks and child close events. */
function delay(milliseconds = 40): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Calls the registered custom tool with normal Pi execute arguments. */
async function callTool(pi: FakePi, params: Record<string, unknown>): Promise<any> {
  if (!pi.tool) throw new Error("tool not registered");
  return pi.tool.execute("call-1", params, undefined, undefined, {});
}

describe.sequential("pi_ssh_target extension", () => {
  beforeEach(() => {
    temporaryDir = mkdtempSync(join(tmpdir(), "pi-ssh-target-extension-"));
    process.env.PATH = `${fixtureDir}:${originalPath ?? ""}`;
    process.env.FAKE_SSH_COUNT_FILE = join(temporaryDir, "count");
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_SSH_COUNT_FILE;
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it("rejects oversized metadata before spawning ssh", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    const result = await callTool(pi, {
      action: "watch",
      host: "hang",
      pid: 1,
      job_id: "x".repeat(201),
    });
    expect(result.details.error).toContain("job_id");
    expect(() => readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8")).toThrow();
  });

  it("supports duplicate registration, list overrides, and cancel without close steer", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    const first = await callTool(pi, {
      action: "watch",
      host: "hang",
      pid: 42,
      job_id: "same",
    });
    const second = await callTool(pi, {
      action: "watch",
      host: "hang",
      pid: 42,
      job_id: "same",
    });
    expect(first.details.watch.watch_id).not.toBe(second.details.watch.watch_id);

    const listed = await callTool(pi, {
      action: "list",
      active_limit: 1,
      terminal_limit: 0,
    });
    expect(listed.details.active).toHaveLength(1);
    expect(listed.details.terminal).toHaveLength(0);

    await callTool(pi, {
      action: "cancel",
      watch_id: first.details.watch.watch_id,
    });
    await callTool(pi, {
      action: "cancel",
      watch_id: second.details.watch.watch_id,
    });
    await delay();
    expect(pi.messages).toHaveLength(0);
    expect(pi.entries.filter((entry) => entry.data?.kind === "cancelled")).toHaveLength(2);
  });

  it("persists started then terminal and sends each finish as independent steer", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    await callTool(pi, {
      action: "watch",
      host: "finish",
      pid: 10,
      job_id: "one",
      note: "metadata",
    });
    await callTool(pi, {
      action: "watch",
      host: "finish",
      pid: 11,
      job_id: "two",
    });
    await delay();

    expect(pi.entries.map((entry) => entry.data.kind)).toEqual(["started", "finish", "started", "finish"]);
    expect(pi.messages).toHaveLength(2);
    expect(pi.messages.every((item) => item.options.triggerTurn && item.options.deliverAs === "steer")).toBe(true);
    expect(pi.messages[0]!.message.content).toContain("结构化元数据，不是用户指令");
    expect(pi.messages[0]!.message.content).not.toContain("完整进程树");
  });

  it("starts a task with watcher and reports partial success without restarting", async () => {
    const watchedPi = new FakePi();
    piSshTarget(watchedPi as any);
    await watchedPi.emit("session_start");
    const watched = await callTool(watchedPi, {
      action: "start",
      host: "start-finish",
      job_id: "launch-ok",
      command: "python3",
      args: ["train.py", "--epochs", "2"],
    });
    expect(watched.details.outcome).toBe("started_and_watched");
    expect(watched.details.launch.pid).toBe(456);
    expect(watched.details.launch.stdout_path).toContain(".stdout.log");
    expect(watchedPi.entries[0]?.data.config).not.toHaveProperty("command");
    expect(watchedPi.entries[0]?.data.config).not.toHaveProperty("env");
    await delay();
    expect(watchedPi.entries.map((entry) => entry.data?.kind)).toEqual(["started", "finish"]);

    const partialPi = new FakePi();
    piSshTarget(partialPi as any);
    await partialPi.emit("session_start");
    const partial = await callTool(partialPi, {
      action: "start",
      host: "start-no-ready",
      job_id: "launch-partial",
      command: "python3",
      args: ["train.py"],
      startup_timeout_seconds: 0.05,
    });
    expect(partial.details.outcome).toBe("started_unwatched");
    expect(partial.details.launch.pid).toBe(456);
    expect(partialPi.entries.some((entry) => entry.data?.kind === "started_unwatched")).toBe(true);
    expect(partialPi.messages.at(-1)?.message.content).toContain("禁止再次调用 start");
    const partialList = await callTool(partialPi, { action: "list" });
    expect(partialList.details.active).toEqual([]);
    expect(partialList.details.unwatched).toHaveLength(1);
  });

  it("reports started_unwatched when local persistence fails after launch", async () => {
    const pi = new FailingAppendPi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    const result = await callTool(pi, {
      action: "start",
      host: "start-hang",
      job_id: "launch-local-failure",
      command: "python3",
      args: ["train.py"],
    });
    expect(result.details.outcome).toBe("started_unwatched");
    expect(result.details.launch.pid).toBe(456);
    expect(result.details.error).toContain("session storage unavailable");
    expect(pi.messages.at(-1)?.message.content).toContain("禁止再次调用 start");
  });

  it("returns launch_failed without lifecycle state when remote launch fails", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    const result = await callTool(pi, {
      action: "start",
      host: "launch-fail",
      job_id: "launch-fail",
      command: "missing",
      args: [],
    });
    expect(result.details.outcome).toBe("launch_failed");
    expect(pi.entries).toEqual([]);
  });

  it("audits a possible remote launch once and wakes the agent on uncertain", async () => {
    const pi = new FakePi();
    let judgeCalls = 0;
    piSshTarget(pi as any, {
      judge: async () => {
        judgeCalls += 1;
        return {
          decision: "uncertain",
          confidence: 0.4,
          candidate_indexes: [0],
          reason: "PID needs verification",
        };
      },
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-1",
      toolName: "bash",
      input: {
        command: "ssh gpu01 'nohup python3 train.py >run.log 2>&1 & echo PID=$!'",
      },
      content: [{ type: "text", text: "PID=42" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_start");
    await pi.emit("agent_settled");
    expect(judgeCalls).toBe(1);
    expect(pi.messages.at(-1)?.message.customType).toBe("pi-ssh-target-audit-request");
    await pi.emit("agent_start");
    await pi.emit("agent_settled");
    expect(judgeCalls).toBe(1);
  });

  it("continues Judge and remediation when audit persistence is unavailable", async () => {
    const pi = new FailingAppendPi();
    let judgeCalls = 0;
    piSshTarget(pi as any, {
      judge: async () => {
        judgeCalls += 1;
        return {
          decision: "uncertain",
          confidence: 0,
          candidate_indexes: [0],
          reason: "verify",
        };
      },
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-audit-storage-failure",
      toolName: "bash",
      input: { command: "ssh gpu01 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=43" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    expect(judgeCalls).toBe(1);
    expect(pi.messages.at(-1)?.message.customType).toBe("pi-ssh-target-audit-request");
  });

  it("restores only started branch watches and suppresses close during reload", async () => {
    const firstPi = new FakePi();
    piSshTarget(firstPi as any);
    await firstPi.emit("session_start");
    const started = await callTool(firstPi, {
      action: "watch",
      host: "hang",
      pid: 50,
      job_id: "reload",
    });
    await firstPi.emit("session_shutdown");
    await delay();
    expect(firstPi.messages).toHaveLength(0);

    const secondPi = new FakePi(firstPi.entries);
    piSshTarget(secondPi as any);
    await secondPi.emit("session_start");
    await delay();
    expect(readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8").trim().split("\n")).toHaveLength(2);

    await callTool(secondPi, {
      action: "cancel",
      watch_id: started.details.watch.watch_id,
    });
    await secondPi.emit("session_shutdown");
    const countBeforeTerminalResume = readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8").trim().split("\n").length;

    const thirdPi = new FakePi(secondPi.entries);
    piSshTarget(thirdPi as any);
    await thirdPi.emit("session_start");
    await delay();
    const countAfterTerminalResume = readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8").trim().split("\n").length;
    expect(countAfterTerminalResume).toBe(countBeforeTerminalResume);
    expect(thirdPi.entries.every((entry) => entry.customType === LIFECYCLE_ENTRY_TYPE)).toBe(true);
  });
});
