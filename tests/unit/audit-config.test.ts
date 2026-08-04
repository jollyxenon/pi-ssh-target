import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_CONFIG,
  loadPiSshTargetConfig,
  parsePiSshTargetConfig,
} from "../../src/audit-config.js";

let directory = "";

/** Creates one temporary config path for strict loader tests. */
function configPath(): string {
  directory = mkdtempSync(join(tmpdir(), "pi-ssh-target-config-"));
  return join(directory, "pi-ssh-target.json");
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("audit configuration", () => {
  it("uses defaults when the user config is missing", () => {
    expect(loadPiSshTargetConfig(configPath() + ".missing").audit).toEqual(
      DEFAULT_AUDIT_CONFIG,
    );
  });

  it("loads every legal independent-model field", () => {
    const path = configPath();
    writeFileSync(
      path,
      JSON.stringify({
        audit: {
          judgmentMethod: "prefilter_then_llm",
          submission: "full_context",
          model: {
            source: "independent",
            provider: "anthropic",
            model: "judge-model",
            apiKeyEnv: "JUDGE_API_KEY",
          },
          cacheEnabled: false,
        },
      }),
    );
    expect(loadPiSshTargetConfig(path).audit).toMatchObject({
      judgmentMethod: "prefilter_then_llm",
      submission: "full_context",
      model: {
        source: "independent",
        provider: "anthropic",
        model: "judge-model",
      },
      cacheEnabled: false,
    });
  });

  it("rejects malformed JSON, unknown keys, invalid enums, and plaintext-like key fields", () => {
    const path = configPath();
    writeFileSync(path, "{");
    expect(() => loadPiSshTargetConfig(path)).toThrow();
    expect(() => parsePiSshTargetConfig({ audit: { unknown: true } })).toThrow(
      "未知字段",
    );
    expect(() =>
      parsePiSshTargetConfig({ audit: { submission: "everything" } }),
    ).toThrow("audit.submission");
    expect(() =>
      parsePiSshTargetConfig({
        audit: {
          model: {
            source: "independent",
            provider: "fake",
            model: "judge",
            apiKey: "secret",
          },
        },
      }),
    ).toThrow("未知字段");
  });
});
