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
  MESSAGE_TYPE,
  normalizeWatchConfig,
  validateStartInput,
  validateWatchInput,
} from "./constants.js";
import { buildStartedUnwatchedPrompt, buildTerminalPrompt } from "./prompts.js";
import { reconstructWatchStates } from "./session-state.js";
import { SshWatchManager, type TerminalEvent } from "./ssh-watch-manager.js";
import type {
  AuditSummary,
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
  pid: Type.Optional(
    Type.Integer({ minimum: 1, description: "Remote root PID" }),
  ),
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
  active_limit: Type.Optional(
    Type.Integer({ minimum: 0, maximum: MAX_LIST_LIMIT }),
  ),
  terminal_limit: Type.Optional(
    Type.Integer({ minimum: 0, maximum: MAX_LIST_LIMIT }),
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
      job_id: config.job_id,
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
    if (event.toolName === "pi_ssh_target") return;
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
        ...[...states.values()]
          .filter((state) => state.status !== "started_unwatched")
          .map((state) => ({ host: state.config.host, pid: state.config.pid })),
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
            action: "watch",
            host: suggestion.host,
            pid: suggestion.pid,
            job_id: suggestion.job_id,
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
        state.config.host === host &&
        state.config.pid === pid &&
        state.status !== "started_unwatched",
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
      event.toolName !== "pi_ssh_target" ||
      event.isError ||
      !event.details ||
      typeof event.details !== "object"
    )
      return;
    const details = event.details as ToolDetails;
    if (
      (details.action !== "watch" && details.action !== "start") ||
      details.error
    )
      return;
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
    promptSnippet:
      "Start and monitor remote Linux process trees, then steer Pi on terminal events",
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
  async function executeWatch(
    input: WatchInput,
    signal?: AbortSignal,
  ): Promise<PiToolResult> {
    const missing = requireWatchFields(input);
    const error = missing ?? validateWatchInput(input);
    if (error) return errorResult("watch", error);
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
          action: "watch",
          watch: summarize(requiredState(states, config.watch_id)),
        },
      };
    } catch (startError) {
      return errorResult(
        "watch",
        startError instanceof Error ? startError.message : String(startError),
      );
    }
  }

  /** Starts a detached task and records watched or partial-success outcome. */
  async function executeStart(
    input: StartInput,
    signal?: AbortSignal,
  ): Promise<PiToolResult> {
    const missing = requireStartFields(input);
    const error = missing ?? validateStartInput(input);
    if (error) return startErrorResult(error);
    const config = normalizeWatchConfig(
      input,
      randomUUID(),
      currentSessionId(),
    );
    let result: StartManagerResult;
    try {
      result = await manager.startLaunch(config, signal);
    } catch (startError) {
      return startErrorResult(
        startError instanceof Error ? startError.message : String(startError),
      );
    }

    config.pid = result.launched.root_pid;
    config.stdout_path = result.launched.stdout_path;
    config.stderr_path = result.launched.stderr_path;
    config.log_paths = [
      ...new Set([
        ...config.log_paths,
        result.launched.stdout_path,
        result.launched.stderr_path,
      ]),
    ];
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
      return startedUnwatchedResult(
        config,
        launch,
        result.error,
        states.get(config.watch_id),
      );
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
      return startedUnwatchedResult(
        config,
        launch,
        message,
        states.get(config.watch_id),
      );
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
      return errorResult(
        "cancel",
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
    const ordered = [...states.values()].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at),
    );
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
    const audits = latestAuditSummaries(terminalLimit);
    const lines = [
      `active: ${active.length}`,
      ...active.map(
        (state) =>
          `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid} ${state.job_id}`,
      ),
      `unwatched: ${unwatched.length}`,
      ...unwatched.map(
        (state) =>
          `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid} ${state.job_id}`,
      ),
      `terminal: ${terminal.length}`,
      ...terminal.map(
        (state) =>
          `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid} ${state.job_id}`,
      ),
      `audits: ${audits.length}`,
      ...audits.map(
        (audit) =>
          `- ${audit.hash.slice(0, 12)} ${audit.status} watches=${audit.watch_ids.length}`,
      ),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { action: "list", active, unwatched, terminal, audits },
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

/** Returns launch metadata without environment values or note text. */
function launchSummary(
  config: WatchConfig,
): NonNullable<ToolDetails["launch"]> {
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
