import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AuditBatch,
  type AuditCandidate,
  type AuditEntryRecord,
  buildAuditBatch,
  candidateFromToolResult,
  type JudgeResult,
  judgeAuditBatch,
  MAX_AUDIT_CANDIDATES,
  uncoveredCandidates,
  type WatchCoverage,
} from "./audit.js";
import {
  AUDIT_ENTRY_TYPE,
  AUDIT_MESSAGE_TYPE,
  DEFAULT_ACTIVE_LIMIT,
  DEFAULT_TERMINAL_LIMIT,
  isTerminalStatus,
  LIFECYCLE_ENTRY_TYPE,
  MAX_LIST_LIMIT,
  MESSAGE_TYPE,
  normalizeWatchConfig,
  validateStartInput,
  validateWatchInput,
} from "./constants.js";
import { buildAuditRemediationPrompt, buildStartedUnwatchedPrompt, buildTerminalPrompt } from "./prompts.js";
import { reconstructWatchStates } from "./session-state.js";
import { SshWatchManager, type TerminalEvent } from "./ssh-watch-manager.js";
import type {
  CancelInput,
  ListInput,
  StartInput,
  StartManagerResult,
  ToolDetails,
  ToolInput,
  WatchCloseEvent,
  WatchConfig,
  WatchInput,
  WatchLifecycleRecord,
  WatchState,
  WatchSummary,
} from "./types.js";

const ToolParameters = Type.Object({
  action: StringEnum(["watch", "start", "cancel", "list"] as const),
  host: Type.Optional(Type.String({ description: "SSH destination" })),
  pid: Type.Optional(Type.Integer({ minimum: 1, description: "Remote root PID" })),
  job_id: Type.Optional(Type.String()),
  ssh_args: Type.Optional(Type.Array(Type.String())),
  interval_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  startup_timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  result_paths: Type.Optional(Type.Array(Type.String())),
  log_paths: Type.Optional(Type.Array(Type.String())),
  note: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  stdout_path: Type.Optional(Type.String()),
  stderr_path: Type.Optional(Type.String()),
  watch_id: Type.Optional(Type.String()),
  active_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_LIST_LIMIT })),
  terminal_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_LIST_LIMIT })),
});

type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
};

export interface PiSshTargetDependencies {
  judge: (ctx: ExtensionContext, batch: AuditBatch) => Promise<JudgeResult>;
}

/** Registers the pi_ssh_target Agent tool and session lifecycle hooks. */
export default function piSshTarget(
  pi: ExtensionAPI,
  dependencies: PiSshTargetDependencies = { judge: judgeAuditBatch },
): void {
  let states = new Map<string, WatchState>();
  let sessionContext: ExtensionContext | undefined;
  let runCandidates: AuditCandidate[] = [];
  let runCoverage: WatchCoverage[] = [];
  let auditRunActive = false;
  const auditedHashes = new Set<string>();
  const manager = new SshWatchManager(handleTerminal);

  /** Appends one branch-aware lifecycle entry and updates memory. */
  function persist(record: WatchLifecycleRecord): void {
    pi.appendEntry(LIFECYCLE_ENTRY_TYPE, record);
    states.set(record.watch_id, {
      config: record.config,
      status: record.kind,
      updated_at: record.at,
      ...(record.event === undefined ? {} : { event: record.event }),
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  }

  /** Persists and independently steers every accepted terminal event. */
  function handleTerminal(config: WatchConfig, event: TerminalEvent): void {
    const current = states.get(config.watch_id);
    if (!current || isTerminalStatus(current.status)) return;
    const record: WatchLifecycleRecord = {
      version: 1,
      kind: event.event,
      watch_id: config.watch_id,
      at: event.observed_at,
      config,
      event,
    };
    persist(record);
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: buildTerminalPrompt(config, event),
        display: true,
        details: { watch_id: config.watch_id, event: event.event },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Synthesizes close when a restored SSH process cannot start. */
  function handleRestoreFailure(config: WatchConfig, error: unknown): void {
    const current = states.get(config.watch_id);
    if (!current || isTerminalStatus(current.status)) return;
    const event: WatchCloseEvent = {
      event: "close",
      watch_id: config.watch_id,
      job_id: config.job_id,
      host: config.host,
      root_pid: config.pid,
      process_count: 0,
      observed_at: new Date().toISOString(),
      state_file: null,
      exit_code: null,
      signal: null,
      stderr_tail: error instanceof Error ? error.message.slice(-2000) : String(error).slice(-2000),
    };
    handleTerminal(config, event);
  }

  /** Restarts only branch states whose last lifecycle record is started. */
  async function restoreStarted(ctx: ExtensionContext): Promise<void> {
    states = reconstructWatchStates(ctx.sessionManager.getBranch());
    auditedHashes.clear();
    for (const raw of ctx.sessionManager.getBranch()) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as {
        type?: string;
        customType?: string;
        data?: unknown;
      };
      if (
        entry.type !== "custom" ||
        entry.customType !== AUDIT_ENTRY_TYPE ||
        !entry.data ||
        typeof entry.data !== "object"
      )
        continue;
      const hash = (entry.data as { hash?: unknown }).hash;
      if (typeof hash === "string") auditedHashes.add(hash);
    }
    const pending = [...states.values()].filter((state) => state.status === "started");
    for (const state of pending) {
      const config = { ...state.config, resume: true };
      void manager.start(config).catch((error: unknown) => handleRestoreFailure(config, error));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_shutdown", async () => {
    manager.closeAll();
  });

  pi.on("agent_start", async () => {
    if (auditRunActive) return;
    auditRunActive = true;
    runCandidates = [];
    runCoverage = [];
  });

  pi.on("tool_result", async (event) => {
    recordCoverage(event);
    if (event.toolName === "pi_ssh_target") return;
    const candidate = candidateFromToolResult(event);
    if (candidate && runCandidates.length < MAX_AUDIT_CANDIDATES) runCandidates.push(candidate);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    auditRunActive = false;
    const candidates = uncoveredCandidates(runCandidates, runCoverage);
    runCandidates = [];
    runCoverage = [];
    const batch = buildAuditBatch(candidates);
    if (!batch || auditedHashes.has(batch.hash)) return;
    auditedHashes.add(batch.hash);
    appendAudit({
      version: 1,
      hash: batch.hash,
      at: new Date().toISOString(),
      decision: "pending",
      candidate_count: batch.candidates.length,
    });
    const judge = await dependencies.judge(ctx, batch);
    appendAudit({
      version: 1,
      hash: batch.hash,
      at: new Date().toISOString(),
      decision: judge.decision,
      candidate_count: batch.candidates.length,
      ...(judge.usage === undefined ? {} : { usage: judge.usage }),
      ...(judge.error === undefined ? {} : { error: judge.error.slice(-2000) }),
    });
    if (judge.decision === "no") return;
    pi.sendMessage(
      {
        customType: AUDIT_MESSAGE_TYPE,
        content: buildAuditRemediationPrompt(batch.candidates, judge),
        display: false,
        details: { hash: batch.hash, decision: judge.decision },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  /** Best-effort persistence must never block Judge or remediation. */
  function appendAudit(record: AuditEntryRecord): void {
    try {
      pi.appendEntry(AUDIT_ENTRY_TYPE, record);
    } catch {
      // In-memory hash dedupe remains active for this extension instance.
    }
  }

  /** Records successful watch coverage from finalized custom tool results. */
  function recordCoverage(event: ToolResultEvent): void {
    if (event.toolName !== "pi_ssh_target" || event.isError || !event.details || typeof event.details !== "object")
      return;
    const details = event.details as ToolDetails;
    if ((details.action !== "watch" && details.action !== "start") || details.error) return;
    const watch = details.watch;
    if (!watch || typeof watch !== "object") return;
    if ("config" in watch) {
      runCoverage.push({ host: watch.config.host, pid: watch.config.pid });
    } else {
      runCoverage.push({ host: watch.host, pid: watch.pid });
    }
  }

  pi.registerTool({
    name: "pi_ssh_target",
    label: "Pi SSH Target",
    description:
      "Start, watch, cancel, or list remote Linux process-tree monitors over independent background SSH connections.",
    promptSnippet: "Start and monitor remote Linux process trees, then steer Pi on terminal events",
    promptGuidelines: [
      "Whenever you start a remote Linux task expected to run for a long time or detach from its SSH command, use pi_ssh_target start when possible; otherwise capture its stable root PID and call pi_ssh_target watch in the same agent run before finishing.",
      "Do not finish a run with an unmonitored remote long task unless the user declined monitoring, the task already ended, or no stable PID can be obtained; state that reason explicitly.",
      "Use pi_ssh_target list to inspect session-persisted watches without connecting to remote hosts.",
    ],
    parameters: ToolParameters,

    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as ToolInput;
      if (params.action === "watch") return executeWatch(params, signal);
      if (params.action === "start") return executeStart(params, signal);
      if (params.action === "cancel") return executeCancel(params);
      return executeList(params);
    },
  });

  /** Validates and starts one independent watch, persisting only after ready. */
  async function executeWatch(input: WatchInput, signal?: AbortSignal): Promise<PiToolResult> {
    const missing = requireWatchFields(input);
    const error = missing ?? validateWatchInput(input);
    if (error) return errorResult("watch", error);
    const config = normalizeWatchConfig(input, randomUUID(), currentSessionId());
    try {
      const ready = await manager.start(config, signal);
      const record: WatchLifecycleRecord = {
        version: 1,
        kind: "started",
        watch_id: config.watch_id,
        at: ready.observed_at,
        config,
      };
      persist(record);
      return {
        content: [
          {
            type: "text",
            text: `watch started: ${config.watch_id} (${config.host} PID ${config.pid})`,
          },
        ],
        details: {
          action: "watch",
          watch: summarize(requiredState(states, config.watch_id)),
        },
      };
    } catch (startError) {
      return errorResult("watch", startError instanceof Error ? startError.message : String(startError));
    }
  }

  /** Starts a detached task and records watched or partial-success outcome. */
  async function executeStart(input: StartInput, signal?: AbortSignal): Promise<PiToolResult> {
    const missing = requireStartFields(input);
    const error = missing ?? validateStartInput(input);
    if (error) return startErrorResult(error);
    const config = normalizeWatchConfig(input, randomUUID(), currentSessionId());
    let result: StartManagerResult;
    try {
      result = await manager.startLaunch(config, signal);
    } catch (startError) {
      return startErrorResult(startError instanceof Error ? startError.message : String(startError));
    }

    config.pid = result.launched.root_pid;
    config.stdout_path = result.launched.stdout_path;
    config.stderr_path = result.launched.stderr_path;
    config.log_paths = [...new Set([...config.log_paths, result.launched.stdout_path, result.launched.stderr_path])];
    const launch = launchSummary(config);
    stripLaunchFields(config);

    try {
      if (result.outcome === "started_and_watched") {
        persist({
          version: 1,
          kind: "started",
          watch_id: config.watch_id,
          at: result.ready.observed_at,
          config,
        });
        return {
          content: [
            {
              type: "text",
              text: `task started and watched: ${config.watch_id} (${config.host} PID ${config.pid})`,
            },
          ],
          details: {
            action: "start",
            outcome: "started_and_watched",
            watch: summarize(requiredState(states, config.watch_id)),
            launch,
          },
        };
      }
      persist({
        version: 1,
        kind: "started_unwatched",
        watch_id: config.watch_id,
        at: result.launched.observed_at,
        config,
        error: result.error,
      });
      sendStartedUnwatched(config, result.error);
      return startedUnwatchedResult(config, launch, result.error, states.get(config.watch_id));
    } catch (localError) {
      manager.cancel(config.watch_id);
      const message = `任务已启动，但本地 Watcher 状态处理失败: ${
        localError instanceof Error ? localError.message : String(localError)
      }`;
      states.set(config.watch_id, {
        config,
        status: "started_unwatched",
        updated_at: new Date().toISOString(),
        error: message,
      });
      try {
        sendStartedUnwatched(config, message);
      } catch {
        // Tool result still reports the live task when session messaging is unavailable.
      }
      return startedUnwatchedResult(config, launch, message, states.get(config.watch_id));
    }
  }

  /** Sends one remediation turn for a launched task that lacks a durable Watcher. */
  function sendStartedUnwatched(config: WatchConfig, error: string): void {
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: buildStartedUnwatchedPrompt(config, error),
        display: true,
        details: { watch_id: config.watch_id, event: "started_unwatched" },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Cancels only a currently active non-terminal watch. */
  function executeCancel(input: CancelInput): PiToolResult {
    if (!input.watch_id) return errorResult("cancel", "watch_id 不能为空");
    const state = states.get(input.watch_id);
    if (state?.status !== "started" || !manager.cancel(input.watch_id)) {
      return errorResult("cancel", `watch 不存在、已终止或当前不可取消: ${input.watch_id}`);
    }
    const record: WatchLifecycleRecord = {
      version: 1,
      kind: "cancelled",
      watch_id: input.watch_id,
      at: new Date().toISOString(),
      config: state.config,
    };
    persist(record);
    return {
      content: [{ type: "text", text: `watch cancelled: ${input.watch_id}` }],
      details: {
        action: "cancel",
        watch: summarize(requiredState(states, input.watch_id)),
      },
    };
  }

  /** Lists bounded branch-local summaries without remote I/O. */
  function executeList(input: ListInput): PiToolResult {
    const activeLimit = input.active_limit ?? DEFAULT_ACTIVE_LIMIT;
    const terminalLimit = input.terminal_limit ?? DEFAULT_TERMINAL_LIMIT;
    if (!validListLimit(activeLimit) || !validListLimit(terminalLimit)) {
      return errorResult("list", `list 数量必须是 0-${MAX_LIST_LIMIT} 的整数`);
    }
    const ordered = [...states.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const active = ordered
      .filter((state) => state.status === "started")
      .slice(0, activeLimit)
      .map(summarize);
    const unwatched = ordered
      .filter((state) => state.status === "started_unwatched")
      .slice(0, activeLimit)
      .map(summarize);
    const terminal = ordered
      .filter((state) => isTerminalStatus(state.status))
      .slice(0, terminalLimit)
      .map(summarize);
    const lines = [
      `active: ${active.length}`,
      ...active.map((state) => `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid} ${state.job_id}`),
      `unwatched: ${unwatched.length}`,
      ...unwatched.map((state) => `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid} ${state.job_id}`),
      `terminal: ${terminal.length}`,
      ...terminal.map((state) => `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid} ${state.job_id}`),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { action: "list", active, unwatched, terminal },
    };
  }

  /** Returns current durable session id and rejects ephemeral sessions. */
  function currentSessionId(): string {
    return sessionContext?.sessionManager.getSessionId() ?? "";
  }

  /** Checks action-specific required fields omitted by the broad union schema. */
  function requireWatchFields(input: WatchInput): string | undefined {
    if (typeof input.host !== "string") return "watch 需要 host";
    if (typeof input.pid !== "number") return "watch 需要 pid";
    if (typeof input.job_id !== "string") return "watch 需要 job_id";
    if (!sessionContext) return "Pi session 尚未初始化";
    return undefined;
  }

  /** Checks start-specific required fields omitted by the broad union schema. */
  function requireStartFields(input: StartInput): string | undefined {
    if (typeof input.host !== "string") return "start 需要 host";
    if (typeof input.command !== "string") return "start 需要 command";
    if (!Array.isArray(input.args)) return "start 需要 args 数组";
    if (typeof input.job_id !== "string") return "start 需要 job_id";
    if (!sessionContext) return "Pi session 尚未初始化";
    return undefined;
  }
}

/** Creates a compact non-throwing tool parameter/startup error result. */
function errorResult(action: ToolInput["action"], error: string): PiToolResult {
  return {
    content: [{ type: "text", text: `error: ${error}` }],
    details: { action, error },
  };
}

/** Returns a launch failure without implying that a remote task exists. */
function startErrorResult(error: string): PiToolResult {
  return {
    content: [{ type: "text", text: `launch failed: ${error}` }],
    details: { action: "start", outcome: "launch_failed", error },
  };
}

/** Returns partial success without ever implying that the remote task failed to launch. */
function startedUnwatchedResult(
  config: WatchConfig,
  launch: NonNullable<ToolDetails["launch"]>,
  error: string,
  state?: WatchState,
): PiToolResult {
  return {
    content: [
      {
        type: "text",
        text: `task started but watcher failed: ${config.host} PID ${config.pid}: ${error}`,
      },
    ],
    details: {
      action: "start",
      outcome: "started_unwatched",
      ...(state === undefined ? {} : { watch: summarize(state) }),
      launch,
      error,
    },
  };
}

/** Converts full persisted state into bounded list output. */
function summarize(state: WatchState): WatchSummary {
  return {
    watch_id: state.config.watch_id,
    status: state.status,
    host: state.config.host,
    pid: state.config.pid,
    job_id: state.config.job_id,
    updated_at: state.updated_at,
    ...(state.event === undefined
      ? {}
      : {
          process_count: state.event.process_count,
          state_file: state.event.state_file,
        }),
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

/** Returns launch metadata without environment values or note text. */
function launchSummary(config: WatchConfig): NonNullable<ToolDetails["launch"]> {
  if (!config.command || !config.stdout_path || !config.stderr_path) {
    throw new Error(`launch 元数据不完整: ${config.watch_id}`);
  }
  return {
    host: config.host,
    pid: config.pid,
    command: config.command,
    args: config.args ?? [],
    stdout_path: config.stdout_path,
    stderr_path: config.stderr_path,
  };
}

/** Removes launch-only and potentially sensitive values after capturing the launch result. */
function stripLaunchFields(config: WatchConfig): void {
  delete config.command;
  delete config.args;
  delete config.cwd;
  delete config.env;
  delete config.stdout_path;
  delete config.stderr_path;
}

/** Returns a persisted state or fails loudly on an internal invariant violation. */
function requiredState(states: Map<string, WatchState>, watchId: string): WatchState {
  const state = states.get(watchId);
  if (!state) throw new Error(`watch 状态未持久化: ${watchId}`);
  return state;
}

/** Validates bounded list override counts. */
function validListLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_LIST_LIMIT;
}
