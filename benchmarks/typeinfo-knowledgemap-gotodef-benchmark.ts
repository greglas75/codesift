/**
 * Benchmark: get_type_info, get_knowledge_map, go_to_definition
 *
 * Run: npx tsx benchmarks/typeinfo-knowledgemap-gotodef-benchmark.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { goToDefinition, getTypeInfo } from "../src/lsp/lsp-tools.js";
import { getKnowledgeMap } from "../src/tools/context-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { formatKnowledgeMap } from "../src/formatters.js";

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const GREP_HEAD_LIMIT = 250;
const RG_EXCLUDES = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!*.d.ts";

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
  // Flow 1: go_to_definition vs Grep for definition
  // Native: Grep("function X" or "class X" or "interface X")
  // Sift: go_to_definition(X)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 1: go_to_definition vs Grep ═══");
  console.log("Native: Grep(function/class/type X)  |  Sift: go_to_definition\n");

  const defQueries = ["searchText", "CodeSymbol", "BM25Index", "TextMatch", "loadConfig"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of defQueries) {
      // Native: grep for definition
      const nativeStart = performance.now();
      const output = rg(repo.root, `(export )?(async )?(function|class|interface|type) ${q}`, "--glob=*.ts --glob=*.tsx");
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(output);

      // Sift
      const siftStart = performance.now();
      let siftTok = 0;
      try {
        const result = await goToDefinition(repo.id, q);
        if (result) {
          const preview = result.preview ? `\n${result.preview}` : "";
          siftTok = tokStr(`${result.file}:${result.line + 1} (via ${result.via})${preview}`);
        }
      } catch { /* not found */ }
      const siftMs = Math.round(performance.now() - siftStart);

      allRows.push({ flow: "go_to_definition", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 2: get_type_info — mostly UNIQUE (LSP hover)
  // Native: Grep for type annotation (rough approximation)
  // Sift: get_type_info(X)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 2: get_type_info (LSP hover — mostly unique) ═══");
  console.log("Sift: get_type_info  |  Native: grep for return type (rough)\n");

  const typeQueries = ["searchText", "loadConfig", "getCodeIndex", "buildBM25Index"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of typeQueries) {
      // Native: grep function signature to see return type
      const nativeStart = performance.now();
      const output = rg(repo.root, `(export )?(async )?function ${q}`, "--glob=*.ts");
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(output);

      // Sift
      const siftStart = performance.now();
      let siftTok = 0;
      try {
        const result = await getTypeInfo(repo.id, q);
        siftTok = tokJson(result);
      } catch { /* not found */ }
      const siftMs = Math.round(performance.now() - siftStart);

      allRows.push({ flow: "get_type_info", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 3: get_knowledge_map vs manual import tracing
  // Native: Grep for import statements → build mental model
  // Sift: get_knowledge_map(focus="src")
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 3: get_knowledge_map vs Grep imports ═══");
  console.log("Native: Grep(import/from) per dir  |  Sift: get_knowledge_map(focus)\n");

  const focusScopes = ["src", "src/tools", "lib"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("focus                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const focus of focusScopes) {
      // Native: grep import statements in focus dir
      const nativeStart = performance.now();
      const output = rg(repo.root, "from ['\"]\\./", `--glob='${focus}/**/*.ts' --glob='${focus}/**/*.tsx'`);
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(output);

      // Sift
      const siftStart = performance.now();
      let siftTok = 0;
      try {
        const result = await getKnowledgeMap(repo.id, focus);
        siftTok = tokStr(formatKnowledgeMap(result as never));
      } catch { /* */ }
      const siftMs = Math.round(performance.now() - siftStart);

      allRows.push({ flow: "get_knowledge_map", query: focus, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${focus.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // Summary
  console.log("\n═══ SUMMARY ═══\n");
  for (const flow of ["go_to_definition", "get_type_info", "get_knowledge_map"]) {
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
  const outPath = path.join(resultsDir, `typeinfo-knowledgemap-gotodef-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
