/**
 * Smoke test — run nextjs tools on a real project.
 * Usage: npx tsx scratch/run-nextjs-tools.ts /path/to/project
 */
import { analyzeNextjsComponents } from "../src/tools/nextjs-component-tools.js";
import { nextjsRouteMap } from "../src/tools/nextjs-route-tools.js";
import { indexFolder } from "../src/tools/index-tools.js";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? "~/DEV/MYA");
console.log(`\n=== Running Next.js tools on ${target} ===\n`);

// Index the project first
console.log("[1/3] Indexing...");
const t0 = Date.now();
const indexResult = await indexFolder(target, { watch: false });
console.log(`    indexed ${indexResult.symbol_count} symbols across ${indexResult.file_count} files in ${Date.now() - t0}ms`);
console.log(`    repo id: ${indexResult.repo}\n`);
const repo = indexResult.repo;

// analyze_nextjs_components
console.log("[2/3] analyze_nextjs_components...");
const t1 = Date.now();
try {
  const comp = await analyzeNextjsComponents(repo, { max_files: 2000 });
  console.log(`    elapsed: ${Date.now() - t1}ms`);
  console.log(`    total files: ${comp.counts.total}`);
  console.log(`    server:            ${comp.counts.server}`);
  console.log(`    client (explicit): ${comp.counts.client_explicit}`);
  console.log(`    client (inferred): ${comp.counts.client_inferred}`);
  console.log(`    ambiguous:         ${comp.counts.ambiguous}`);
  console.log(`    unnecessary use client: ${comp.counts.unnecessary_use_client}`);
  console.log(`    parse failures: ${comp.parse_failures.length}`);
  console.log(`    scan errors:    ${comp.scan_errors.length}`);
  if (comp.truncated) console.log(`    TRUNCATED at ${comp.truncated_at}`);

  // Top 10 unnecessary use client
  const unnecessary = comp.files.filter((f) => f.violations.includes("unnecessary_use_client"));
  if (unnecessary.length > 0) {
    console.log(`\n    Top ${Math.min(10, unnecessary.length)} unnecessary 'use client':`);
    for (const f of unnecessary.slice(0, 10)) {
      console.log(`      - ${f.path}`);
    }
  }

  // Top 10 client_inferred (hooks without directive — missing use client)
  const inferred = comp.files.filter((f) => f.classification === "client_inferred");
  if (inferred.length > 0) {
    console.log(`\n    Top ${Math.min(10, inferred.length)} client_inferred (missing "use client"?):`);
    for (const f of inferred.slice(0, 10)) {
      const signals = [
        ...f.signals.hooks.slice(0, 2).map((h) => `hook:${h}`),
        ...f.signals.event_handlers.slice(0, 2).map((e) => `event:${e}`),
        ...f.signals.browser_globals.slice(0, 2).map((g) => `global:${g}`),
      ].slice(0, 3).join(", ");
      console.log(`      - ${f.path}  [${signals}]`);
    }
  }
} catch (err) {
  console.error("    FAILED:", err instanceof Error ? err.message : err);
}

console.log("\n[3/3] nextjs_route_map...");
const t2 = Date.now();
try {
  const routes = await nextjsRouteMap(repo, { max_routes: 1000 });
  console.log(`    elapsed: ${Date.now() - t2}ms`);
  console.log(`    total routes: ${routes.routes.length}`);
  console.log(`    conflicts: ${routes.conflicts.length}`);
  console.log(`    scan errors: ${routes.scan_errors.length}`);

  // Breakdown by type
  const byType: Record<string, number> = {};
  const byRendering: Record<string, number> = {};
  const byRouter: Record<string, number> = {};
  for (const r of routes.routes) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
    byRendering[r.rendering] = (byRendering[r.rendering] ?? 0) + 1;
    byRouter[r.router] = (byRouter[r.router] ?? 0) + 1;
  }
  console.log(`\n    By type:      ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`    By rendering: ${Object.entries(byRendering).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`    By router:    ${Object.entries(byRouter).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  // Sample 5 routes
  const pages = routes.routes.filter((r) => r.type === "page" || r.type === "route");
  console.log(`\n    Sample routes:`);
  for (const r of pages.slice(0, 5)) {
    console.log(`      ${r.url_path.padEnd(40)} ${r.rendering.padEnd(10)} ${r.router}  ${r.file_path}`);
  }

  // Routes without metadata
  const noMetadata = routes.routes.filter((r) => r.type === "page" && !r.has_metadata);
  if (noMetadata.length > 0) {
    console.log(`\n    Pages without metadata: ${noMetadata.length}`);
    for (const r of noMetadata.slice(0, 5)) {
      console.log(`      - ${r.url_path}  (${r.file_path})`);
    }
  }
} catch (err) {
  console.error("    FAILED:", err instanceof Error ? err.message : err);
}

console.log("\n=== Done ===\n");
process.exit(0);
