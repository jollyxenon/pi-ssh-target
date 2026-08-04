import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type AuditJudgmentMethod = "prefilter_then_llm" | "direct_llm";
export type AuditSubmission =
  "full_context" | "current_exchange" | "ssh_tool_calls";

export type AuditModelConfig =
  | { source: "pi_agent" }
  | {
      source: "independent";
      provider: string;
      model: string;
      apiKeyEnv?: string;
    };

export interface AuditConfig {
  judgmentMethod: AuditJudgmentMethod;
  submission: AuditSubmission;
  model: AuditModelConfig;
  cacheEnabled: boolean;
}

export interface PiSshTargetConfig {
  audit: AuditConfig;
}

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  judgmentMethod: "prefilter_then_llm",
  submission: "full_context",
  model: { source: "pi_agent" },
  cacheEnabled: true,
};

/** Loads the single user-level extension configuration or returns defaults. */
export function loadPiSshTargetConfig(
  path = join(getAgentDir(), "pi-ssh-target.json"),
): PiSshTargetConfig {
  if (!existsSync(path))
    return { audit: cloneAuditConfig(DEFAULT_AUDIT_CONFIG) };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsePiSshTargetConfig(raw);
}

/** Strictly validates and normalizes user configuration. */
export function parsePiSshTargetConfig(raw: unknown): PiSshTargetConfig {
  const root = requireRecord(raw, "配置根对象");
  rejectUnknown(root, ["audit"], "配置根对象");
  const auditRaw =
    root.audit === undefined ? {} : requireRecord(root.audit, "audit");
  rejectUnknown(
    auditRaw,
    ["judgmentMethod", "submission", "model", "cacheEnabled"],
    "audit",
  );

  const judgmentMethod = readEnum(
    auditRaw.judgmentMethod,
    ["prefilter_then_llm", "direct_llm"] as const,
    DEFAULT_AUDIT_CONFIG.judgmentMethod,
    "audit.judgmentMethod",
  );
  const submission = readEnum(
    auditRaw.submission,
    ["full_context", "current_exchange", "ssh_tool_calls"] as const,
    DEFAULT_AUDIT_CONFIG.submission,
    "audit.submission",
  );
  if (judgmentMethod === "direct_llm" && submission === "ssh_tool_calls") {
    throw new Error("audit.submission=ssh_tool_calls 不能与 direct_llm 组合");
  }
  const model = parseModelConfig(auditRaw.model);
  const cacheEnabled =
    submission === "full_context"
      ? readBoolean(
          auditRaw.cacheEnabled,
          DEFAULT_AUDIT_CONFIG.cacheEnabled,
          "audit.cacheEnabled",
        )
      : false;
  return { audit: { judgmentMethod, submission, model, cacheEnabled } };
}

/** Returns a non-sensitive configuration summary for audit entries. */
export function summarizeAuditConfig(
  config: AuditConfig,
): Record<string, unknown> {
  return {
    judgment_method: config.judgmentMethod,
    submission: config.submission,
    model_source: config.model.source,
    ...(config.model.source === "independent"
      ? {
          provider: config.model.provider,
          model: config.model.model,
          api_key_env: config.model.apiKeyEnv ?? null,
        }
      : {}),
    cache_enabled: config.submission === "full_context" && config.cacheEnabled,
  };
}

/** Parses current-model or fixed independent-model selection. */
function parseModelConfig(raw: unknown): AuditModelConfig {
  if (raw === undefined) return { source: "pi_agent" };
  const model = requireRecord(raw, "audit.model");
  const source = readEnum(
    model.source,
    ["pi_agent", "independent"] as const,
    undefined,
    "audit.model.source",
  );
  if (source === "pi_agent") {
    rejectUnknown(model, ["source"], "audit.model");
    return { source };
  }
  rejectUnknown(
    model,
    ["source", "provider", "model", "apiKeyEnv"],
    "audit.model",
  );
  const provider = requireNonEmptyString(
    model.provider,
    "audit.model.provider",
  );
  const modelId = requireNonEmptyString(model.model, "audit.model.model");
  const apiKeyEnv =
    model.apiKeyEnv === undefined
      ? undefined
      : requireNonEmptyString(model.apiKeyEnv, "audit.model.apiKeyEnv");
  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("audit.model.apiKeyEnv 必须是有效环境变量名");
  }
  return {
    source,
    provider,
    model: modelId,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  };
}

/** Rejects keys not defined by the public configuration contract. */
function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} 包含未知字段: ${unknown}`);
}

/** Requires a plain JSON object. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

/** Reads one strict string enum with an optional default. */
function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number] | undefined,
  label: string,
): T[number] {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} 必须是 ${allowed.join(" | ")}`);
  }
  return value as T[number];
}

/** Reads one strict boolean with a default. */
function readBoolean(
  value: unknown,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
}

/** Requires a non-empty string. */
function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} 必须是非空字符串`);
  return value;
}

/** Clones the default union without sharing mutable references. */
function cloneAuditConfig(config: AuditConfig): AuditConfig {
  return { ...config, model: { ...config.model } };
}
