/**
 * Benchmark: trace_call_chain, get_repo_outline, trace_route
 *
 * Run: npx tsx benchmarks/trace-outline-route-benchmark.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { traceCallChain } from "../src/tools/graph-tools.js";
import { getRepoOutline } from "../src/tools/outline-tools.js";
import { traceRoute } from "../src/tools/route-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { formatRepoOutline, formatCallTree, formatTraceRoute } from "../src/formatters.js";

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const GREP_HEAD_LIMIT = 250;
const RG_EXCLUDES = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!.playwright-mcp --glob=!*.d.ts --glob=!generated";

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function tokJson(v: unknown): number { return Math.ceil(JSON.stringify(v, null, 2).length / 4); }
function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "0%" : "n/a";
  const d = Math.round(((current - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

function rg(root: string, pattern: string, extra = ""): string {
  const cmd = `rg --no-heading -n ${extra} ${RG_EXCLUDES} -- '${pattern.replace(/'/g, "'\\''")}' '${root}' | head -${GREP_HEAD_LIMIT}`;
  try { return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) return String((err as { stdout?: string }).stdout ?? ""); return ""; }
}

interface Row { flow: string; query: string; repo: string; nativeTok: number; siftTok: number; nativeMs: number; siftMs: number }

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  for (const repo of REPOS) await getCodeIndex(repo.id);

  // ═══════════════════════════════════════════════
  // Flow 1: trace_call_chain vs manual grep chain
  // Native: grep(X) → find callers → grep each caller → repeat
  // Sift: trace_call_chain(X, "callers", depth=2)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 1: trace_call_chain vs Grep chain ═══");
  console.log("Native: 3x Grep (symbol → callers → callers)  |  Sift: trace_call_chain(depth=2)\n");

  const traceQueries = ["searchText", "loadConfig", "getCodeIndex", "buildBM25Index"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of traceQueries) {
      // Native: 3 sequential greps to trace callers
      const nativeStart = performance.now();
      // Step 1: find definition
      const step1 = rg(repo.root, q, "-w --glob=*.ts --glob=*.tsx");
      // Step 2: find files that import/use it
      const step2 = rg(repo.root, q, "-w --glob=*.ts --glob=*.tsx -l");
      // Step 3: for each file, grep for function definitions (to find caller names)
      const callerFiles = step2.split("\n").filter(Boolean).slice(0, 5);
      let step3 = "";
      for (const f of callerFiles) {
        try {
          step3 += execSync(`rg --no-heading -n '(export )?(async )?function ' '${f}' | head -20`, { encoding: "utf-8", timeout: 5000, shell: "/bin/sh" });
        } catch { /* */ }
      }
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(step1) + tokStr(step2) + tokStr(step3);

      // Sift: one call
      const siftStart = performance.now();
      let siftTok = 0;
      try {
        const result = await traceCallChain(repo.id, q, "callers", { depth: 2 });
        siftTok = tokStr(formatCallTree(result as never));
      } catch { /* symbol not found in this repo */ }
      const siftMs = Math.round(performance.now() - siftStart);

      allRows.push({ flow: "trace_call_chain", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 2: get_repo_outline vs find + wc
  // Native: find . -type f | sort + wc -l per dir
  // Sift: get_repo_outline → text format
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 2: get_repo_outline vs find + wc ═══");
  console.log("Native: find + wc -l per directory  |  Sift: get_repo_outline\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    // Native: find dirs + count files + count lines
    const nativeStart = performance.now();
    let findOutput = "";
    try {
      findOutput = execSync(
        `find '${repo.root}' -type f -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' | grep -v node_modules | grep -v .git | grep -v dist | grep -v .next | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -50`,
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" },
      );
    } catch { /* */ }
    const nativeMs = Math.round(performance.now() - nativeStart);
    const nativeTok = tokStr(findOutput);

    // Sift
    const siftStart = performance.now();
    const result = await getRepoOutline(repo.id);
    const siftMs = Math.round(performance.now() - siftStart);
    const siftTok = tokStr(formatRepoOutline(result as never));

    allRows.push({ flow: "get_repo_outline", query: "full", repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
    console.log(`  native: ${nativeTok} tok, ${nativeMs} ms`);
    console.log(`  sift:   ${siftTok} tok, ${siftMs} ms`);
    console.log(`  diff:   ${pct(siftTok, nativeTok)} tokens, ${pct(siftMs, nativeMs)} speed\n`);
  }

  // ═══════════════════════════════════════════════
  // Flow 3: trace_route vs manual grep handler chain
  // Native: grep(route path) → find handler → grep handler for service calls → grep DB calls
  // Sift: trace_route(path)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 3: trace_route vs Grep handler chain ═══");
  console.log("Native: Grep(route) → Grep(handler) → Grep(service) → Grep(DB)  |  Sift: trace_route\n");

  const routeQueries: Record<string, string[]> = {
    "codesift-mcp": [], // no HTTP routes
    "translation-qa": ["/api/projects", "/api/projects/create-stream"],
    "promptvault": ["/api/v1/organizations", "/api/v1/rate-limits"],
  };

  for (const repo of REPOS) {
    const routes = routeQueries[repo.label] ?? [];
    if (routes.length === 0) {
      console.log(`repo: ${repo.label} — no HTTP routes, skipping\n`);
      continue;
    }

    console.log(`repo: ${repo.label}`);
    console.log("route                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const route of routes) {
      // Native: 4 sequential greps
      const nativeStart = performance.now();
      const routeSegment = route.split("/").pop() ?? route;
      const step1 = rg(repo.root, routeSegment, "--glob=*.ts --glob=*.tsx"); // find route file
      const step2 = rg(repo.root, `(GET|POST|PUT|DELETE|PATCH)`, `--glob='*${routeSegment}*' --glob=*.ts -A 10`); // find handler
      const step3 = rg(repo.root, "service", `--glob='*${routeSegment}*' --glob=*.ts`); // find service calls
      const step4 = rg(repo.root, "(prisma|findMany|create|update|delete)", `--glob='*${routeSegment}*' --glob=*.ts`); // find DB calls
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(step1) + tokStr(step2) + tokStr(step3) + tokStr(step4);

      // Sift
      const siftStart = performance.now();
      let siftTok = 0;
      try {
        const result = await traceRoute(repo.id, route);
        siftTok = tokStr(formatTraceRoute(result as never));
      } catch { /* route not found */ }
      const siftMs = Math.round(performance.now() - siftStart);

      allRows.push({ flow: "trace_route", query: route, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${route.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // Summary
  console.log("\n═══ SUMMARY ═══\n");
  for (const flow of ["trace_call_chain", "get_repo_outline", "trace_route"]) {
    const rows = allRows.filter(r => r.flow === flow);
    if (rows.length === 0) continue;
    const nTok = rows.reduce((s, r) => s + r.nativeTok, 0);
    const sTok = rows.reduce((s, r) => s + r.siftTok, 0);
    const nMs = rows.reduce((s, r) => s + r.nativeMs, 0);
    const sMs = rows.reduce((s, r) => s + r.siftMs, 0);
    const sWins = rows.filter(r => r.nativeTok > 0 && r.siftTok < r.nativeTok).length;
    const nWins = rows.filter(r => r.nativeTok > 0 && r.nativeTok < r.siftTok).length;

    console.log(`${flow}`);
    console.log(`  native: ${nTok} tok, ${nMs} ms`);
    console.log(`  sift:   ${sTok} tok, ${sMs} ms`);
    console.log(`  token diff: ${pct(sTok, nTok)}  speed diff: ${pct(sMs, nMs)}`);
    console.log(`  sift wins: ${sWins}/${rows.length}  native wins: ${nWins}/${rows.length}\n`);
  }

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `trace-outline-route-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
