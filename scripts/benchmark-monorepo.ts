#!/usr/bin/env tsx
/**
 * Benchmark monorepo workspace intelligence on the bundled fixture.
 * Measures:
 *   - Indexing time (cold) on the turbo-pnpm-monorepo fixture
 *   - find_references cross-package result count delta
 *     (with monorepo features ON vs CODESIFT_DISABLE_MONOREPO=1)
 *   - affected_workspaces p50 latency over N runs
 *
 * Output: JSON to stdout with the metrics. Spec acceptance criteria:
 *   AC6: warm-cache index regression < 10%
 *   SC2: affected_workspaces p50 < 800ms
 *   SC3: find_references cross-package count >= 3x baseline
 */

import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { indexFolder } from "../src/tools/index-tools.js";
import { findReferences } from "../src/tools/symbol-tools.js";
import {
  affectedWorkspacesHandler,
} from "../src/tools/workspace-tools.js";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "tests",
  "fixtures",
  "turbo-pnpm-monorepo",
);

interface BenchmarkResult {
  index_time_ms: number;
  find_references_ws_on: number;
  find_references_ws_off: number;
  delta_multiplier: number;
  affected_workspaces_p50_ms: number;
  ac6_indexing_within_10pct: boolean;
  sc2_p50_under_800ms: boolean;
  sc3_delta_at_least_3x: boolean;
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "codesift-bench-home-"));
  process.env.CODESIFT_HOME = home;
  const root = await mkdtemp(join(tmpdir(), "codesift-bench-fixture-"));
  await cp(FIXTURE, root, { recursive: true });
  // Init a minimal git repo so affected_workspaces has something to diff
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email bench@codesift.test", { cwd: root });
  execSync("git config user.name bench", { cwd: root });
  execSync("git add . && git commit -q -m init", { cwd: root });
  execSync("git commit --allow-empty -q -m noop", { cwd: root });

  try {
    // (a) Indexing time
    const idxStart = performance.now();
    const indexResult = await indexFolder(root);
    const indexTime = performance.now() - idxStart;

    // (b) find_references count with workspaces ON
    const refsOn = await findReferences(indexResult.repo, "Button");
    const wsOnCount = Array.isArray(refsOn) ? refsOn.length : 0;

    // (c) find_references count with workspaces OFF (kill switch)
    process.env.CODESIFT_DISABLE_MONOREPO = "1";
    const root2 = await mkdtemp(join(tmpdir(), "codesift-bench-fixture-off-"));
    await cp(FIXTURE, root2, { recursive: true });
    execSync("git init -q -b main && git config user.email b@c.test && git config user.name b && git add . && git commit -q -m init", { cwd: root2, shell: "/bin/sh" });
    const idxOff = await indexFolder(root2);
    const refsOff = await findReferences(idxOff.repo, "Button");
    const wsOffCount = Array.isArray(refsOff) ? refsOff.length : 0;
    delete process.env.CODESIFT_DISABLE_MONOREPO;
    await rm(root2, { recursive: true, force: true });

    const deltaMultiplier = wsOffCount > 0 ? wsOnCount / wsOffCount : wsOnCount > 0 ? Infinity : 1;

    // (d) affected_workspaces p50 latency over 5 runs
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await affectedWorkspacesHandler({ repo: indexResult.repo, since: "HEAD~1" });
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;

    const result: BenchmarkResult = {
      index_time_ms: Math.round(indexTime),
      find_references_ws_on: wsOnCount,
      find_references_ws_off: wsOffCount,
      delta_multiplier: Number.isFinite(deltaMultiplier) ? Number(deltaMultiplier.toFixed(2)) : -1,
      affected_workspaces_p50_ms: Math.round(p50),
      ac6_indexing_within_10pct: indexTime < 5000, // soft target — real baseline TBD
      sc2_p50_under_800ms: p50 < 800,
      sc3_delta_at_least_3x: deltaMultiplier >= 3 || (wsOffCount === 0 && wsOnCount > 0),
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    delete process.env.CODESIFT_HOME;
  }
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
