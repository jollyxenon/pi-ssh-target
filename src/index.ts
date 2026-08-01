import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_ACTIVE_LIMIT,
  DEFAULT_TERMINAL_LIMIT,
  LIFECYCLE_ENTRY_TYPE,
  MAX_LIST_LIMIT,
  MESSAGE_TYPE,
  isTerminalStatus,
  normalizeWatchConfig,
  validateWatchInput,
} from "./constants.js";
import { buildTerminalPrompt } from "./prompts.js";
import { reconstructWatchStates } from "./session-state.js";
import { SshWatchManager, type TerminalEvent } from "./ssh-watch-manager.js";
import type {
  CancelInput,
  ListInput,
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
  action: StringEnum(["watch", "cancel", "list"] as const),
  host: Type.Optional(Type.String({ description: "SSH destination" })),
  pid: Type.Optional(Type.Integer({ minimum: 1, description: "Remote root PID" })),
  job_id: Type.Optional(Type.String()),
  ssh_args: Type.Optional(Type.Array(Type.String())),
  interval_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  startup_timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  result_paths: Type.Optional(Type.Array(Type.String())),
  log_paths: Type.Optional(Type.Array(Type.String())),
  note: Type.Optional(Type.String()),
  watch_id: Type.Optional(Type.String()),
  active_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_LIST_LIMIT })),
  terminal_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_LIST_LIMIT })),
});

type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
};

/** Registers the pi_ssh_target Agent tool and session lifecycle hooks. */
export default function piSshTarget(pi: ExtensionAPI): void {
  let states = new Map<string, WatchState>();
  let sessionContext: ExtensionContext | undefined;
  const manager = new SshWatchManager(handleTerminal);

  /** Appends one branch-aware lifecycle entry and updates memory. */
  function persist(record: WatchLifecycleRecord): void {
    pi.appendEntry(LIFECYCLE_ENTRY_TYPE, record);
    states.set(record.watch_id, {
      config: record.config,
      status: record.kind,
      updated_at: record.at,
      ...(record.event === undefined ? {} : { event: record.event }),
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

  pi.registerTool({
    name: "pi_ssh_target",
    label: "Pi SSH Target",
    description: "Watch, cancel, or list remote Linux process-tree monitors over independent background SSH connections.",
    promptSnippet: "Monitor remote Linux process trees and steer this Pi session on terminal events",
    promptGuidelines: [
      "Use pi_ssh_target watch after starting a long-running remote Linux task when this session must resume after its process tree ends.",
      "Use pi_ssh_target list to inspect session-persisted watches without connecting to remote hosts.",
    ],
    parameters: ToolParameters,

    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as ToolInput;
      if (params.action === "watch") return executeWatch(params, signal);
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
        content: [{ type: "text" as const, text: `watch started: ${config.watch_id} (${config.host} PID ${config.pid})` }],
        details: { action: "watch", watch: summarize(states.get(config.watch_id)!) },
      };
    } catch (startError) {
      return errorResult("watch", startError instanceof Error ? startError.message : String(startError));
    }
  }

  /** Cancels only a currently active non-terminal watch. */
  function executeCancel(input: CancelInput): PiToolResult {
    if (!input.watch_id) return errorResult("cancel", "watch_id 不能为空");
    const state = states.get(input.watch_id);
    if (!state || state.status !== "started" || !manager.cancel(input.watch_id)) {
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
      content: [{ type: "text" as const, text: `watch cancelled: ${input.watch_id}` }],
      details: { action: "cancel", watch: summarize(states.get(input.watch_id)!) },
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
    const active = ordered.filter((state) => state.status === "started").slice(0, activeLimit).map(summarize);
    const terminal = ordered.filter((state) => isTerminalStatus(state.status)).slice(0, terminalLimit).map(summarize);
    const lines = [
      `active: ${active.length}`,
      ...active.map((state) => `- ${state.watch_id} ${state.host} PID ${state.pid} ${state.job_id}`),
      `terminal: ${terminal.length}`,
      ...terminal.map((state) => `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid} ${state.job_id}`),
    ];
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { action: "list", active, terminal },
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
}

/** Creates a compact non-throwing tool parameter/startup error result. */
function errorResult(action: ToolInput["action"], error: string): PiToolResult {
  return {
    content: [{ type: "text" as const, text: `error: ${error}` }],
    details: { action, error },
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
    ...(state.event === undefined ? {} : { process_count: state.event.process_count, state_file: state.event.state_file }),
  };
}

/** Validates list limit overrides after schema-compatible resume preparation. */
function validListLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_LIST_LIMIT;
}
