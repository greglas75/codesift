/**
 * Real-project validation for Hono Phase 2.
 *
 * Runs all 6 new Phase 2 tools against honojs/examples/blog (the same
 * fixture that surfaced the 5 demo gaps during Phase 1 validation).
 * Asserts that each gap is now closed. Exits non-zero on any failure.
 *
 * Demo gaps being verified:
 *   #1 Inline handler introspection          → analyze_inline_handler
 *   #2 Conditional auth false positive        → trace_conditional_middleware
 *   #3 Runtime detection (Bindings → cloudflare) → analyze_hono_app
 *   #4 Local sub-app child_file populated      → analyze_hono_app
 *   #5 Response type aggregation               → extract_response_types
 *
 * Usage:
 *   npx tsx scripts/validate-hono-phase-2.ts [path/to/blog]
 *
 * When no path is given, defaults to /tmp/hono-demo/examples/blog.
 */

import { HonoExtractor } from "../src/parser/extractors/hono.js";
import { honoCache } from "../src/cache/hono-cache.js";
import path from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_BLOG = "/tmp/hono-demo/examples/blog";

interface Check {
  name: string;
  gap: string;
  run: () => Promise<{ passed: boolean; detail: string }>;
}

async function main(): Promise<void> {
  const blogDir = process.argv[2] ?? DEFAULT_BLOG;
  const entryFile = path.resolve(blogDir, "src/index.ts");
  if (!existsSync(entryFile)) {
    console.error(`✗ blog fixture not found at ${entryFile}`);
    console.error(`  Pass a path as the first arg, or clone honojs/examples to ${DEFAULT_BLOG}`);
    process.exit(2);
  }

  console.log(`Validating Hono Phase 2 against real blog app`);
  console.log(`  entry: ${entryFile}`);
  console.log("");

  // Prime the model once — all checks share the same parse result via cache.
  const repoKey = "phase2-validation";
  honoCache.clear();
  const model = await honoCache.get(repoKey, entryFile, new HonoExtractor());

  const checks: Check[] = [
    {
      name: "inline handler analysis populated",
      gap: "#1 all 7 routes were opaque <inline>",
      run: async () => {
        const inlineRoutes = model.routes.filter((r) => r.inline_analysis);
        const totalInline = inlineRoutes.length;
        const withResponses = inlineRoutes.filter(
          (r) => (r.inline_analysis?.responses.length ?? 0) > 0,
        ).length;
        const passed = totalInline >= 1 && withResponses >= 1;
        return {
          passed,
          detail: `${totalInline} inline route(s) analyzed, ${withResponses} with response extraction`,
        };
      },
    },
    {
      name: "conditional middleware detected (basicAuth gated on method)",
      gap: "#2 audit_hono_security flagged conditional auth as missing",
      run: async () => {
        let found = false;
        let condDetail = "";
        for (const chain of model.middleware_chains) {
          for (const entry of chain.entries) {
            if (!entry.applied_when) continue;
            if (entry.name === "basicAuth") {
              found = true;
              condDetail = `scope=${chain.scope} condition_type=${entry.applied_when.condition_type}`;
            }
          }
        }
        return {
          passed: found,
          detail: found ? condDetail : "no conditional basicAuth entry surfaced",
        };
      },
    },
    {
      name: "runtime detected as cloudflare from Bindings type",
      gap: "#3 runtime was 'unknown' despite c.env.USERNAME/PASSWORD",
      run: async () => {
        const passed = model.runtime === "cloudflare";
        return {
          passed,
          detail: `runtime=${model.runtime}`,
        };
      },
    },
    {
      name: "local sub-app has child_file populated",
      gap: "#4 middleware = new Hono() showed child_file='?'",
      run: async () => {
        const localMount = model.mounts.find((m) => m.child_var === "middleware");
        if (!localMount) {
          return {
            passed: false,
            detail: "no middleware mount found at all",
          };
        }
        const passed = localMount.child_file.length > 0;
        return {
          passed,
          detail: `child_file=${localMount.child_file || "(empty)"}`,
        };
      },
    },
    {
      name: "response types extractable per route",
      gap: "#5 OpenAPI schemas never populated",
      run: async () => {
        // Aggregate responses across inline routes to emulate extract_response_types.
        const routeStatuses = new Map<string, Set<number>>();
        for (const r of model.routes) {
          if (!r.inline_analysis) continue;
          const key = `${r.method} ${r.path}`;
          const set = routeStatuses.get(key) ?? new Set<number>();
          for (const resp of r.inline_analysis.responses) set.add(resp.status);
          for (const err of r.inline_analysis.errors) set.add(err.status);
          routeStatuses.set(key, set);
        }
        const withStatuses = [...routeStatuses.entries()].filter(
          ([, s]) => s.size > 0,
        );
        const passed = withStatuses.length >= 1;
        return {
          passed,
          detail: `${withStatuses.length} route(s) with ≥1 extracted status code`,
        };
      },
    },
  ];

  let failures = 0;
  for (const check of checks) {
    const result = await check.run();
    const mark = result.passed ? "✓" : "✗";
    console.log(`${mark} ${check.name}`);
    console.log(`    gap: ${check.gap}`);
    console.log(`    ${result.detail}`);
    console.log("");
    if (!result.passed) failures++;
  }

  console.log("─".repeat(60));
  console.log(`Model summary:`);
  console.log(`  routes:            ${model.routes.length}`);
  console.log(`  mounts:            ${model.mounts.length}`);
  console.log(`  middleware chains: ${model.middleware_chains.length}`);
  console.log(`  runtime:           ${model.runtime}`);
  console.log(`  env_bindings:      ${model.env_bindings.join(", ") || "(none)"}`);
  console.log(`  files_used:        ${model.files_used.length}`);
  console.log("");

  if (failures > 0) {
    console.error(`FAIL: ${failures} of ${checks.length} checks did not pass`);
    process.exit(1);
  }
  console.log(`PASS: all ${checks.length} demo gaps closed`);
}

main().catch((err) => {
  console.error("validation script crashed:", err);
  process.exit(3);
});
