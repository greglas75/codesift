/**
 * REAL FLOW benchmark: find_dead_code, impact_analysis, find_clones, get_knowledge_map (corrected)
 *
 * Every native flow simulates what an agent ACTUALLY does — multiple tool calls.
 *
 * Run: npx tsx benchmarks/deadcode-impact-clones-knowledgemap-benchmark.ts
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { findDeadCode } from "../src/tools/symbol-tools.js";
import { impactAnalysis } from "../src/tools/impact-tools.js";
import { findClones } from "../src/tools/clone-tools.js";
import { getKnowledgeMap } from "../src/tools/context-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { formatDeadCode, formatClones, formatKnowledgeMap, formatImpactAnalysis } from "../src/formatters.js";

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const GREP_HEAD_LIMIT = 250;
const RG_EXCLUDES = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!*.d.ts --glob=!generated";

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

function shell(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) return String((err as { stdout?: string }).stdout ?? ""); return ""; }
}

interface Row { flow: string; query: string; repo: string; nativeTok: number; siftTok: number; nativeMs: number; siftMs: number; nativeCalls: number }

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  for (const repo of REPOS) await getCodeIndex(repo.id);

  // ═══════════════════════════════════════════════
  // Flow 1: find_dead_code
  // Native: Agent must:
  //   1. Grep("export ") to find all exports
  //   2. For each export, Grep(name, -w, -l) to check if it's used elsewhere
  //   3. If only in defining file → dead code candidate
  // This is N+1 greps. Simulating for top 20 exports.
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 1: find_dead_code ═══");
  console.log("Native: Grep(exports) → N× Grep(name -w -l) per export  |  Sift: find_dead_code\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    const nativeStart = performance.now();
    let nativeCalls = 0;
    let nativeTok = 0;

    // Step 1: find all exports
    const exports = rg(repo.root, "export (async )?(function|class|interface|type|const) ", "--glob=*.ts --glob=*.tsx");
    nativeTok += tokStr(exports);
    nativeCalls++;

    // Step 2: for each export, check if used outside defining file
    const exportLines = exports.split("\n").filter(Boolean).slice(0, 20);
    for (const line of exportLines) {
      const nameMatch = line.match(/(function|class|interface|type|const)\s+(\w+)/);
      if (!nameMatch || !nameMatch[2]) continue;
      const name = nameMatch[2];
      if (name.length < 3) continue;

      const refs = rg(repo.root, name, "-w -l --glob=*.ts --glob=*.tsx");
      nativeTok += tokStr(refs);
      nativeCalls++;
    }
    const nativeMs = Math.round(performance.now() - nativeStart);

    // Sift
    const siftStart = performance.now();
    const result = await findDeadCode(repo.id, {});
    const siftMs = Math.round(performance.now() - siftStart);
    const siftTok = tokStr(formatDeadCode(result as never));

    allRows.push({ flow: "find_dead_code", query: "all", repo: repo.label, nativeTok, siftTok, nativeMs, siftMs, nativeCalls });
    console.log(`  native: ${nativeTok} tok, ${nativeMs} ms, ${nativeCalls} calls`);
    console.log(`  sift:   ${siftTok} tok, ${siftMs} ms, 1 call`);
    console.log(`  diff:   ${pct(siftTok, nativeTok)} tokens, ${pct(siftMs, nativeMs)} speed\n`);
  }

  // ═══════════════════════════════════════════════
  // Flow 2: impact_analysis — "what breaks if I change HEAD~3?"
  // Native: Agent must:
  //   1. git diff --name-only HEAD~3
  //   2. For each changed file, Grep(exports from that file) in other files
  //   3. Read changed files to see what functions changed
  //   4. Grep each changed function name to find callers
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 2: impact_analysis ═══");
  console.log("Native: git diff + N× Grep(changed symbols)  |  Sift: impact_analysis\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    const nativeStart = performance.now();
    let nativeCalls = 0;
    let nativeTok = 0;

    // Step 1: git diff
    const diff = shell(`cd '${repo.root}' && git diff --name-only HEAD~3 2>/dev/null | head -20`);
    nativeTok += tokStr(diff);
    nativeCalls++;

    // Step 2: for each changed file, find what it exports
    const changedFiles = diff.split("\n").filter(Boolean).filter(f => f.endsWith(".ts") || f.endsWith(".tsx")).slice(0, 5);
    for (const file of changedFiles) {
      const fileExports = rg(repo.root, "export ", `--glob='${file}'`);
      nativeTok += tokStr(fileExports);
      nativeCalls++;
    }

    // Step 3: for each export, grep callers
    for (const file of changedFiles.slice(0, 3)) {
      const basename = path.basename(file, path.extname(file));
      const callers = rg(repo.root, basename, "-w -l --glob=*.ts --glob=*.tsx");
      nativeTok += tokStr(callers);
      nativeCalls++;
    }

    // Step 4: find test files
    const tests = rg(repo.root, "test|spec", `-l --glob='*.test.*' --glob='*.spec.*'`);
    nativeTok += tokStr(tests);
    nativeCalls++;

    const nativeMs = Math.round(performance.now() - nativeStart);

    // Sift
    const siftStart = performance.now();
    let siftTok = 0;
    try {
      const result = await impactAnalysis(repo.id, "HEAD~3", {});
      siftTok = tokStr(formatImpactAnalysis(result as never));
    } catch { /* git error */ }
    const siftMs = Math.round(performance.now() - siftStart);

    allRows.push({ flow: "impact_analysis", query: "HEAD~3", repo: repo.label, nativeTok, siftTok, nativeMs, siftMs, nativeCalls });
    console.log(`  native: ${nativeTok} tok, ${nativeMs} ms, ${nativeCalls} calls`);
    console.log(`  sift:   ${siftTok} tok, ${siftMs} ms, 1 call`);
    console.log(`  diff:   ${pct(siftTok, nativeTok)} tokens, ${pct(siftMs, nativeMs)} speed\n`);
  }

  // ═══════════════════════════════════════════════
  // Flow 3: find_clones — "find copy-pasted functions"
  // Native: Agent CANNOT do this. Would need to:
  //   1. Grep all function definitions
  //   2. Read each function body
  //   3. Manually compare pairs for similarity
  // This is O(n²) and impractical. Simulating partial attempt.
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 3: find_clones ═══");
  console.log("Native: Grep(functions) + N× Read bodies + manual compare (impractical)  |  Sift: find_clones\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    const nativeStart = performance.now();
    let nativeCalls = 0;
    let nativeTok = 0;

    // Step 1: find all functions
    const funcs = rg(repo.root, "(export )?(async )?function \\w+", "--glob=*.ts --glob=*.tsx");
    nativeTok += tokStr(funcs);
    nativeCalls++;

    // Step 2: read first 10 function bodies (agent would need to compare)
    const funcLines = funcs.split("\n").filter(Boolean).slice(0, 10);
    for (const line of funcLines) {
      const fileMatch = line.match(/^([^:]+):/);
      if (!fileMatch?.[1]) continue;
      try {
        const content = readFileSync(fileMatch[1], "utf-8");
        nativeTok += tokStr(content.slice(0, 2000)); // first 2000 chars per file
        nativeCalls++;
      } catch { /* */ }
    }
    const nativeMs = Math.round(performance.now() - nativeStart);

    // Sift
    const siftStart = performance.now();
    const result = await findClones(repo.id, {});
    const siftMs = Math.round(performance.now() - siftStart);
    const siftTok = tokStr(formatClones(result as never));

    allRows.push({ flow: "find_clones", query: "all", repo: repo.label, nativeTok, siftTok, nativeMs, siftMs, nativeCalls });
    console.log(`  native: ${nativeTok} tok, ${nativeMs} ms, ${nativeCalls} calls (partial — full comparison impractical)`);
    console.log(`  sift:   ${siftTok} tok, ${siftMs} ms, 1 call`);
    console.log(`  diff:   ${pct(siftTok, nativeTok)} tokens, ${pct(siftMs, nativeMs)} speed\n`);
  }

  // ═══════════════════════════════════════════════
  // Flow 4: get_knowledge_map (corrected real flow)
  // Native: Agent must do multiple greps to trace imports:
  //   1. Grep(import.*from) in each directory
  //   2. For each unique import target, Grep(import target) to find reverse deps
  //   3. Try to detect cycles by following chains
  // Simulating 5-10 grep calls.
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 4: get_knowledge_map (real multi-step flow) ═══");
  console.log("Native: N× Grep(imports) per dir + reverse dep tracing  |  Sift: get_knowledge_map\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    const nativeStart = performance.now();
    let nativeCalls = 0;
    let nativeTok = 0;

    // Step 1: find all import statements
    const imports = rg(repo.root, "from ['\"]\\./", "--glob=*.ts --glob=*.tsx");
    nativeTok += tokStr(imports);
    nativeCalls++;

    // Step 2: find top directories
    const dirs = shell(`find '${repo.root}/src' -type d -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -20`);
    nativeTok += tokStr(dirs);
    nativeCalls++;

    // Step 3: for each top dir, grep imports to see what it depends on
    const topDirs = dirs.split("\n").filter(Boolean).slice(0, 5);
    for (const dir of topDirs) {
      const dirImports = rg(dir, "from ['\"]", "--glob=*.ts --glob=*.tsx");
      nativeTok += tokStr(dirImports);
      nativeCalls++;
    }

    // Step 4: try to find circular deps — grep each module for imports of its importers
    const importTargets = imports.split("\n").filter(Boolean).slice(0, 5);
    for (const line of importTargets) {
      const targetMatch = line.match(/from ['"]\.\/([^'"]+)['"]/);
      if (!targetMatch?.[1]) continue;
      const reverseGrep = rg(repo.root, targetMatch[1], "--glob=*.ts --glob=*.tsx -l");
      nativeTok += tokStr(reverseGrep);
      nativeCalls++;
    }

    const nativeMs = Math.round(performance.now() - nativeStart);

    // Sift
    const siftStart = performance.now();
    let siftTok = 0;
    try {
      const result = await getKnowledgeMap(repo.id, "src");
      siftTok = tokStr(formatKnowledgeMap(result as never));
    } catch { /* */ }
    const siftMs = Math.round(performance.now() - siftStart);

    allRows.push({ flow: "get_knowledge_map", query: "src", repo: repo.label, nativeTok, siftTok, nativeMs, siftMs, nativeCalls });
    console.log(`  native: ${nativeTok} tok, ${nativeMs} ms, ${nativeCalls} calls`);
    console.log(`  sift:   ${siftTok} tok, ${siftMs} ms, 1 call`);
    console.log(`  diff:   ${pct(siftTok, nativeTok)} tokens, ${pct(siftMs, nativeMs)} speed\n`);
  }

  // Summary
  console.log("\n═══ SUMMARY ═══\n");
  for (const flow of ["find_dead_code", "impact_analysis", "find_clones", "get_knowledge_map"]) {
    const rows = allRows.filter(r => r.flow === flow);
    if (rows.length === 0) continue;
    const nTok = rows.reduce((s, r) => s + r.nativeTok, 0);
    const sTok = rows.reduce((s, r) => s + r.siftTok, 0);
    const nMs = rows.reduce((s, r) => s + r.nativeMs, 0);
    const sMs = rows.reduce((s, r) => s + r.siftMs, 0);
    const totalCalls = rows.reduce((s, r) => s + r.nativeCalls, 0);
    const sWins = rows.filter(r => r.siftTok < r.nativeTok).length;
    const nWins = rows.filter(r => r.nativeTok < r.siftTok).length;

    console.log(`${flow}`);
    console.log(`  native: ${nTok} tok, ${nMs} ms, ${totalCalls} calls`);
    console.log(`  sift:   ${sTok} tok, ${sMs} ms, ${rows.length} calls`);
    console.log(`  token diff: ${pct(sTok, nTok)}  speed diff: ${pct(sMs, nMs)}`);
    console.log(`  sift wins: ${sWins}/${rows.length}  native wins: ${nWins}/${rows.length}\n`);
  }

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `deadcode-impact-clones-kmap-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
