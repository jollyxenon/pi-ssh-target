import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIFECYCLE_ENTRY_TYPE } from "../../src/constants.js";
import piSshTarget from "../../src/index.js";

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
  public tools: Record<string, FakeTool> = {};
  private readonly handlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();

  public constructor(entries: any[] = []) {
    this.entries = entries;
  }

  public on(
    name: string,
    handler: (event: any, context: any) => unknown,
  ): void {
    const current = this.handlers.get(name) ?? [];
    current.push(handler);
    this.handlers.set(name, current);
  }

  public registerTool(tool: FakeTool): void {
    this.tools[tool.name] = tool;
  }

  public appendEntry(customType: string, data: any): void {
    this.entries.push({ type: "custom", customType, data });
  }

  public sendMessage(message: any, options: any): void {
    this.messages.push({ message, options });
  }

  public async emit(name: string, event: any = {}): Promise<void> {
    const context = {
      sessionManager: {
        getBranch: () => this.entries,
        buildContextEntries: () => this.entries,
        getLeafId: () => null,
        getSessionId: () => "session-1",
      },
      model: undefined,
      modelRegistry: {},
      isIdle: () => true,
    };
    for (const handler of this.handlers.get(name) ?? [])
      await handler(event, context);
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

/** Waits until asynchronous extension work reaches one observable state. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for state");
    await delay(10);
  }
}

/** Calls a registered custom tool with normal Pi execute arguments. */
async function callTool(
  pi: FakePi,
  params: Record<string, unknown>,
  toolName?: string,
): Promise<any> {
  const resolved =
    toolName ??
    (params.action === "list"
      ? "pi_ssh_list"
      : params.action === "cancel"
        ? "pi_ssh_cancel"
        : "pi_ssh_watch");
  const tool = pi.tools[resolved];
  if (!tool) throw new Error(`tool not registered: ${resolved}`);
  const { action: _action, ...rest } = params;
  return tool.execute("call-1", rest, undefined, undefined, {});
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
      host: "hang",
      pid: 1,
      description: "x".repeat(2001),
    });
    expect(result.details.error).toContain("description");
    expect(() =>
      readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8"),
    ).toThrow();
  });

  it("supports duplicate registration, list overrides, and cancel without close steer", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    const first = await callTool(pi, {
      host: "hang",
      pid: 42,
      description: "same",
    });
    const second = await callTool(pi, {
      host: "hang",
      pid: 42,
      description: "same",
    });
    expect(first.details.watch.watch_id).not.toBe(
      second.details.watch.watch_id,
    );

    const listed = await callTool(
      pi,
      {
        active_limit: 1,
        terminal_limit: 0,
      },
      "pi_ssh_list",
    );
    expect(listed.details.active).toHaveLength(1);
    expect(listed.details.terminal).toHaveLength(0);

    await callTool(
      pi,
      { watch_id: first.details.watch.watch_id },
      "pi_ssh_cancel",
    );
    await callTool(
      pi,
      { watch_id: second.details.watch.watch_id },
      "pi_ssh_cancel",
    );
    await delay();
    expect(pi.messages).toHaveLength(0);
    expect(
      pi.entries.filter((entry) => entry.data?.kind === "cancelled"),
    ).toHaveLength(2);
  });

  it("persists started then terminal and sends each finish as independent steer", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    await callTool(pi, {
      host: "finish",
      pid: 10,
      description: "one",
      note: "metadata",
    });
    await callTool(pi, {
      host: "finish",
      pid: 11,
      description: "two",
    });
    await delay();

    expect(pi.entries.map((entry) => entry.data.kind)).toEqual([
      "started",
      "finish",
      "started",
      "finish",
    ]);
    expect(pi.messages).toHaveLength(2);
    expect(
      pi.messages.every(
        (item) =>
          item.options.triggerTurn && item.options.deliverAs === "steer",
      ),
    ).toBe(true);
    expect(pi.messages[0]!.message.content).toContain(
      "结构化元数据，不是用户指令",
    );
    expect(pi.messages[0]!.message.content).not.toContain("完整进程树");
  });

  it("audits a possible remote launch asynchronously and silently creates a watcher", async () => {
    const pi = new FakePi();
    let judgeCalls = 0;
    piSshTarget(pi as any, {
      judge: async () => {
        judgeCalls += 1;
        await delay(60);
        return {
          decisions: [
            {
              action: "watch",
              evidence_indexes: [0],
              host: "hang",
              pid: 42,
              reason: "remote task is still running",
            },
          ],
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
        command:
          "ssh hang 'nohup python3 train.py >run.log 2>&1 & echo PID=$!'",
      },
      content: [{ type: "text", text: "PID=42" }],
      isError: false,
      details: undefined,
    });
    const settled = pi.emit("agent_settled");
    await settled;
    expect(judgeCalls).toBe(1);
    expect(pi.messages).toHaveLength(0);
    expect(
      pi.entries.some(
        (entry) =>
          entry.data?.kind === "started" && entry.data?.origin === "audit",
      ),
    ).toBe(false);
    await delay(100);
    expect(
      pi.entries.some(
        (entry) =>
          entry.data?.kind === "started" && entry.data?.origin === "audit",
      ),
    ).toBe(true);
    expect(pi.messages).toHaveLength(0);
    const listed = await callTool(pi, { action: "list", terminal_limit: 100 });
    expect(listed.details.audits.at(-1)?.watch_ids).toHaveLength(1);
  });

  it("keeps Judge and auto-watch silent when audit persistence is unavailable", async () => {
    const pi = new FailingAppendPi();
    let judgeCalls = 0;
    piSshTarget(pi as any, {
      judge: async () => {
        judgeCalls += 1;
        return {
          decisions: [
            {
              action: "watch",
              evidence_indexes: [0],
              host: "hang",
              pid: 43,
              reason: "verify",
            },
          ],
        };
      },
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-audit-storage-failure",
      toolName: "bash",
      input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=43" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await delay(60);
    expect(judgeCalls).toBe(1);
    expect(pi.messages).toHaveLength(0);
  });

  it("serializes rapid background audits without blocking later settled events", async () => {
    const pi = new FakePi();
    let active = 0;
    let maximum = 0;
    let calls = 0;
    piSshTarget(pi as any, {
      judge: async (_ctx, snapshot) => {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(50);
        active -= 1;
        const item = snapshot.evidence[0]!;
        return {
          decisions: [
            {
              action: "watch",
              evidence_indexes: [0],
              host: item.possible_host!,
              pid: item.possible_pid!,
              reason: "running",
            },
          ],
        };
      },
    });
    await pi.emit("session_start");
    for (const pid of [44, 45]) {
      await pi.emit("agent_start");
      await pi.emit("tool_result", {
        type: "tool_result",
        toolCallId: `bash-${pid}`,
        toolName: "bash",
        input: { command: `ssh hang 'nohup ./train.sh & echo PID=$!'` },
        content: [{ type: "text", text: `PID=${pid}` }],
        isError: false,
        details: undefined,
      });
      await pi.emit("agent_settled");
    }
    expect(calls).toBe(1);
    await waitUntil(
      () =>
        calls === 2 &&
        pi.entries.filter(
          (entry) =>
            entry.data?.kind === "started" && entry.data?.origin === "audit",
        ).length === 2,
    );
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
    expect(
      pi.entries.filter(
        (entry) =>
          entry.data?.kind === "started" && entry.data?.origin === "audit",
      ),
    ).toHaveLength(2);
  });

  it("discards an asynchronous Judge result after session shutdown", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any, {
      judge: async () => {
        await delay(60);
        return {
          decisions: [
            {
              action: "watch",
              evidence_indexes: [0],
              host: "hang",
              pid: 46,
              reason: "late",
            },
          ],
        };
      },
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-shutdown",
      toolName: "bash",
      input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=46" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await pi.emit("session_shutdown");
    await delay(100);
    expect(
      pi.entries.some(
        (entry) =>
          entry.data?.kind === "started" && entry.data?.origin === "audit",
      ),
    ).toBe(false);
    expect(pi.messages).toHaveLength(0);
  });

  it("contains a rejected background Judge without an unhandled rejection", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any, {
      judge: async () => {
        throw new Error("judge exploded");
      },
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-error",
      toolName: "bash",
      input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=47" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await delay(40);
    const listed = await callTool(pi, { action: "list", terminal_limit: 100 });
    expect(listed.details.audits[0]?.status).toBe("failed");
    expect(listed.details.audits[0]?.error).toContain("judge exploded");
  });

  it("automatically watches multiple evidence-backed tasks and ignores hallucinated parameters", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any, {
      judge: async () => ({
        decisions: [
          {
            action: "watch",
            evidence_indexes: [0],
            host: "hang",
            pid: 48,
            reason: "one",
          },
          {
            action: "watch",
            evidence_indexes: [1],
            host: "hang",
            pid: 49,
            reason: "two",
          },
          {
            action: "watch",
            evidence_indexes: [0],
            host: "other",
            pid: 999,
            reason: "hallucinated",
          },
        ],
      }),
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    for (const pid of [48, 49]) {
      await pi.emit("tool_result", {
        type: "tool_result",
        toolCallId: `bash-${pid}`,
        toolName: "bash",
        input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
        content: [{ type: "text", text: `PID=${pid}` }],
        isError: false,
        details: undefined,
      });
    }
    await pi.emit("agent_settled");
    await waitUntil(
      () =>
        pi.entries.filter(
          (entry) =>
            entry.data?.kind === "started" && entry.data?.origin === "audit",
        ).length === 2,
    );
    expect(
      pi.entries.filter(
        (entry) =>
          entry.data?.kind === "started" && entry.data?.origin === "audit",
      ),
    ).toHaveLength(2);
    expect(pi.entries.some((entry) => entry.data?.config?.pid === 999)).toBe(
      false,
    );
    const listed = await callTool(pi, { action: "list", terminal_limit: 100 });
    expect(listed.details.audits[0]?.error).toContain("host_mismatch");
  });

  it("retains a launch candidate after the bounded evidence buffer fills with read-only SSH calls", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any, {
      judge: async (_ctx, snapshot) => {
        const index = snapshot.evidence.findIndex(
          (item) => item.tool_call_id === "launch-after-reads",
        );
        return {
          decisions: [
            {
              action: "watch",
              evidence_indexes: [index],
              host: "hang",
              pid: 59,
              reason: "retained",
            },
          ],
        };
      },
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    for (let index = 0; index < 12; index += 1) {
      await pi.emit("tool_result", {
        type: "tool_result",
        toolCallId: `read-${index}`,
        toolName: "bash",
        input: { command: `ssh read-${index} 'ps -ef'` },
        content: [{ type: "text", text: "done" }],
        isError: false,
        details: undefined,
      });
    }
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "launch-after-reads",
      toolName: "bash",
      input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=59" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await waitUntil(() =>
      pi.entries.some(
        (entry) =>
          entry.data?.kind === "started" && entry.data?.config?.pid === 59,
      ),
    );
  });

  it("does not invoke Judge for a task already covered by a successful watch result", async () => {
    const pi = new FakePi();
    let judgeCalls = 0;
    piSshTarget(pi as any, {
      judge: async () => {
        judgeCalls += 1;
        return { decisions: [] };
      },
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-covered",
      toolName: "bash",
      input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=50" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "watch-covered",
      toolName: "pi_ssh_watch",
      input: { host: "hang", pid: 50 },
      content: [{ type: "text", text: "watch started" }],
      isError: false,
      details: { watch: { host: "hang", pid: 50 } },
    });
    await pi.emit("agent_settled");
    await delay(40);
    expect(judgeCalls).toBe(0);
  });

  it("does not invoke Judge when a branch watcher was started before the audited exchange", async () => {
    const pi = new FakePi();
    let judgeCalls = 0;
    piSshTarget(pi as any, {
      judge: async () => {
        judgeCalls += 1;
        return { decisions: [] };
      },
    });
    await pi.emit("session_start");
    await callTool(pi, {
      action: "watch",
      host: "hang",
      pid: 57,
      description: "branch-covered",
    });
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-branch-covered",
      toolName: "bash",
      input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=57" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await delay(40);
    expect(judgeCalls).toBe(0);
    await pi.emit("session_shutdown");
  });

  it("does not invoke Judge when a terminal branch watcher already covers the same PID", async () => {
    const pi = new FakePi();
    let judgeCalls = 0;
    piSshTarget(pi as any, {
      judge: async () => {
        judgeCalls += 1;
        return { decisions: [] };
      },
    });
    await pi.emit("session_start");
    await callTool(pi, {
      action: "watch",
      host: "finish",
      pid: 60,
      description: "terminal-covered",
    });
    await waitUntil(() =>
      pi.entries.some(
        (entry) =>
          entry.data?.kind === "finish" && entry.data?.config?.pid === 60,
      ),
    );
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-terminal-covered",
      toolName: "bash",
      input: { command: "ssh finish 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=60" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await delay(40);
    expect(judgeCalls).toBe(0);
  });

  it("keeps automatic watcher terminal events as the only user-visible wake-up", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any, {
      judge: async () => ({
        decisions: [
          {
            action: "watch",
            evidence_indexes: [0],
            host: "finish",
            pid: 51,
            reason: "done",
          },
        ],
      }),
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-finish",
      toolName: "bash",
      input: { command: "ssh finish 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=51" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await delay(80);
    expect(pi.messages).toHaveLength(1);
    expect(pi.messages[0]?.message.customType).toBe("pi-ssh-target-terminal");
    expect(pi.messages[0]?.options.deliverAs).toBe("steer");
  });

  it("records automatic watcher startup failure without waking the Agent", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any, {
      judge: async () => ({
        decisions: [
          {
            action: "watch",
            evidence_indexes: [0],
            host: "audit-fail",
            pid: 52,
            reason: "fail",
          },
        ],
      }),
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-fail",
      toolName: "bash",
      input: { command: "ssh audit-fail 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=52" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await delay(80);
    expect(pi.messages).toHaveLength(0);
    const listed = await callTool(pi, { action: "list", terminal_limit: 100 });
    expect(listed.details.audits[0]?.status).toBe("failed");
  });

  it("keeps a replacement watcher registered when the old same-id SSH closes after session_tree", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    const started = await callTool(pi, {
      action: "watch",
      host: "tree-race",
      pid: 58,
      description: "tree-race",
    });
    await pi.emit("session_tree");
    await delay(120);
    const cancelled = await callTool(
      pi,
      { watch_id: started.details.watch.watch_id },
      "pi_ssh_cancel",
    );
    expect(cancelled.details.watch.watch_id).toBe(
      started.details.watch.watch_id,
    );
    await pi.emit("session_shutdown");
  });

  it("drops an old queued terminal callback after session_tree restores the same watch ID", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any);
    await pi.emit("session_start");
    const started = await callTool(pi, {
      action: "watch",
      host: "ownership-race",
      pid: 61,
      description: "ownership-race",
    });
    await pi.emit("session_tree");
    await delay(40);
    const cancelled = await callTool(
      pi,
      { watch_id: started.details.watch.watch_id },
      "pi_ssh_cancel",
    );
    expect(cancelled.details.watch.watch_id).toBe(
      started.details.watch.watch_id,
    );
    expect(
      pi.entries.some(
        (entry) =>
          entry.data?.kind === "finish" && entry.data?.config?.pid === 61,
      ),
    ).toBe(false);
    await pi.emit("session_shutdown");
  });

  it("does not synthesize restore close after shutdown invalidates the restore generation", async () => {
    const firstPi = new FakePi();
    piSshTarget(firstPi as any);
    await firstPi.emit("session_start");
    const started = await callTool(firstPi, {
      action: "watch",
      host: "slow-ready",
      pid: 53,
      description: "restore-race",
    });
    await firstPi.emit("session_shutdown");

    const secondPi = new FakePi(firstPi.entries);
    piSshTarget(secondPi as any);
    await secondPi.emit("session_start");
    await secondPi.emit("session_shutdown");
    await delay(140);
    expect(secondPi.entries.some((entry) => entry.data?.kind === "close")).toBe(
      false,
    );
    expect(secondPi.messages).toHaveLength(0);
    expect(started.details.watch.watch_id).toBeTruthy();
  });

  it("does not start later suggestions after an earlier automatic watcher is cancelled", async () => {
    const pi = new FakePi();
    piSshTarget(pi as any, {
      judge: async () => ({
        decisions: [
          {
            action: "watch",
            evidence_indexes: [0],
            host: "slow-ready",
            pid: 54,
            reason: "one",
          },
          {
            action: "watch",
            evidence_indexes: [1],
            host: "hang",
            pid: 55,
            reason: "two",
          },
        ],
      }),
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    for (const [pid, host] of [
      [54, "slow-ready"],
      [55, "hang"],
    ] as const) {
      await pi.emit("tool_result", {
        type: "tool_result",
        toolCallId: `bash-${pid}`,
        toolName: "bash",
        input: { command: `ssh ${host} 'nohup ./train.sh & echo PID=$!'` },
        content: [{ type: "text", text: `PID=${pid}` }],
        isError: false,
        details: undefined,
      });
    }
    await pi.emit("agent_settled");
    await delay(20);
    await pi.emit("session_shutdown");
    await delay(140);
    expect(
      pi.entries.filter(
        (entry) =>
          entry.data?.kind === "started" && entry.data?.origin === "audit",
      ),
    ).toHaveLength(0);
  });

  it("cancels an orphaned automatic watcher when lifecycle persistence fails", async () => {
    const pi = new FailingAppendPi();
    piSshTarget(pi as any, {
      judge: async () => ({
        decisions: [
          {
            action: "watch",
            evidence_indexes: [0],
            host: "hang",
            pid: 56,
            reason: "persist",
          },
        ],
      }),
    });
    await pi.emit("session_start");
    await pi.emit("agent_start");
    await pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "bash-persist",
      toolName: "bash",
      input: { command: "ssh hang 'nohup ./train.sh & echo PID=$!'" },
      content: [{ type: "text", text: "PID=56" }],
      isError: false,
      details: undefined,
    });
    await pi.emit("agent_settled");
    await delay(70);
    const listed = await callTool(pi, { action: "list", terminal_limit: 100 });
    expect(listed.details.active).toEqual([]);
    expect(listed.details.audits[0]?.status).toBe("failed");
  });

  it("restores only started branch watches and suppresses close during reload", async () => {
    const firstPi = new FakePi();
    piSshTarget(firstPi as any);
    await firstPi.emit("session_start");
    const started = await callTool(firstPi, {
      action: "watch",
      host: "hang",
      pid: 50,
      description: "reload",
    });
    await firstPi.emit("session_shutdown");
    await delay();
    expect(firstPi.messages).toHaveLength(0);

    const secondPi = new FakePi(firstPi.entries);
    piSshTarget(secondPi as any);
    await secondPi.emit("session_start");
    await delay();
    expect(
      readFileSync(process.env.FAKE_SSH_COUNT_FILE!, "utf8").trim().split("\n"),
    ).toHaveLength(2);

    await callTool(secondPi, {
      action: "cancel",
      watch_id: started.details.watch.watch_id,
    });
    await secondPi.emit("session_shutdown");
    const countBeforeTerminalResume = readFileSync(
      process.env.FAKE_SSH_COUNT_FILE!,
      "utf8",
    )
      .trim()
      .split("\n").length;

    const thirdPi = new FakePi(secondPi.entries);
    piSshTarget(thirdPi as any);
    await thirdPi.emit("session_start");
    await delay();
    const countAfterTerminalResume = readFileSync(
      process.env.FAKE_SSH_COUNT_FILE!,
      "utf8",
    )
      .trim()
      .split("\n").length;
    expect(countAfterTerminalResume).toBe(countBeforeTerminalResume);
    expect(
      thirdPi.entries.every(
        (entry) => entry.customType === LIFECYCLE_ENTRY_TYPE,
      ),
    ).toBe(true);
  });
});
