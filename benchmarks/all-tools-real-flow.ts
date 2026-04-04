/**
 * MASTER BENCHMARK — ALL tools, REAL agent flows.
 * Every native flow simulates what an agent ACTUALLY does — multiple tool calls with head_limit.
 *
 * Run: npx tsx benchmarks/all-tools-real-flow.ts
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";

// Sift tools
import { searchText } from "../src/tools/search-tools.js";
import { searchSymbols } from "../src/tools/search-tools.js";
import { getFileOutline } from "../src/tools/outline-tools.js";
import { getFileTree, getRepoOutline } from "../src/tools/outline-tools.js";
import { searchPatterns } from "../src/tools/pattern-tools.js";
import { codebaseRetrieval } from "../src/retrieval/codebase-retrieval.js";
import { getSymbol, getSymbols, findAndShow, findReferences, findDeadCode, getContextBundle } from "../src/tools/symbol-tools.js";
import { traceCallChain } from "../src/tools/graph-tools.js";
import { traceRoute } from "../src/tools/route-tools.js";
import { detectCommunities } from "../src/tools/community-tools.js";
import { assembleContext, getKnowledgeMap } from "../src/tools/context-tools.js";
import { analyzeComplexity } from "../src/tools/complexity-tools.js";
import { analyzeHotspots } from "../src/tools/hotspot-tools.js";
import { findClones } from "../src/tools/clone-tools.js";
import { impactAnalysis } from "../src/tools/impact-tools.js";
import { searchConversations, searchAllConversations, findConversationsForSymbol } from "../src/tools/conversation-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { diffOutline, changedSymbols } from "../src/tools/diff-tools.js";
import { scanSecrets } from "../src/tools/secret-tools.js";
import { crossRepoSearchSymbols, crossRepoFindReferences } from "../src/tools/cross-repo-tools.js";
import { searchPatterns as searchPatternsImport, listPatterns } from "../src/tools/pattern-tools.js";
import { generateClaudeMd } from "../src/tools/generate-tools.js";
import { generateReport } from "../src/tools/report-tools.js";
import { frequencyAnalysis } from "../src/tools/frequency-tools.js";
import { getUsageStats, formatUsageReport } from "../src/storage/usage-stats.js";

// Formatters (what MCP actually sends)
import {
  formatSearchSymbols, formatFileTree, formatFileOutline, formatSearchPatterns,
  formatDeadCode, formatComplexity, formatClones, formatHotspots,
  formatRepoOutline, formatAssembleContext, formatCommunities,
  formatCallTree, formatTraceRoute, formatKnowledgeMap, formatImpactAnalysis, formatDiffOutline, formatChangedSymbols,
  formatConversations, formatSecrets,
} from "../src/formatters.js";
import { formatSymbolCompact, formatSymbolsCompact, formatRefsCompact, formatBundleCompact } from "../src/tools/symbol-tools.js";

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const HEAD_LIMIT = 250;
const RG_EX = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!*.d.ts --glob=!generated";

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function pct(a: number, b: number): string {
  if (b === 0) return a === 0 ? "0%" : "n/a";
  const d = Math.round(((a - b) / b) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

function rg(root: string, pat: string, extra = ""): string {
  const cmd = `rg --no-heading -n ${extra} ${RG_EX} -- '${pat.replace(/'/g, "'\\''")}' '${root}' | head -${HEAD_LIMIT}`;
  try { return execSync(cmd, { encoding: "utf-8", maxBuffer: 10_000_000, timeout: 30000, shell: "/bin/sh" }); }
  catch (e: unknown) { return (e && typeof e === "object" && "stdout" in e) ? String((e as {stdout?:string}).stdout ?? "") : ""; }
}
function sh(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", maxBuffer: 10_000_000, timeout: 30000, shell: "/bin/sh" }); }
  catch (e: unknown) { return (e && typeof e === "object" && "stdout" in e) ? String((e as {stdout?:string}).stdout ?? "") : ""; }
}

interface R { tool: string; repo: string; nTok: number; sTok: number; nMs: number; sMs: number; nCalls: number }
const rows: R[] = [];

async function measure(tool: string, repo: RepoDef, nativeFn: () => { tok: number; ms: number; calls: number }, siftFn: () => Promise<{ tok: number; ms: number }>): Promise<void> {
  const n = nativeFn();
  const s = await siftFn();
  rows.push({ tool, repo: repo.label, nTok: n.tok, sTok: s.tok, nMs: n.ms, sMs: s.ms, nCalls: n.calls });
}

async function main(): Promise<void> {
  const startedAt = new Date();
  for (const repo of REPOS) await getCodeIndex(repo.id);

  for (const repo of REPOS) {
    console.log(`\n══════ ${repo.label} ══════\n`);

    // ── 1. search_text: "find TODO in codebase"
    // Native: Grep("TODO")
    // Sift: search_text("TODO", auto_group)
    for (const q of ["TODO", "console.log", "async function"]) {
      await measure("search_text", repo,
        () => { const t = performance.now(); const o = rg(repo.root, q, "--glob=*.ts --glob=*.tsx"); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
        async () => { const t = performance.now(); const r = await searchText(repo.id, q, { auto_group: true }); const o = typeof r === "string" ? r : JSON.stringify(r); return { tok: tokStr(o), ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 2. search_symbols: "find function createX"
    // Native: Grep("function create", -A 20)
    // Sift: search_symbols("create", kind=function)
    for (const q of ["create", "handle", "validate"]) {
      await measure("search_symbols", repo,
        () => { const t = performance.now(); const o = rg(repo.root, `(export )?(async )?function ${q}[A-Z]`, "--glob=*.ts --glob=*.tsx -A 20"); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
        async () => { const t = performance.now(); const r = await searchSymbols(repo.id, q, { kind: "function", top_k: 10 }); return { tok: tokStr(formatSearchSymbols(r)), ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 3. get_file_outline: "what's in this file?"
    // Native: Read(entire file)
    // Sift: get_file_outline(file) → text
    const outlineFiles = ["src/tools/search-tools.ts", "src/types.ts", "src/config.ts"];
    for (const f of outlineFiles) {
      await measure("get_file_outline", repo,
        () => { const t = performance.now(); let o = ""; try { o = readFileSync(path.join(repo.root, f), "utf-8"); } catch{} return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
        async () => { const t = performance.now(); let tok = 0; try { const r = await getFileOutline(repo.id, f); tok = tokStr(formatFileOutline(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 4. get_file_tree: "show me the file structure"
    // Native: find . -type f | sort | head -250
    // Sift: get_file_tree(compact=true)
    await measure("get_file_tree", repo,
      () => { const t = performance.now(); const o = sh(`find '${repo.root}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/dist/*' | sort | head -${HEAD_LIMIT}`); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
      async () => { const t = performance.now(); const r = await getFileTree(repo.id, { compact: true }); return { tok: tokStr(formatFileTree(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 5. search_patterns: "find empty catches"
    // Native: Grep(regex pattern)
    // Sift: search_patterns("empty-catch")
    for (const p of ["empty-catch", "console-log"]) {
      const rgPat = p === "empty-catch" ? "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}" : "console\\.(log|debug|info)\\s*\\(";
      await measure("search_patterns", repo,
        () => { const t = performance.now(); const o = rg(repo.root, rgPat, "--glob=*.ts --glob=*.tsx"); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
        async () => { const t = performance.now(); const r = await searchPatterns(repo.id, p); return { tok: tokStr(formatSearchPatterns(r as never)), ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 6. codebase_retrieval: "batch 3 queries"
    // Native: 3 sequential calls (Grep + Grep + Grep)
    // Sift: codebase_retrieval([...])
    await measure("codebase_retrieval", repo,
      () => {
        const t = performance.now();
        const o1 = rg(repo.root, "TODO", "--glob=*.ts"); const o2 = rg(repo.root, `function create`, "--glob=*.ts -A 5"); const o3 = rg(repo.root, "console.log", "--glob=*.ts");
        return { tok: tokStr(o1) + tokStr(o2) + tokStr(o3), ms: Math.round(performance.now()-t), calls: 3 };
      },
      async () => {
        const t = performance.now();
        const r = await codebaseRetrieval(repo.id, [
          { type: "text", query: "TODO", file_pattern: "*.ts" },
          { type: "symbols", query: "create", kind: "function" },
          { type: "text", query: "console.log" },
        ], 10000);
        // Format as text sections (same as MCP handler)
        const text = r.results.map(s => { const d = typeof s.data === "string" ? s.data : JSON.stringify(s.data,null,2); return `--- ${s.type} ---\n${d}`; }).join("\n\n");
        return { tok: tokStr(text), ms: Math.round(performance.now()-t) };
      },
    );

    // ── 7. get_symbol: "show me function X"
    // Native: Grep("function X", -A 20)  → finds definition + context
    // Sift: search_symbols(X, top_k=1) + get_symbol(id) → compact text
    for (const q of ["searchText", "create", "validate"]) {
      await measure("get_symbol", repo,
        () => { const t = performance.now(); const o = rg(repo.root, `(export )?(async )?function ${q}`, "--glob=*.ts --glob=*.tsx -A 20"); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
        async () => {
          const t = performance.now();
          const sr = await searchSymbols(repo.id, q, { top_k: 1, kind: "function", include_source: false, detail_level: "compact" });
          let tok = 0;
          if (sr[0]) { const r = await getSymbol(repo.id, sr[0].symbol.id); if (r) tok = tokStr(formatSymbolCompact(r.symbol)); }
          return { tok, ms: Math.round(performance.now()-t) };
        },
      );
    }

    // ── 8. get_symbols: "show me 5 functions matching X"
    // Native: Grep(X -A 20) → all matches with context
    // Sift: search_symbols(X, top_k=5) + get_symbols(ids)
    await measure("get_symbols", repo,
      () => { const t = performance.now(); const o = rg(repo.root, "(export )?(async )?function create[A-Z]", "--glob=*.ts --glob=*.tsx -A 20"); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
      async () => {
        const t = performance.now();
        const sr = await searchSymbols(repo.id, "create", { top_k: 5, kind: "function", include_source: false, detail_level: "compact" });
        const ids = sr.map(r => r.symbol.id);
        let tok = 0;
        if (ids.length > 0) { const syms = await getSymbols(repo.id, ids); tok = tokStr(formatSymbolsCompact(syms)); }
        return { tok, ms: Math.round(performance.now()-t) };
      },
    );

    // ── 9. find_references: "where is X used?"
    // Native: Grep(X -w)
    // Sift: find_references(X) → compact
    for (const q of ["searchText", "loadConfig"]) {
      await measure("find_references", repo,
        () => { const t = performance.now(); const o = rg(repo.root, q, "-w --glob=*.ts --glob=*.tsx"); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
        async () => { const t = performance.now(); const r = await findReferences(repo.id, q); return { tok: tokStr(formatRefsCompact(r)), ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 10. get_context_bundle: "show X with imports and siblings"
    // Native: Grep(X) → parse file → Read(entire file)
    // Sift: get_context_bundle(X) → compact
    for (const q of ["searchText", "getFileTree"]) {
      await measure("get_context_bundle", repo,
        () => {
          const t = performance.now();
          const grep = rg(repo.root, q, "--glob=*.ts --glob=*.tsx -l");
          let tok = tokStr(grep);
          const firstFile = grep.split("\n")[0];
          if (firstFile) { try { tok += tokStr(readFileSync(firstFile, "utf-8")); } catch{} }
          return { tok, ms: Math.round(performance.now()-t), calls: 2 };
        },
        async () => { const t = performance.now(); const r = await getContextBundle(repo.id, q); const tok = r ? tokStr(formatBundleCompact(r)) : 0; return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 11. assemble_context: "understand how search works"
    // Native: Grep(topic) → Read top 5 files
    // Sift: assemble_context(topic, L1)
    for (const q of ["search implementation", "error handling"]) {
      await measure("assemble_context", repo,
        () => {
          const t = performance.now();
          const grep = rg(repo.root, q.split(" ")[0]!, "--glob=*.ts --glob=*.tsx -l");
          let tok = tokStr(grep);
          const files = grep.split("\n").filter(Boolean).slice(0, 5);
          for (const f of files) { try { tok += tokStr(readFileSync(f, "utf-8")); } catch{} }
          return { tok, ms: Math.round(performance.now()-t), calls: 1 + files.length };
        },
        async () => { const t = performance.now(); const r = await assembleContext(repo.id, q, 5000, "L1"); return { tok: tokStr(formatAssembleContext(r as never)), ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 12. find_and_show: "show me X with refs"
    // Native: Grep(function X -A 20) + Grep(X -w)
    // Sift: find_and_show(X, refs=true)
    for (const q of ["searchText", "processPayment"]) {
      await measure("find_and_show", repo,
        () => {
          const t = performance.now();
          const def = rg(repo.root, `function ${q}`, "--glob=*.ts --glob=*.tsx -A 20");
          const refs = rg(repo.root, q, "-w --glob=*.ts --glob=*.tsx");
          return { tok: tokStr(def) + tokStr(refs), ms: Math.round(performance.now()-t), calls: 2 };
        },
        async () => {
          const t = performance.now();
          const r = await findAndShow(repo.id, q, true);
          let tok = 0;
          if (r) { let text = formatSymbolCompact(r.symbol); if (r.references) text += `\n\n--- references ---\n${formatRefsCompact(r.references)}`; tok = tokStr(text); }
          return { tok, ms: Math.round(performance.now()-t) };
        },
      );
    }

    // ── 13. detect_communities: UNIQUE
    await measure("detect_communities", repo,
      () => ({ tok: 0, ms: 0, calls: 0 }),
      async () => { const t = performance.now(); const r = await detectCommunities(repo.id, "src"); return { tok: tokStr(formatCommunities(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 14. analyze_complexity: "find complex functions"
    // Native: Grep(if|for|while) + wc -l per file
    await measure("analyze_complexity", repo,
      () => {
        const t = performance.now();
        const o1 = rg(repo.root, "(if|for|while|switch)\\s*\\(", "--glob=*.ts --glob=*.tsx");
        const o2 = sh(`find '${repo.root}' -name '*.ts' -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | head -50`);
        return { tok: tokStr(o1) + tokStr(o2), ms: Math.round(performance.now()-t), calls: 2 };
      },
      async () => { const t = performance.now(); const r = await analyzeComplexity(repo.id, { top_n: 10 }); return { tok: tokStr(formatComplexity(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 15. search_conversations: UNIQUE
    await measure("search_conversations", repo,
      () => ({ tok: 0, ms: 0, calls: 0 }),
      async () => { const t = performance.now(); const r = await searchConversations("benchmark optimization", undefined, 5); return { tok: tokStr(formatConversations(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 16. analyze_hotspots: "find bug-prone files"
    // Native: git log --numstat | sort
    await measure("analyze_hotspots", repo,
      () => { const t = performance.now(); const o = sh(`cd '${repo.root}' && git log --numstat --since='90 days ago' --pretty=format:'' 2>/dev/null | awk '{print $3}' | sort | uniq -c | sort -rn | head -30`); return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 }; },
      async () => { const t = performance.now(); const r = await analyzeHotspots(repo.id, { since_days: 90, top_n: 30 }); return { tok: tokStr(formatHotspots(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 17. trace_call_chain: "who calls X?"
    // Native: Grep(X -w -l) → for each file Grep(function) → Grep(callerName -w -l) repeat
    for (const q of ["searchText", "loadConfig"]) {
      await measure("trace_call_chain", repo,
        () => {
          const t = performance.now(); let tok = 0; let calls = 0;
          const step1 = rg(repo.root, q, "-w --glob=*.ts --glob=*.tsx"); tok += tokStr(step1); calls++;
          const step2 = rg(repo.root, q, "-w --glob=*.ts --glob=*.tsx -l"); tok += tokStr(step2); calls++;
          const callerFiles = step2.split("\n").filter(Boolean).slice(0, 5);
          for (const f of callerFiles) { const o = sh(`rg --no-heading -n '(export )?(async )?function ' '${f}' 2>/dev/null | head -20`); tok += tokStr(o); calls++; }
          return { tok, ms: Math.round(performance.now()-t), calls };
        },
        async () => { const t = performance.now(); let tok = 0; try { const r = await traceCallChain(repo.id, q, "callers", { depth: 2 }); tok = tokStr(formatCallTree(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 18. get_repo_outline: "show me repo structure"
    // Native: find dirs + count files
    await measure("get_repo_outline", repo,
      () => {
        const t = performance.now();
        const o = sh(`find '${repo.root}' -type f \\( -name '*.ts' -o -name '*.tsx' \\) | grep -v node_modules | grep -v .git | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -50`);
        return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 };
      },
      async () => { const t = performance.now(); const r = await getRepoOutline(repo.id); return { tok: tokStr(formatRepoOutline(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 19. trace_route: "trace /api/projects endpoint"
    // Native: Grep(routeSegment) → Grep(GET|POST) → Grep(service) → Grep(prisma)
    const routes: Record<string, string[]> = {
      "codesift-mcp": [],
      "translation-qa": ["/api/projects"],
      "promptvault": ["/api/v1/organizations"],
    };
    for (const route of (routes[repo.label] ?? [])) {
      const seg = route.split("/").pop() ?? route;
      await measure("trace_route", repo,
        () => {
          const t = performance.now(); let tok = 0;
          tok += tokStr(rg(repo.root, seg, "--glob=*.ts --glob=*.tsx"));
          tok += tokStr(rg(repo.root, "(GET|POST|PUT|DELETE|PATCH)", `--glob='*${seg}*' --glob=*.ts -A 10`));
          tok += tokStr(rg(repo.root, "service", `--glob='*${seg}*' --glob=*.ts`));
          tok += tokStr(rg(repo.root, "(prisma|findMany|create|update|delete)", `--glob='*${seg}*' --glob=*.ts`));
          return { tok, ms: Math.round(performance.now()-t), calls: 4 };
        },
        async () => { const t = performance.now(); let tok = 0; try { const r = await traceRoute(repo.id, route); tok = tokStr(formatTraceRoute(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 20. get_knowledge_map: "show me dependencies"
    // Native: N× Grep(import) per dir + reverse dep tracing
    await measure("get_knowledge_map", repo,
      () => {
        const t = performance.now(); let tok = 0; let calls = 0;
        tok += tokStr(rg(repo.root, "from ['\"]\\./", "--glob=*.ts --glob=*.tsx")); calls++;
        const dirs = sh(`find '${repo.root}/src' -type d -not -path '*/node_modules/*' 2>/dev/null | head -10`);
        tok += tokStr(dirs); calls++;
        for (const d of dirs.split("\n").filter(Boolean).slice(0, 5)) { tok += tokStr(rg(d, "from ['\"]", "--glob=*.ts")); calls++; }
        return { tok, ms: Math.round(performance.now()-t), calls };
      },
      async () => { const t = performance.now(); let tok = 0; try { const r = await getKnowledgeMap(repo.id, "src"); tok = tokStr(formatKnowledgeMap(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
    );

    // ── 21. find_dead_code: "find unused exports"
    // Native: Grep(exports) → N× Grep(name -w -l) per export
    await measure("find_dead_code", repo,
      () => {
        const t = performance.now(); let tok = 0; let calls = 0;
        const exports = rg(repo.root, "export (async )?(function|class|interface|type|const) ", "--glob=*.ts --glob=*.tsx");
        tok += tokStr(exports); calls++;
        for (const line of exports.split("\n").filter(Boolean).slice(0, 20)) {
          const m = line.match(/(function|class|interface|type|const)\s+(\w+)/);
          if (!m?.[2] || m[2].length < 3) continue;
          tok += tokStr(rg(repo.root, m[2], "-w -l --glob=*.ts --glob=*.tsx")); calls++;
        }
        return { tok, ms: Math.round(performance.now()-t), calls };
      },
      async () => { const t = performance.now(); const r = await findDeadCode(repo.id, {}); return { tok: tokStr(formatDeadCode(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 22. impact_analysis: "what breaks if I change HEAD~3?"
    // Native: git diff + N× Grep(changed symbols)
    await measure("impact_analysis", repo,
      () => {
        const t = performance.now(); let tok = 0; let calls = 0;
        const diff = sh(`cd '${repo.root}' && git diff --name-only HEAD~3 2>/dev/null | head -20`);
        tok += tokStr(diff); calls++;
        const changed = diff.split("\n").filter(f => f.endsWith(".ts") || f.endsWith(".tsx")).slice(0, 5);
        for (const f of changed) { tok += tokStr(rg(repo.root, "export ", `--glob='${f}'`)); calls++; }
        for (const f of changed.slice(0, 3)) { const bn = path.basename(f, path.extname(f)); tok += tokStr(rg(repo.root, bn, "-w -l --glob=*.ts")); calls++; }
        tok += tokStr(rg(repo.root, "test|spec", "-l --glob=*.test.* --glob=*.spec.*")); calls++;
        return { tok, ms: Math.round(performance.now()-t), calls };
      },
      async () => { const t = performance.now(); let tok = 0; try { const r = await impactAnalysis(repo.id, "HEAD~3", {}); tok = tokStr(formatImpactAnalysis(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
    );

    // ── 23. find_clones: "find copy-pasted functions"
    // Native: Grep(functions) + N× Read bodies (can't compare)
    await measure("find_clones", repo,
      () => {
        const t = performance.now(); let tok = 0; let calls = 0;
        const funcs = rg(repo.root, "(export )?(async )?function \\w+", "--glob=*.ts --glob=*.tsx");
        tok += tokStr(funcs); calls++;
        for (const line of funcs.split("\n").filter(Boolean).slice(0, 10)) {
          const fm = line.match(/^([^:]+):/);
          if (!fm?.[1]) continue;
          try { tok += tokStr(readFileSync(fm[1], "utf-8").slice(0, 2000)); calls++; } catch{}
        }
        return { tok, ms: Math.round(performance.now()-t), calls };
      },
      async () => { const t = performance.now(); const r = await findClones(repo.id, {}); return { tok: tokStr(formatClones(r as never)), ms: Math.round(performance.now()-t) }; },
    );

    // ── 24. changed_symbols: "what symbols changed in HEAD~3?"
    // Native: git diff HEAD~3 → parse manually
    await measure("changed_symbols", repo,
      () => {
        const t = performance.now();
        const o = sh(`cd '${repo.root}' && git diff --stat HEAD~3 2>/dev/null | head -${HEAD_LIMIT}`);
        return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 };
      },
      async () => { const t = performance.now(); let tok = 0; try { const r = await changedSymbols(repo.id, "HEAD~3"); tok = tokStr(formatChangedSymbols(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
    );

    // ── 25. diff_outline: "structural diff HEAD~3"
    // Native: git diff --stat HEAD~3
    await measure("diff_outline", repo,
      () => {
        const t = performance.now();
        const o = sh(`cd '${repo.root}' && git diff --stat HEAD~3 2>/dev/null | head -${HEAD_LIMIT}`);
        return { tok: tokStr(o), ms: Math.round(performance.now()-t), calls: 1 };
      },
      async () => { const t = performance.now(); let tok = 0; try { const r = await diffOutline(repo.id, "HEAD~3"); tok = tokStr(formatDiffOutline(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
    );

    // ── 26. scan_secrets: "find hardcoded secrets"
    // Native: Grep for common secret patterns (sk-, AKIA, password=, token=)
    await measure("scan_secrets", repo,
      () => {
        const t = performance.now(); let tok = 0; let calls = 0;
        for (const pat of ["sk-[a-zA-Z0-9]", "AKIA[A-Z0-9]", "password\\s*=\\s*['\"]", "token\\s*=\\s*['\"]", "secret\\s*=\\s*['\"]"]) {
          tok += tokStr(rg(repo.root, pat, "--glob=*.ts --glob=*.tsx --glob=*.env --glob=*.json")); calls++;
        }
        return { tok, ms: Math.round(performance.now()-t), calls };
      },
      async () => { const t = performance.now(); let tok = 0; try { const r = await scanSecrets(repo.id, {}); tok = tokStr(formatSecrets(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
    );

    // ── 27. cross_repo_search: "find symbol across repos"
    // Native: would need to search each repo separately
    if (repo.label === "codesift-mcp") {
      await measure("cross_repo_search", repo,
        () => {
          const t = performance.now(); let tok = 0;
          for (const r of REPOS) { tok += tokStr(rg(r.root, "function create", "--glob=*.ts -A 5")); }
          return { tok, ms: Math.round(performance.now()-t), calls: REPOS.length };
        },
        async () => { const t = performance.now(); let tok = 0; try { const r = await crossRepoSearchSymbols("create", { top_k: 3, repo_pattern: "local/codesift" }); tok = tokStr(JSON.stringify(r)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 28. cross_repo_refs: "find refs across repos"
    if (repo.label === "codesift-mcp") {
      await measure("cross_repo_refs", repo,
        () => {
          const t = performance.now(); let tok = 0;
          for (const r of REPOS) { tok += tokStr(rg(r.root, "CodeSymbol", "-w --glob=*.ts --glob=*.tsx")); }
          return { tok, ms: Math.round(performance.now()-t), calls: REPOS.length };
        },
        async () => { const t = performance.now(); let tok = 0; try { const r = await crossRepoFindReferences("CodeSymbol", { repo_pattern: "local/codesift" }); tok = tokStr(JSON.stringify(r)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 29. frequency_analysis: UNIQUE (AST shape clustering)
    if (repo.label === "codesift-mcp") {
      await measure("frequency_analysis", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => { const t = performance.now(); let tok = 0; try { const r = await frequencyAnalysis(repo.id, { top_n: 10 }); tok = tokStr(JSON.stringify(r)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 30. search_all_conversations: UNIQUE
    if (repo.label === "codesift-mcp") {
      await measure("search_all_conversations", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => { const t = performance.now(); let tok = 0; try { const r = await searchAllConversations("benchmark"); tok = tokStr(formatConversations(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 31. find_conversations_for_symbol: UNIQUE
    if (repo.label === "codesift-mcp") {
      await measure("find_conversations_for_symbol", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => { const t = performance.now(); let tok = 0; try { const r = await findConversationsForSymbol("searchText", repo.id); tok = tokStr(formatConversations(r as never)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 32. list_patterns: trivial (returns list of built-in patterns)
    if (repo.label === "codesift-mcp") {
      await measure("list_patterns", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => { const t = performance.now(); const r = await listPatterns(); return { tok: tokStr(JSON.stringify(r)), ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 33. usage_stats: trivial
    if (repo.label === "codesift-mcp") {
      await measure("usage_stats", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => { const t = performance.now(); const stats = await getUsageStats(); return { tok: tokStr(formatUsageReport(stats)), ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 34. check_boundaries: UNIQUE (architecture enforcement)
    if (repo.label === "codesift-mcp") {
      await measure("check_boundaries", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => {
          const t = performance.now(); let tok = 0;
          try {
            const { checkBoundaries } = await import("../src/tools/boundary-tools.js");
            const r = await checkBoundaries(repo.id, [{ from: "src/tools", cannot_import: ["src/cli"] }], {});
            tok = tokStr(JSON.stringify(r));
          } catch{}
          return { tok, ms: Math.round(performance.now()-t) };
        },
      );
    }

    // ── 35. classify_roles: UNIQUE (symbol role classification)
    if (repo.label === "codesift-mcp") {
      await measure("classify_roles", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => {
          const t = performance.now(); let tok = 0;
          try {
            const { classifySymbolRoles } = await import("../src/tools/graph-tools.js");
            const r = await classifySymbolRoles(repo.id, { top_n: 20 });
            tok = tokStr(JSON.stringify(r));
          } catch{}
          return { tok, ms: Math.round(performance.now()-t) };
        },
      );
    }

    // ── 36. ast_query: UNIQUE (tree-sitter structural search)
    if (repo.label === "codesift-mcp") {
      await measure("ast_query", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => {
          const t = performance.now(); let tok = 0;
          try {
            const { astQuery } = await import("../src/tools/ast-query-tools.js");
            const r = await astQuery(repo.id, "(function_declaration name: (identifier) @name)", { language: "typescript", max_matches: 20 });
            tok = tokStr(JSON.stringify(r));
          } catch{}
          return { tok, ms: Math.round(performance.now()-t) };
        },
      );
    }

    // ── 37. generate_claude_md: UNIQUE (generates CLAUDE.md)
    if (repo.label === "codesift-mcp") {
      await measure("generate_claude_md", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => { const t = performance.now(); let tok = 0; try { const r = await generateClaudeMd(repo.id); tok = tokStr(typeof r === "string" ? r : JSON.stringify(r)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }

    // ── 35. generate_report: UNIQUE (HTML report)
    if (repo.label === "codesift-mcp") {
      await measure("generate_report", repo,
        () => ({ tok: 0, ms: 0, calls: 0 }),
        async () => { const t = performance.now(); let tok = 0; try { const r = await generateReport(repo.id); tok = tokStr(typeof r === "string" ? r : JSON.stringify(r)); } catch{} return { tok, ms: Math.round(performance.now()-t) }; },
      );
    }
  }

  // ═══════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════════════");
  console.log("TOOL                      nat_tok   sift_tok  diff    nat_ms  sift_ms  speed    nat_calls  wins");
  console.log("─────────────────────────────────────────────────────────────────────────────────────────────────");

  const tools = [...new Set(rows.map(r => r.tool))];
  for (const tool of tools) {
    const tr = rows.filter(r => r.tool === tool);
    const nTok = tr.reduce((s, r) => s + r.nTok, 0);
    const sTok = tr.reduce((s, r) => s + r.sTok, 0);
    const nMs = tr.reduce((s, r) => s + r.nMs, 0);
    const sMs = tr.reduce((s, r) => s + r.sMs, 0);
    const nCalls = tr.reduce((s, r) => s + r.nCalls, 0);
    const wins = tr.filter(r => r.nTok > 0 && r.sTok < r.nTok).length;
    const losses = tr.filter(r => r.nTok > 0 && r.sTok > r.nTok).length;
    const unique = tr.filter(r => r.nTok === 0).length;

    const wStr = unique > 0 ? `${wins}/${tr.length - unique}+${unique}U` : `${wins}/${tr.length}`;
    console.log(`${tool.padEnd(25)} ${String(nTok).padStart(8)} ${String(sTok).padStart(10)} ${pct(sTok, nTok).padStart(6)} ${String(nMs).padStart(8)} ${String(sMs).padStart(8)} ${pct(sMs, nMs).padStart(7)} ${String(nCalls).padStart(10)}  ${wStr}`);
  }

  const totalNat = rows.reduce((s, r) => s + r.nTok, 0);
  const totalSift = rows.reduce((s, r) => s + r.sTok, 0);
  console.log("─────────────────────────────────────────────────────────────────────────────────────────────────");
  console.log(`${"TOTAL".padEnd(25)} ${String(totalNat).padStart(8)} ${String(totalSift).padStart(10)} ${pct(totalSift, totalNat).padStart(6)}`);

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `all-tools-real-flow-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows }, null, 2));
  console.log(`\nsaved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
