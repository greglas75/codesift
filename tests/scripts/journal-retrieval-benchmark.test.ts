import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadQueries } from "../../scripts/journal-retrieval-benchmark.js";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT = join(REPO_ROOT, "scripts/journal-retrieval-benchmark.ts");
const YAML_PATH = join(REPO_ROOT, "benchmarks/journal-queries.yaml");

describe("journal-retrieval-benchmark", () => {
  // (a) --dry-run smoke: loads YAML, prints "20 queries loaded", exits 0, no external calls
  it("--dry-run prints '20 queries loaded' and exits 0", () => {
    const proc = spawnSync("npx", ["tsx", SCRIPT, "--dry-run"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("20 queries loaded");
  });

  // (b) YAML shape: exactly 20 entries each with required fields
  it("YAML has exactly 20 entries, each with required fields", async () => {
    const queries = await loadQueries(YAML_PATH);
    expect(queries).toHaveLength(20);
    for (const q of queries) {
      expect(typeof q.query).toBe("string");
      expect(q.query.length).toBeGreaterThan(0);
      expect(typeof q.expected_phase_slug).toBe("string");
      expect(q.expected_phase_slug.length).toBeGreaterThan(0);
      expect(Array.isArray(q.expected_commit_shas)).toBe(true);
      expect(q.expected_commit_shas.length).toBeGreaterThan(0);
      expect(Array.isArray(q.forbidden_claims)).toBe(true);
      expect(q.forbidden_claims.length).toBeGreaterThan(0);
    }
  });

  // (c) CLAUDE_BENCH_MODEL env override is reflected in stdout
  it("respects CLAUDE_BENCH_MODEL env override in stdout", () => {
    const overrideModel = "claude-opus-4-5";
    const proc = spawnSync("npx", ["tsx", SCRIPT, "--dry-run"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_BENCH_MODEL: overrideModel },
    });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain(`Model: ${overrideModel}`);
  });
});
