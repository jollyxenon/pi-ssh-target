import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AuditCandidate,
  type AuditEntryRecord,
  type AuditEvidence,
  type AuditSnapshot,
  candidateFromToolResult,
  createAuditSnapshot,
  evidenceFromToolResult,
  type JudgeResult,
  judgeAuditSnapshot,
  MAX_AUDIT_CANDIDATES,
  MAX_AUDIT_EVIDENCE,
  messagesFromContextEntries,
  shouldJudgeSnapshot,
  validateAuditDecisionsDetailed,
  type WatchCoverage,
} from "./audit.js";
import {
  type AuditConfig,
  loadPiSshTargetConfig,
  summarizeAuditConfig,
} from "./audit-config.js";
import {
  AUDIT_ENTRY_TYPE,
  DEFAULT_ACTIVE_LIMIT,
  DEFAULT_TERMINAL_LIMIT,
  isTerminalStatus,
  LIFECYCLE_ENTRY_TYPE,
  MAX_LIST_LIMIT,
  MAX_PASSWORD_LENGTH,
  MESSAGE_TYPE,
  normalizeWatchConfig,
  validateWatchInput,
} from "./constants.js";
import { buildTerminalPrompt } from "./prompts.js";
import { reconstructWatchStates } from "./session-state.js";
import { SshWatchManager, type TerminalEvent } from "./ssh-watch-manager.js";
import type {
  AuditSummary,
  CancelInput,
  ListInput,
  ToolDetails,
  WatchCloseEvent,
  WatchConfig,
  WatchInput,
  WatchLifecycleRecord,
  WatchState,
  WatchSummary,
} from "./types.js";

const WatchParameters = Type.Object({
  host: Type.String({
    description:
      'SSH destination, e.g. "user@example.com" or "example.com" (default user)',
  }),
  pid: Type.Integer({
    minimum: 1,
    description:
      "Remote root PID of the task to monitor; capture it when launching the task, e.g. ssh host 'nohup cmd > /tmp/out.log 2>&1 & echo $!'",
  }),
  description: Type.Optional(
    Type.String({
      description: "Short human-readable label for the task, shown in list output",
    }),
  ),
  ssh_args: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Extra SSH client connection options, e.g. ["-p", "2222"] for a non-default port or ["-i", "/path/to/key"] for a key; keepalive options are appended automatically',
    }),
  ),
  password: Type.Optional(
    Type.String({
      maxLength: MAX_PASSWORD_LENGTH,
      description: "SSH password for password-only servers",
    }),
  ),
  interval_seconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: "Watcher poll interval in seconds (default 5)",
    }),
  ),
  startup_timeout_seconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: "Seconds to wait for the watcher to become ready (default 10)",
    }),
  ),
  result_paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Remote file paths the task is expected to produce; checked after the task finishes",
    }),
  ),
  log_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Remote log file paths to monitor while the task is running",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "Free-form note for future sessions that resume this watch",
    }),
  ),
});

const CancelParameters = Type.Object({
  watch_id: Type.String({
    description: "Watch ID returned by pi_ssh_watch or pi_ssh_list",
  }),
});

const ListParameters = Type.Object({
  active_limit: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_LIST_LIMIT,
      description: "Max active watches to show in list (default 3)",
    }),
  ),
  terminal_limit: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_LIST_LIMIT,
      description: "Max finished watches to show in list (default 0)",
    }),
  ),
});

type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
};

export interface PiSshTargetDependencies {
  judge?: (
    ctx: ExtensionContext,
    snapshot: AuditSnapshot,
    config: AuditConfig,
    signal?: AbortSignal,
  ) => Promise<JudgeResult>;
  auditConfig?: AuditConfig;
}

type QueuedAudit = {
  snapshot: AuditSnapshot;
  context: ExtensionContext;
};

/** Registers the pi_ssh_target Agent tool and session lifecycle hooks. */
export default function piSshTarget(
  pi: ExtensionAPI,
  dependencies: PiSshTargetDependencies = {},
): void {
  const auditConfig = dependencies.auditConfig ?? loadPiSshTargetConfig().audit;
  const judge = dependencies.judge ?? judgeAuditSnapshot;
  let states = new Map<string, WatchState>();
  let auditRecords: AuditEntryRecord[] = [];
  let sessionContext: ExtensionContext | undefined;
  let runEvidence: AuditEvidence[] = [];
  let runCandidates: AuditCandidate[] = [];
  let runCoverage: WatchCoverage[] = [];
  let auditRunActive = false;
  let auditGeneration = 0;
  let auditWorkerActive = false;
  let auditDisposed = false;
  let auditAbort: AbortController | undefined;
  const auditQueue: QueuedAudit[] = [];
  const auditedHashes = new Set<string>();
  const manager = new SshWatchManager(handleTerminal);

  /** Appends one branch-aware lifecycle entry and updates memory. */
  function persist(record: WatchLifecycleRecord): void {
    pi.appendEntry(LIFECYCLE_ENTRY_TYPE, record);
    states.set(record.watch_id, {
      config: record.config,
      status: record.kind,
      updated_at: record.at,
      ...(record.origin === undefined ? {} : { origin: record.origin }),
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
      ...(current.origin === undefined ? {} : { origin: current.origin }),
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
      host: config.host,
      root_pid: config.pid,
      process_count: 0,
      observed_at: new Date().toISOString(),
      state_file: null,
      exit_code: null,
      signal: null,
      stderr_tail:
        error instanceof Error
          ? error.message.slice(-2000)
          : String(error).slice(-2000),
    };
    handleTerminal(config, event);
  }

  /** Restarts branch watches and restores background audit dedupe records. */
  async function restoreStarted(ctx: ExtensionContext): Promise<void> {
    states = reconstructWatchStates(ctx.sessionManager.getBranch());
    auditRecords = [];
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
        !entry.data ||
        typeof entry.data !== "object"
      )
        continue;
      if (entry.customType === AUDIT_ENTRY_TYPE) {
        const record = entry.data as Partial<AuditEntryRecord>;
        if (
          record.version === 2 &&
          typeof record.hash === "string" &&
          typeof record.status === "string"
        ) {
          auditRecords.push(record as AuditEntryRecord);
          auditedHashes.add(record.hash);
        }
      }
    }
    const restoreGeneration = auditGeneration;
    const restoreSessionId = ctx.sessionManager.getSessionId();
    const pending = [...states.values()].filter(
      (state) => state.status === "started",
    );
    for (const state of pending) {
      const config = { ...state.config, resume: true };
      void manager.start(config).catch((error: unknown) => {
        if (
          auditDisposed ||
          auditGeneration !== restoreGeneration ||
          sessionContext?.sessionManager.getSessionId() !== restoreSessionId
        )
          return;
        handleRestoreFailure(config, error);
      });
    }
  }

  /** Invalidates queued audit work for a replaced or closed session runtime. */
  function invalidateAuditRuntime(): void {
    auditGeneration += 1;
    auditAbort?.abort();
    auditAbort = undefined;
    auditQueue.length = 0;
  }

  pi.on("session_start", async (_event, ctx) => {
    auditDisposed = false;
    invalidateAuditRuntime();
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    auditDisposed = false;
    invalidateAuditRuntime();
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_shutdown", async () => {
    auditDisposed = true;
    invalidateAuditRuntime();
    manager.closeAll();
  });

  pi.on("agent_start", async () => {
    if (auditRunActive) return;
    auditRunActive = true;
    runEvidence = [];
    runCandidates = [];
    runCoverage = [];
  });

  pi.on("tool_result", async (event) => {
    recordCoverage(event);
    if (
      event.toolName === "pi_ssh_watch" ||
      event.toolName === "pi_ssh_cancel" ||
      event.toolName === "pi_ssh_list"
    )
      return;
    const evidence = evidenceFromToolResult(event);
    if (!evidence) return;
    const candidate = candidateFromToolResult(event);
    if (!candidate) {
      if (runEvidence.length < MAX_AUDIT_EVIDENCE) runEvidence.push(evidence);
      return;
    }
    if (runCandidates.length >= MAX_AUDIT_CANDIDATES) return;
    if (runEvidence.length >= MAX_AUDIT_EVIDENCE) {
      const candidateIds = new Set(
        runCandidates.map((item) => item.tool_call_id),
      );
      const replaceIndex = runEvidence.findIndex(
        (item) => !candidateIds.has(item.tool_call_id),
      );
      if (replaceIndex < 0) return;
      runEvidence.splice(replaceIndex, 1);
    }
    runEvidence.push(evidence);
    runCandidates.push(candidate);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    auditRunActive = false;
    const evidence = runEvidence;
    const candidates = runCandidates;
    const coverage = runCoverage;
    runEvidence = [];
    runCandidates = [];
    runCoverage = [];
    const fullContext = messagesFromContextEntries(
      ctx.sessionManager.buildContextEntries(),
    );
    const snapshot = createAuditSnapshot({
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      generation: auditGeneration,
      model: ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : null,
      fullContext,
      evidence,
      candidates,
      coverage: [
        ...coverage,
        ...[...states.values()].map((state) => ({
          host: state.config.host,
          pid: state.config.pid,
        })),
      ],
    });
    if (
      !shouldJudgeSnapshot(snapshot, auditConfig) ||
      auditedHashes.has(snapshot.hash)
    )
      return;
    auditedHashes.add(snapshot.hash);
    appendAudit(auditRecord(snapshot, "queued"));
    auditQueue.push({ snapshot, context: ctx });
    void runAuditQueue().catch(() => {
      // Per-item failures are recorded inside the worker; this only contains unexpected defects.
    });
  });

  /** Runs queued Judge requests serially without blocking the Agent lifecycle. */
  async function runAuditQueue(): Promise<void> {
    if (auditWorkerActive) return;
    auditWorkerActive = true;
    try {
      while (auditQueue.length > 0) {
        const queued = auditQueue.shift();
        if (!queued) continue;
        if (!isAuditSnapshotCurrent(queued.snapshot)) {
          appendAudit(auditRecord(queued.snapshot, "discarded"));
          continue;
        }
        appendAudit(auditRecord(queued.snapshot, "running"));
        const controller = new AbortController();
        auditAbort = controller;
        let result: JudgeResult;
        try {
          result = await judge(
            queued.context,
            queued.snapshot,
            auditConfig,
            controller.signal,
          );
        } catch (error) {
          auditAbort = undefined;
          appendAudit(
            auditRecord(queued.snapshot, "failed", {
              error: boundedError(error),
            }),
          );
          continue;
        }
        auditAbort = undefined;
        if (!isAuditSnapshotCurrent(queued.snapshot)) {
          appendAudit(
            auditRecord(
              queued.snapshot,
              "discarded",
              result.usage === undefined ? {} : { usage: result.usage },
            ),
          );
          continue;
        }
        const watchIds: string[] = [];
        const errors: string[] = [];
        const validation = validateAuditDecisionsDetailed(
          result,
          queued.snapshot.evidence,
        );
        const validatedSuggestions = validation.accepted;
        if (validation.rejected.length > 0) {
          errors.push(
            `Watcher 建议校验失败: ${validation.rejected.join(", ")}`,
          );
        }
        for (const suggestion of validatedSuggestions) {
          if (
            controller.signal.aborted ||
            !isAuditSnapshotCurrent(queued.snapshot)
          )
            break;
          if (hasWatchCoverage(suggestion.host, suggestion.pid)) continue;
          const input: WatchInput = {
            host: suggestion.host,
            pid: suggestion.pid,
            ssh_args: [
              ...suggestion.ssh_args,
              "-o",
              "PermitLocalCommand=no",
              "-o",
              "ClearAllForwardings=yes",
            ],
          };
          const validationError = validateWatchInput(input);
          if (validationError) {
            errors.push(validationError);
            continue;
          }
          const config = normalizeWatchConfig(
            input,
            randomUUID(),
            queued.snapshot.session_id,
          );
          try {
            const ready = await manager.start(config, controller.signal);
            if (
              controller.signal.aborted ||
              !isAuditSnapshotCurrent(queued.snapshot)
            ) {
              manager.cancel(config.watch_id);
              break;
            }
            if (hasWatchCoverage(suggestion.host, suggestion.pid)) {
              manager.cancel(config.watch_id);
              continue;
            }
            try {
              persist({
                version: 1,
                kind: "started",
                watch_id: config.watch_id,
                at: ready.observed_at,
                config,
                origin: "audit",
              });
            } catch (error) {
              manager.cancel(config.watch_id);
              throw error;
            }
            watchIds.push(config.watch_id);
          } catch (error) {
            errors.push(boundedError(error));
          }
        }
        const counts = countDecisions(result);
        const error = [result.error, ...errors]
          .filter((item): item is string => !!item)
          .join("\n");
        appendAudit(
          auditRecord(queued.snapshot, error ? "failed" : "completed", {
            decision_counts: counts,
            watch_ids: watchIds,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            ...(error ? { error: boundedError(error) } : {}),
          }),
        );
      }
    } finally {
      auditAbort = undefined;
      auditWorkerActive = false;
      if (auditQueue.length > 0 && !auditDisposed) {
        void runAuditQueue().catch(() => {
          // Per-item failures are recorded inside the worker; this only contains unexpected defects.
        });
      }
    }
  }

  /** Best-effort persistence never blocks Judge, queue progress, or Watcher recovery. */
  function appendAudit(record: AuditEntryRecord): void {
    auditRecords.push(record);
    try {
      pi.appendEntry(AUDIT_ENTRY_TYPE, record);
    } catch {
      // In-memory records and hash dedupe remain active for this extension instance.
    }
  }

  /** Checks whether a queued snapshot can still mutate this session branch. */
  function isAuditSnapshotCurrent(snapshot: AuditSnapshot): boolean {
    if (auditDisposed || snapshot.generation !== auditGeneration) return false;
    if (
      !sessionContext ||
      sessionContext.sessionManager.getSessionId() !== snapshot.session_id
    )
      return false;
    if (snapshot.leaf_id === null) return true;
    return sessionContext.sessionManager
      .getBranch()
      .some((entry) => entry.id === snapshot.leaf_id);
  }

  /** Treats an existing terminal or active watch as coverage for a remote PID. */
  function hasWatchCoverage(host: string, pid: number): boolean {
    return [...states.values()].some(
      (state) =>
        state.config.host === host && state.config.pid === pid,
    );
  }

  /** Creates a bounded audit lifecycle record. */
  function auditRecord(
    snapshot: AuditSnapshot,
    status: AuditEntryRecord["status"],
    extra: Partial<AuditEntryRecord> = {},
  ): AuditEntryRecord {
    return {
      version: 2,
      hash: snapshot.hash,
      session_id: snapshot.session_id,
      leaf_id: snapshot.leaf_id,
      at: new Date().toISOString(),
      status,
      config: summarizeAuditConfig(auditConfig),
      candidate_count: snapshot.candidates.length,
      evidence_count: snapshot.evidence.length,
      ...extra,
    };
  }

  /** Counts the bounded Judge decisions for compact persistence. */
  function countDecisions(
    result: JudgeResult,
  ): Record<"watch" | "ignore" | "insufficient", number> {
    const counts = { watch: 0, ignore: 0, insufficient: 0 };
    for (const decision of result.decisions) counts[decision.action] += 1;
    return counts;
  }

  /** Converts an unknown background error into a bounded string. */
  function boundedError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      -2000,
    );
  }

  /** Records successful watch coverage from finalized custom tool results. */
  function recordCoverage(event: ToolResultEvent): void {
    if (
      event.toolName !== "pi_ssh_watch" ||
      event.isError ||
      !event.details ||
      typeof event.details !== "object"
    )
      return;
    const details = event.details as ToolDetails;
    if (details.error) return;
    const watch = details.watch;
    if (!watch || typeof watch !== "object") return;
    if ("config" in watch) {
      runCoverage.push({ host: watch.config.host, pid: watch.config.pid });
    } else {
      runCoverage.push({ host: watch.host, pid: watch.pid });
    }
  }

  pi.registerTool({
    name: "pi_ssh_watch",
    label: "Pi SSH Watch",
    description:
      "Monitor a remote Linux process tree over SSH and notify the local Pi Agent when the task finishes.\n\nRequired: host (SSH destination, e.g. \"user@example.com\") and pid (remote root PID — capture it when launching the task, e.g. ssh host 'nohup cmd > /tmp/out.log 2>&1 & echo $!').\n\nOptional: ssh_args (SSH client options, e.g. [\"-p\", \"2222\"]; keepalive appended automatically), password (for password-only servers), result_paths (files the task should produce, checked after finish), log_paths (log files to watch while running), description, note, interval_seconds (poll interval, default 5), startup_timeout_seconds (watcher startup timeout, default 10).",
    promptSnippet:
      "Use when a time-consuming task is running on a remote Linux server and you want to be notified when it ends. Monitors the task process tree via SSH and reports back to Pi Agent.",
    promptGuidelines: [
      "pi_ssh_watch is a tool that can monitor the running status of remote tasks and report real-time to local Pi Agent. It detects whether the remote task has finished running by remotely mounting a \"watcher\" to monitor the status of the task process tree, and notifies the local after the task is completed.",
      "pi_ssh_watch has three return states: if it is \"finish\", the process tree of the task ends completely; If it is \"interrupt\", the monitoring script on the server will have an error; If it is \"close\", the local to remote SSH channel will be disconnected.",
      "pi_ssh_watch will send a message to local Pi Agent to continue the task after it is completed, so Pi Agent does not need to keep watching it and can work on other tasks in the meantime.",
      "pi_ssh_watch requires host and pid: launch the remote task yourself with ssh (e.g. ssh host 'nohup python3 train.py > /tmp/out.log 2>&1 & echo $!'), capture the printed PID, then call pi_ssh_watch with that pid.",
    ],
    parameters: WatchParameters,

    async execute(_toolCallId, rawParams, signal) {
      return executeWatch(rawParams as WatchInput, signal);
    },
  });

  pi.registerTool({
    name: "pi_ssh_cancel",
    label: "Pi SSH Cancel",
    description:
      "Stop watching a remote task. Pass the watch_id returned by pi_ssh_watch or pi_ssh_list.",
    promptSnippet:
      "Use to stop monitoring a remote Linux task whose watch_id is no longer needed.",
    promptGuidelines: [
      "Use pi_ssh_cancel with the watch_id from a prior pi_ssh_watch or pi_ssh_list call to stop monitoring a task.",
    ],
    parameters: CancelParameters,

    async execute(_toolCallId, rawParams) {
      return executeCancel(rawParams as CancelInput);
    },
  });

  pi.registerTool({
    name: "pi_ssh_list",
    label: "Pi SSH List",
    description:
      "List current remote task watches (active, and optionally finished) without connecting to remote hosts.",
    promptSnippet:
      "Use to inspect current remote task watches; optionally pass active_limit (default 3) and terminal_limit (default 0).",
    promptGuidelines: [
      "Use pi_ssh_list to inspect session-persisted watches without connecting to remote hosts.",
    ],
    parameters: ListParameters,

    async execute(_toolCallId, rawParams) {
      return executeList(rawParams as ListInput);
    },
  });
  /** Validates and starts one independent watch, persisting only after ready. */
  async function executeWatch(
    input: WatchInput,
    signal?: AbortSignal,
  ): Promise<PiToolResult> {
    const missing = requireWatchFields(input);
    const error = missing ?? validateWatchInput(input);
    if (error) return errorResult(error);
    const config = normalizeWatchConfig(
      input,
      randomUUID(),
      currentSessionId(),
    );
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
          watch: summarize(requiredState(states, config.watch_id)),
        },
      };
    } catch (startError) {
      return errorResult(
        startError instanceof Error ? startError.message : String(startError),
      );
    }
  }

  /** Cancels only a currently active non-terminal watch. */
  function executeCancel(input: CancelInput): PiToolResult {
    if (!input.watch_id) return errorResult("watch_id 不能为空");
    const state = states.get(input.watch_id);
    if (state?.status !== "started" || !manager.cancel(input.watch_id)) {
      return errorResult(
        `watch 不存在、已终止或当前不可取消: ${input.watch_id}`,
      );
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
        watch: summarize(requiredState(states, input.watch_id)),
      },
    };
  }

  /** Lists bounded branch-local summaries without remote I/O. */
  function executeList(input: ListInput): PiToolResult {
    const activeLimit = input.active_limit ?? DEFAULT_ACTIVE_LIMIT;
    const terminalLimit = input.terminal_limit ?? DEFAULT_TERMINAL_LIMIT;
    if (!validListLimit(activeLimit) || !validListLimit(terminalLimit)) {
      return errorResult(`list 数量必须是 0-${MAX_LIST_LIMIT} 的整数`);
    }
    const ordered = [...states.values()].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at),
    );
    const active = ordered
      .filter((state) => state.status === "started")
      .slice(0, activeLimit)
      .map(summarize);
    const terminal = ordered
      .filter((state) => isTerminalStatus(state.status))
      .slice(0, terminalLimit)
      .map(summarize);
    const audits = latestAuditSummaries(terminalLimit);
    const lines = [
      `active: ${active.length}`,
      ...active.map(
        (state) =>
          `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid}${state.description ? ` ${state.description}` : ""}`,
      ),
      `terminal: ${terminal.length}`,
      ...terminal.map(
        (state) =>
          `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid}${state.description ? ` ${state.description}` : ""}`,
      ),
      `audits: ${audits.length}`,
      ...audits.map(
        (audit) =>
          `- ${audit.hash.slice(0, 12)} ${audit.status} watches=${audit.watch_ids.length}`,
      ),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { active, terminal, audits },
    };
  }

  /** Returns latest terminal audit outcomes without conversation or command content. */
  function latestAuditSummaries(limit: number): AuditSummary[] {
    const latestByHash = new Map<string, AuditEntryRecord>();
    for (const record of auditRecords) latestByHash.set(record.hash, record);
    return [...latestByHash.values()]
      .filter(
        (
          record,
        ): record is AuditEntryRecord & {
          status: "completed" | "failed" | "discarded";
        } =>
          record.status === "completed" ||
          record.status === "failed" ||
          record.status === "discarded",
      )
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, limit)
      .map((record) => ({
        hash: record.hash,
        status: record.status,
        at: record.at,
        candidate_count: record.candidate_count,
        evidence_count: record.evidence_count,
        watch_ids: [...(record.watch_ids ?? [])],
        ...(record.error === undefined ? {} : { error: record.error }),
      }));
  }

  /** Returns current durable session id and rejects ephemeral sessions. */
  function currentSessionId(): string {
    return sessionContext?.sessionManager.getSessionId() ?? "";
  }

  /** Checks action-specific required fields omitted by the broad union schema. */
  function requireWatchFields(input: WatchInput): string | undefined {
    if (typeof input.host !== "string") return "watch 需要 host";
    if (typeof input.pid !== "number") return "watch 需要 pid";
    if (!sessionContext) return "Pi session 尚未初始化";
    return undefined;
  }

  }

/** Creates a compact non-throwing tool parameter/startup error result. */
function errorResult(error: string): PiToolResult {
  return {
    content: [{ type: "text", text: `error: ${error}` }],
    details: { error },
  };
}

/** Converts full persisted state into bounded list output. */
function summarize(state: WatchState): WatchSummary {
  return {
    watch_id: state.config.watch_id,
    status: state.status,
    host: state.config.host,
    pid: state.config.pid,
    ...(state.config.description === undefined
      ? {}
      : { description: state.config.description }),
    updated_at: state.updated_at,
    ...(state.origin === undefined ? {} : { origin: state.origin }),
    ...(state.event === undefined
      ? {}
      : {
          process_count: state.event.process_count,
          state_file: state.event.state_file,
        }),
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

/** Returns a persisted state or fails loudly on an internal invariant violation. */
function requiredState(
  states: Map<string, WatchState>,
  watchId: string,
): WatchState {
  const state = states.get(watchId);
  if (!state) throw new Error(`watch 状态未持久化: ${watchId}`);
  return state;
}

/** Validates bounded list override counts. */
function validListLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_LIST_LIMIT;
}
