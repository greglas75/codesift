import { describe, it, expect } from "vitest";
import { buildLevel1Payload, assertSanitized } from "../../../src/storage/telemetry/sanitizer.js";
import { aggregateToolMetrics } from "../../../src/storage/telemetry/aggregator.js";
import type { UsageEntry } from "../../../src/storage/usage-tracker.js";
import type { EnvProfile } from "../../../src/storage/telemetry/env-profile.js";

const ENV: EnvProfile = {
  platform: "darwin", arch: "arm64", ram_bucket: "16-32gb",
  cores: 10, node_ver: "20", codesift_ver: "0.9.10",
};

describe("sanitizer allowlist (spec §1 — the leak guarantee)", () => {
  it("payload built from entries carrying query/repo/paths leaks NONE of them", () => {
    const entries: UsageEntry[] = [{
      ts: 1_700_000_000_000,
      tool: "search_text",
      repo: "local/Secret-Repo",
      args_summary: { query: "PASSWORD=hunter2", file_pattern: "/Users/greg/secret.ts" },
      elapsed_ms: 12, result_tokens: 100, result_chunks: 3, session_id: "sess-abc",
    }];
    const tools = aggregateToolMetrics(entries);
    const payload = buildLevel1Payload({ anonId: "anon-123", env: ENV, tools, now: 1_700_000_000_000 });

    const json = JSON.stringify(payload);
    for (const forbidden of ["Secret-Repo", "hunter2", "secret.ts", "local/", "sess-abc", "PASSWORD"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(() => assertSanitized(payload)).not.toThrow();
    // only allowlisted top-level keys
    expect(Object.keys(payload).sort()).toEqual(["anon_id", "env", "hints", "schema_version", "tools", "ts"]);
  });

  it("assertSanitized throws when a forbidden KEY appears anywhere", () => {
    expect(() => assertSanitized({ tools: [{ tool: "x", query: "leak" }] })).toThrow(/forbidden key "query"/);
    expect(() => assertSanitized({ env: { hostname: "greg-mac" } })).toThrow(/forbidden key "hostname"/);
    expect(() => assertSanitized({ a: { b: { path: "/x" } } })).toThrow(/forbidden key "path"/);
  });

  it("allows benign values that merely look sensitive (extension values, not keys)", () => {
    expect(() => assertSanitized({ env: { top3_ext: [".ts", ".tsx", ".py"] } })).not.toThrow();
  });
});
