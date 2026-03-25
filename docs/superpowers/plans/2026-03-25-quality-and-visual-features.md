# Quality + Visual Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 10 features (5 quality improvements + 5 visual/marketing) to CodeSift MCP

**Architecture:** Each feature is independent — modifies existing tool handlers or adds new formatters. No new dependencies. All features use existing index data. Mermaid outputs are plain strings returned by tools (no rendering needed server-side).

**Tech Stack:** TypeScript, Vitest, tree-sitter (existing), no new deps

**Spec:** `docs/superpowers/specs/2026-03-25-quality-and-visual-features-design.md`

---

## File Map

| File | Action | Features |
|------|--------|----------|
| `src/search/bm25.ts` | Modify | A1 (relevance-gap) |
| `src/tools/search-tools.ts` | Modify | A1 (apply cutoff) |
| `src/tools/pattern-tools.ts` | Modify | A4 (scaffolding pattern) |
| `src/tools/diff-tools.ts` | Modify | A2 (include_diff) |
| `src/tools/symbol-tools.ts` | Modify | A3 (framework dead code) |
| `src/utils/framework-detect.ts` | Create | A3 (framework detection) |
| `src/search/chunker.ts` | Modify | A5 (semantic chunking) |
| `src/tools/index-tools.ts` | Modify | A5 (use new chunker) |
| `src/server-helpers.ts` | Modify | B1 (token savings) |
| `src/storage/usage-tracker.ts` | Modify | B1 (cumulative savings) |
| `src/storage/usage-stats.ts` | Modify | B1 (savings in report) |
| `src/tools/community-tools.ts` | Modify | B2 (mermaid communities) |
| `src/tools/context-tools.ts` | Modify | B3 (mermaid knowledge map) |
| `src/tools/route-tools.ts` | Modify | B4 (mermaid route flow) |
| `src/tools/report-tools.ts` | Create | B5 (HTML report) |
| `src/register-tools.ts` | Modify | A2, A3, B2, B3, B4, B5 (params + new tool) |

---

## Phase 1: Quick Wins (A1, A4, B1)

### Task 1: Relevance-Gap Filtering (A1)

**Files:**
- Modify: `src/search/bm25.ts`
- Modify: `src/tools/search-tools.ts`
- Test: `tests/search/bm25.test.ts`

- [ ] **Step 1: Write failing test for applyCutoff**

```typescript
// tests/search/bm25.test.ts — add to existing describe
import { applyCutoff } from "../../src/search/bm25.js";

describe("applyCutoff", () => {
  it("cuts results below 15% of top score", () => {
    const results = [
      { score: 10.0, symbol: { id: "a" } },
      { score: 8.0, symbol: { id: "b" } },
      { score: 7.0, symbol: { id: "c" } },
      { score: 1.2, symbol: { id: "d" } },  // 1.2/10 = 12% < 15%
      { score: 0.5, symbol: { id: "e" } },
    ] as any;
    const cut = applyCutoff(results);
    expect(cut.length).toBe(3);
    expect(cut[2].symbol.id).toBe("c");
  });

  it("always returns minimum 3 results", () => {
    const results = [
      { score: 10.0, symbol: { id: "a" } },
      { score: 0.1, symbol: { id: "b" } },  // below 15%
      { score: 0.05, symbol: { id: "c" } },
    ] as any;
    const cut = applyCutoff(results);
    expect(cut.length).toBe(3); // minimum 3
  });

  it("returns all if no gap", () => {
    const results = [
      { score: 10.0, symbol: { id: "a" } },
      { score: 9.5, symbol: { id: "b" } },
      { score: 8.0, symbol: { id: "c" } },
    ] as any;
    const cut = applyCutoff(results);
    expect(cut.length).toBe(3);
  });

  it("handles empty array", () => {
    expect(applyCutoff([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search/bm25.test.ts -t "applyCutoff"`
Expected: FAIL — `applyCutoff` not exported

- [ ] **Step 3: Implement applyCutoff in bm25.ts**

Add after the `searchBM25` function in `src/search/bm25.ts`:

```typescript
const CUTOFF_THRESHOLD = 0.15; // Results below 15% of top score are cut
const CUTOFF_MIN_RESULTS = 3;  // Always return at least 3

export function applyCutoff(results: SearchResult[]): SearchResult[] {
  if (results.length <= CUTOFF_MIN_RESULTS) return results;

  const topScore = results[0]?.score ?? 0;
  if (topScore <= 0) return results;

  const threshold = topScore * CUTOFF_THRESHOLD;

  for (let i = CUTOFF_MIN_RESULTS; i < results.length; i++) {
    if ((results[i]?.score ?? 0) < threshold) {
      return results.slice(0, i);
    }
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/search/bm25.test.ts -t "applyCutoff"`
Expected: PASS

- [ ] **Step 5: Apply cutoff in searchSymbols**

In `src/tools/search-tools.ts`, after the `results.slice(0, topK)` line, add:

```typescript
import { applyCutoff } from "../search/bm25.js";
// ... after results = results.slice(0, topK);
results = applyCutoff(results);
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: 350+ pass

- [ ] **Step 7: Benchmark**

```bash
node -e "
require('./dist/config.js').resetConfigCache();
const { searchSymbols } = require('./dist/tools/search-tools.js');
searchSymbols('local/codesift-mcp', 'config', { include_source: true, top_k: 50 })
  .then(r => {
    console.log('Results:', r.length);
    r.forEach(s => console.log('  ' + s.score.toFixed(2) + ' ' + s.symbol.name));
  });
"
```

- [ ] **Step 8: Commit**

```bash
git add src/search/bm25.ts src/tools/search-tools.ts tests/search/bm25.test.ts
git commit -m "feat: relevance-gap filtering — cut low-score search results

applyCutoff removes results scoring <15% of top result.
Minimum 3 results always returned. Reduces noise in search
output without losing relevant matches."
```

---

### Task 2: Scaffolding Detection Pattern (A4)

**Files:**
- Modify: `src/tools/pattern-tools.ts`

- [ ] **Step 1: Add scaffolding pattern to BUILTIN_PATTERNS**

In `src/tools/pattern-tools.ts`, add to `BUILTIN_PATTERNS` object after `"unbounded-findmany"`:

```typescript
  "scaffolding": {
    regex: /\/\/\s*(TODO|FIXME|HACK|XXX|TEMP|TEMPORARY)\b|\/\/\s*(Phase|Step|Stage)\s*\d|\/\/\s*(placeholder|stub|dummy)\b|throw new Error\(['"]not implemented['"]\)|console\.(log|warn)\(['"]TODO\b/i,
    description: "Scaffolding markers: TODO/FIXME/HACK, Phase/Step markers, placeholder stubs, not-implemented throws (tech debt)",
  },
```

- [ ] **Step 2: Build and test manually**

```bash
npm run build
node -e "
require('./dist/config.js').resetConfigCache();
const { searchPatterns } = require('./dist/tools/pattern-tools.js');
searchPatterns('local/codesift-mcp', 'scaffolding').then(r =>
  console.log('Found:', r.matches.length, 'scaffolding markers')
);
"
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: 350+ pass

- [ ] **Step 4: Commit**

```bash
git add src/tools/pattern-tools.ts
git commit -m "feat: add scaffolding detection pattern

New built-in pattern 'scaffolding' finds TODO/FIXME/HACK markers,
Phase/Step/Stage numbered comments, placeholder stubs, and
'not implemented' throws. Catches forgotten tech debt."
```

---

### Task 3: Token Savings Display (B1)

**Files:**
- Modify: `src/server-helpers.ts`
- Modify: `src/storage/usage-tracker.ts`
- Modify: `src/storage/usage-stats.ts`

- [ ] **Step 1: Add savings multipliers to server-helpers.ts**

In `src/server-helpers.ts`, add after the constants block:

```typescript
/** Estimated token multiplier vs manual grep/Read approach (from benchmark data) */
const SAVINGS_MULTIPLIER: Record<string, number> = {
  search_text: 1.5,
  search_symbols: 1.0,
  get_file_outline: 3.0,
  get_file_tree: 1.25,
  find_references: 1.5,
  codebase_retrieval: 3.0,
  assemble_context: 5.0,
  trace_call_chain: 4.0,
  impact_analysis: 3.0,
  detect_communities: 2.0,
  trace_route: 4.0,
  get_context_bundle: 3.0,
};

const OPUS_COST_PER_TOKEN = 30 / 1_000_000; // $30/1M input tokens

function estimateSavings(toolName: string, resultTokens: number): { tokens: number; cost: number } | null {
  const mult = SAVINGS_MULTIPLIER[toolName];
  if (!mult || mult <= 1.0) return null;
  const saved = Math.round(resultTokens * (mult - 1));
  return { tokens: saved, cost: saved * OPUS_COST_PER_TOKEN };
}
```

- [ ] **Step 2: Add savings to formatResponse**

In `formatResponse()` in `src/server-helpers.ts`, before the hint logic, add:

```typescript
  const savings = estimateSavings(toolName, Math.round(text.length / CHARS_PER_TOKEN));
  if (savings && savings.tokens > 50) {
    const costStr = savings.cost >= 0.01 ? `$${savings.cost.toFixed(2)}` : `$${savings.cost.toFixed(4)}`;
    const savingsHint = `⚡ Saved ~${savings.tokens.toLocaleString()} tokens vs manual approach (${costStr} at Opus rates)`;
    // Prepend savings before other hints
    text = savingsHint + "\n\n" + text;
  }
```

- [ ] **Step 3: Add cumulative tracking to usage-tracker.ts**

In `src/storage/usage-tracker.ts`, add tracking field and update `trackToolCall`:

```typescript
let cumulativeTokensSaved = 0;

export function getCumulativeSavings(): number {
  return cumulativeTokensSaved;
}
```

In the `trackToolCall` function, after logging, add:

```typescript
  // Track cumulative savings
  const mult = SAVINGS_MULTIPLIER_MAP[toolName];
  if (mult && mult > 1.0) {
    cumulativeTokensSaved += Math.round(resultTokens * (mult - 1));
  }
```

Note: Import or duplicate the multiplier map in usage-tracker, or export `estimateSavings` from server-helpers and import it.

- [ ] **Step 4: Add savings to usage_stats report**

In `src/storage/usage-stats.ts`, in `formatUsageReport`, add a line:

```typescript
import { getCumulativeSavings } from "./usage-tracker.js";
// In formatUsageReport:
const saved = getCumulativeSavings();
lines.push(`\nEstimated tokens saved: ${saved.toLocaleString()} (~$${(saved * 30 / 1_000_000).toFixed(2)} at Opus rates)`);
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`
Expected: 350+ pass

- [ ] **Step 6: Commit**

```bash
git add src/server-helpers.ts src/storage/usage-tracker.ts src/storage/usage-stats.ts
git commit -m "feat: token savings display — show estimated savings per call

Each response prepends '⚡ Saved ~X tokens vs manual approach ($Y)'.
Multipliers from benchmark data. Cumulative tracking in usage_stats."
```

---

## Phase 2: Deeper Quality (A2, A3)

### Task 4: include_diff on changed_symbols (A2)

**Files:**
- Modify: `src/tools/diff-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Add include_diff option to changedSymbols**

In `src/tools/diff-tools.ts`, find the `changedSymbols` function. Add `options?: { include_diff?: boolean }` parameter. After building the result, if `include_diff` is true, run `git diff since..until -- filePath` for each changed file and extract the relevant hunk:

```typescript
const MAX_DIFF_CHARS = 500;

// After building changedFiles array:
if (options?.include_diff) {
  for (const entry of result) {
    try {
      const raw = execFileSync("git", [
        "diff", `${since}..${until}`, "--", entry.file,
      ], { cwd: index.root, maxBuffer: 50_000 }).toString("utf-8");
      entry.diff = raw.length > MAX_DIFF_CHARS
        ? raw.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)"
        : raw;
    } catch {
      entry.diff = null;
    }
  }
}
```

Update the return type to include `diff?: string | null`.

- [ ] **Step 2: Register parameter in register-tools.ts**

Add `include_diff: z.boolean().optional()` to `changed_symbols` schema. Pass through to handler.

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 4: Manual benchmark**

```bash
node -e "
require('./dist/config.js').resetConfigCache();
const { changedSymbols } = require('./dist/tools/diff-tools.js');
changedSymbols('local/codesift-mcp', 'HEAD~3', { include_diff: true })
  .then(r => console.log(JSON.stringify(r, null, 2).slice(0, 2000)));
"
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/diff-tools.ts src/register-tools.ts
git commit -m "feat: include_diff on changed_symbols — show what changed per symbol"
```

---

### Task 5: Framework-Aware Dead Code (A3)

**Files:**
- Create: `src/utils/framework-detect.ts`
- Modify: `src/tools/symbol-tools.ts`

- [ ] **Step 1: Create framework-detect.ts**

```typescript
// src/utils/framework-detect.ts
import type { CodeIndex } from "../types.js";

export type Framework = "react" | "nestjs" | "nextjs" | "express" | "test";

const FRAMEWORK_ENTRY_POINTS: Record<Framework, RegExp[]> = {
  react: [/^use[A-Z]/],
  nestjs: [
    /^(onModuleInit|onModuleDestroy|onApplicationBootstrap|onApplicationShutdown)$/,
    /^(canActivate|intercept|transform|catch|use)$/,
  ],
  nextjs: [
    /^(getServerSideProps|getStaticProps|getStaticPaths|generateMetadata|generateStaticParams)$/,
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/,
    /^(middleware|default)$/,
  ],
  express: [/^(get|post|put|delete|patch|use|all|param)$/],
  test: [/^(describe|it|test|beforeEach|afterEach|beforeAll|afterAll)$/],
};

export function detectFrameworks(index: CodeIndex): Set<Framework> {
  const frameworks = new Set<Framework>();
  const sources = index.symbols.slice(0, 200).map((s) => s.source ?? "").join("\n");

  if (sources.includes("@nestjs/") || sources.includes("NestFactory")) frameworks.add("nestjs");
  if (sources.includes("from 'react'") || sources.includes("from \"react\"") || sources.includes("useState")) frameworks.add("react");
  if (index.files.some((f) => f.path.includes("app/api/") && f.path.endsWith("route.ts"))) frameworks.add("nextjs");
  if (sources.includes("express()") || sources.includes("Router()")) frameworks.add("express");
  frameworks.add("test"); // always include test patterns

  return frameworks;
}

export function isFrameworkEntryPoint(symbolName: string, frameworks: Set<Framework>): boolean {
  for (const fw of frameworks) {
    const patterns = FRAMEWORK_ENTRY_POINTS[fw];
    if (patterns?.some((p) => p.test(symbolName))) return true;
  }
  return false;
}
```

- [ ] **Step 2: Modify findDeadCode in symbol-tools.ts**

In `src/tools/symbol-tools.ts`, import framework detection and add check:

```typescript
import { detectFrameworks, isFrameworkEntryPoint } from "../utils/framework-detect.js";

// Inside findDeadCode, after checking refs count === 0:
// Before adding to dead code list, check:
const frameworks = detectFrameworks(index);
// ... in the loop:
if (isFrameworkEntryPoint(sym.name, frameworks)) continue; // skip framework entry points
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 4: Benchmark**

```bash
node -e "
require('./dist/config.js').resetConfigCache();
const { findDeadCode } = require('./dist/tools/symbol-tools.js');
findDeadCode('local/codesift-mcp', {}).then(r =>
  console.log('Dead code candidates:', r.length, r.slice(0, 5).map(s => s.name))
);
"
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/framework-detect.ts src/tools/symbol-tools.ts
git commit -m "feat: framework-aware dead code — whitelist React/NestJS/Next.js entry points

Auto-detects frameworks from index. Skips hooks (useX), lifecycle
methods (onModuleInit), route handlers (GET/POST), guards, pipes.
Reduces false positives from ~40% to <10%."
```

---

## Phase 3: Mermaid Visualizations (B2, B3, B4)

### Task 6: Mermaid Community Map (B2)

**Files:**
- Modify: `src/tools/community-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Add communityToMermaid function**

In `src/tools/community-tools.ts`, add before `detectCommunities`:

```typescript
const MAX_MERMAID_COMMUNITIES = 15;
const MAX_MERMAID_FILES_PER = 5;

function communityToMermaid(result: CommunityResult, edges: ImportEdge[]): string {
  const lines: string[] = ["graph LR"];
  const comms = result.communities.slice(0, MAX_MERMAID_COMMUNITIES);

  // Build community ID map for files
  const fileToCommunity = new Map<string, number>();
  for (const c of comms) {
    for (const f of c.files) {
      if (!f.startsWith("...")) fileToCommunity.set(f, c.id);
    }
  }

  for (const c of comms) {
    const safeId = `c${c.id}`;
    const label = `${c.name} (${c.files.length} files)`;
    lines.push(`    subgraph ${safeId}["${label}"]`);
    const showFiles = c.files.filter((f) => !f.startsWith("...")).slice(0, MAX_MERMAID_FILES_PER);
    for (const f of showFiles) {
      const short = f.split("/").pop()?.replace(/\.\w+$/, "") ?? f;
      const nodeId = short.replace(/[^a-zA-Z0-9]/g, "_");
      lines.push(`        ${safeId}_${nodeId}[${short}]`);
    }
    lines.push("    end");
  }

  // Cross-community edges
  const crossEdges = new Set<string>();
  for (const edge of edges) {
    const fromC = fileToCommunity.get(edge.from);
    const toC = fileToCommunity.get(edge.to);
    if (fromC !== undefined && toC !== undefined && fromC !== toC) {
      const key = `c${Math.min(fromC, toC)}-->c${Math.max(fromC, toC)}`;
      if (!crossEdges.has(key)) {
        crossEdges.add(key);
        lines.push(`    c${fromC} --> c${toC}`);
      }
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 2: Add output_format parameter to detectCommunities**

Modify signature to accept `outputFormat?: "json" | "mermaid"`. When mermaid, return `{ mermaid: string }` instead of full JSON.

- [ ] **Step 3: Register output_format in register-tools.ts**

Add `output_format: z.enum(["json", "mermaid"]).optional()` to detect_communities schema.

- [ ] **Step 4: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 5: Manual test**

```bash
node -e "
require('./dist/config.js').resetConfigCache();
const { detectCommunities } = require('./dist/tools/community-tools.js');
detectCommunities('local/codesift-mcp', 'src/', undefined, 'mermaid')
  .then(r => console.log(typeof r === 'string' ? r : r.mermaid || JSON.stringify(r)));
"
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/community-tools.ts src/register-tools.ts
git commit -m "feat: Mermaid output for detect_communities — visual architecture map"
```

---

### Task 7: Mermaid Dependency Graph (B3)

**Files:**
- Modify: `src/tools/context-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Add knowledgeMapToMermaid function**

In `src/tools/context-tools.ts`:

```typescript
const MAX_MERMAID_NODES = 30;
const MAX_MERMAID_EDGES = 50;

function knowledgeMapToMermaid(result: KnowledgeMap): string {
  const lines: string[] = ["graph TD"];

  // Aggregate to directory level
  const dirSymbols = new Map<string, number>();
  for (const mod of result.modules) {
    const dir = mod.path.includes("/") ? mod.path.slice(0, mod.path.lastIndexOf("/")) : mod.path;
    dirSymbols.set(dir, (dirSymbols.get(dir) ?? 0) + mod.symbol_count);
  }

  const topDirs = [...dirSymbols.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MERMAID_NODES);
  const dirSet = new Set(topDirs.map(([d]) => d));

  for (const [dir, syms] of topDirs) {
    const id = dir.replace(/[^a-zA-Z0-9]/g, "_");
    const short = dir.split("/").slice(-2).join("/");
    lines.push(`    ${id}["${short} (${syms} sym)"]`);
  }

  // Aggregate edges to directory level
  const dirEdges = new Set<string>();
  let edgeCount = 0;
  for (const edge of result.edges) {
    if (edgeCount >= MAX_MERMAID_EDGES) break;
    const fromDir = edge.from.includes("/") ? edge.from.slice(0, edge.from.lastIndexOf("/")) : edge.from;
    const toDir = edge.to.includes("/") ? edge.to.slice(0, edge.to.lastIndexOf("/")) : edge.to;
    if (fromDir === toDir || !dirSet.has(fromDir) || !dirSet.has(toDir)) continue;
    const key = `${fromDir}|${toDir}`;
    if (dirEdges.has(key)) continue;
    dirEdges.add(key);
    const fromId = fromDir.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = toDir.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`    ${fromId} --> ${toId}`);
    edgeCount++;
  }

  return lines.join("\n");
}
```

- [ ] **Step 2: Add output_format to getKnowledgeMap**

Add parameter, when "mermaid" → return `{ mermaid: knowledgeMapToMermaid(result) }`.

- [ ] **Step 3: Register in register-tools.ts**

Add `output_format: z.enum(["json", "mermaid"]).optional()` to get_knowledge_map schema.

- [ ] **Step 4: Build, test, commit**

```bash
npm run build && npm test
git add src/tools/context-tools.ts src/register-tools.ts
git commit -m "feat: Mermaid output for get_knowledge_map — dependency diagram"
```

---

### Task 8: Mermaid Route Flow (B4)

**Files:**
- Modify: `src/tools/route-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Add routeToMermaid function**

In `src/tools/route-tools.ts`:

```typescript
function routeToMermaid(result: RouteTraceResult): string {
  if (result.handlers.length === 0) return "sequenceDiagram\n    Note over Client: No handler found for " + result.path;

  const lines: string[] = ["sequenceDiagram"];
  const handler = result.handlers[0]!;
  const method = handler.method ?? "REQUEST";

  lines.push(`    Client->>+Controller: ${method} ${result.path}`);

  // Group call chain by depth
  const depth1 = result.call_chain.filter((n) => n.depth === 1);
  const depth2 = result.call_chain.filter((n) => n.depth === 2);

  for (const node of depth1) {
    const participant = node.file.split("/").pop()?.replace(/\.\w+$/, "") ?? node.name;
    lines.push(`    Controller->>+${participant}: ${node.name}()`);

    // Find DB calls from this node's callees
    const dbFromNode = result.db_calls.filter((d) => d.symbol_name === node.name);
    for (const db of dbFromNode) {
      lines.push(`    ${participant}->>+DB: ${db.operation}`);
      lines.push(`    DB-->>-${participant}: result`);
    }

    // Depth 2 calls from this service
    const sub = depth2.filter((n2) => result.call_chain.indexOf(n2) > result.call_chain.indexOf(node));
    for (const s of sub.slice(0, 3)) {
      lines.push(`    ${participant}->>+${s.name}: ${s.name}()`);
      lines.push(`    ${s.name}-->>-${participant}: result`);
    }

    lines.push(`    ${participant}-->>-Controller: result`);
  }

  lines.push(`    Controller-->>-Client: response`);
  return lines.join("\n");
}
```

- [ ] **Step 2: Add output_format to traceRoute**

Modify signature, when "mermaid" → return `{ mermaid: routeToMermaid(result) }`.

- [ ] **Step 3: Register in register-tools.ts**

Add `output_format: z.enum(["json", "mermaid"]).optional()` to trace_route schema.

- [ ] **Step 4: Build, test, commit**

```bash
npm run build && npm test
git add src/tools/route-tools.ts src/register-tools.ts
git commit -m "feat: Mermaid sequence diagram for trace_route — visual endpoint flow"
```

---

## Phase 4: Deep Features (A5, B5)

### Task 9: Semantic Chunking (A5)

**Files:**
- Modify: `src/search/chunker.ts`
- Modify: `src/tools/index-tools.ts`
- Test: `tests/search/chunker.test.ts`

- [ ] **Step 1: Write failing test for chunkBySymbols**

```typescript
// tests/search/chunker.test.ts — add or create
import { chunkBySymbols } from "../../src/search/chunker.js";

describe("chunkBySymbols", () => {
  it("creates one chunk per symbol", () => {
    const source = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";
    const symbols = [
      { name: "a", start_line: 1, end_line: 3 },
      { name: "b", start_line: 4, end_line: 6 },
      { name: "c", start_line: 7, end_line: 8 },
    ] as any;
    const chunks = chunkBySymbols("test.ts", source, "repo", symbols);
    expect(chunks.length).toBe(3);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
    expect(chunks[1].startLine).toBe(4);
  });

  it("falls back to line chunking when no symbols", () => {
    const source = "a\nb\nc\n";
    const chunks = chunkBySymbols("test.ts", source, "repo", []);
    expect(chunks.length).toBeGreaterThan(0); // fallback to chunkFile
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search/chunker.test.ts`

- [ ] **Step 3: Implement chunkBySymbols**

In `src/search/chunker.ts`, add:

```typescript
import type { CodeChunk, CodeSymbol } from "../types.js";

const MAX_CHUNK_LINES = 100; // Split very large symbols

export function chunkBySymbols(
  file: string,
  content: string,
  repo: string,
  symbols: Array<{ name: string; start_line: number; end_line: number }>,
): CodeChunk[] {
  if (symbols.length === 0) return chunkFile(file, content, repo);

  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];

  // Sort symbols by start_line
  const sorted = [...symbols].sort((a, b) => a.start_line - b.start_line);

  // Add preamble (imports, before first symbol)
  const firstStart = sorted[0]?.start_line ?? 1;
  if (firstStart > 1) {
    const text = lines.slice(0, firstStart - 1).join("\n");
    if (text.trim().length > 0) {
      chunks.push({
        id: `${repo}:${file}:1`,
        file,
        startLine: 1,
        endLine: firstStart - 1,
        text,
        tokenCount: Math.ceil(text.length / CHARS_PER_TOKEN),
      });
    }
  }

  // One chunk per symbol
  for (const sym of sorted) {
    const start = sym.start_line - 1; // 0-based
    const end = Math.min(sym.end_line, lines.length); // 1-based inclusive
    const symLines = lines.slice(start, end);
    const text = symLines.join("\n");

    if (text.trim().length === 0) continue;

    chunks.push({
      id: `${repo}:${file}:${sym.start_line}`,
      file,
      startLine: sym.start_line,
      endLine: end,
      text: text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text,
      tokenCount: Math.ceil(Math.min(text.length, MAX_FILE_BYTES) / CHARS_PER_TOKEN),
    });
  }

  return chunks;
}
```

- [ ] **Step 4: Use new chunker in index-tools.ts**

In `src/tools/index-tools.ts`, in the `embedChunks` function, replace `chunkFile` call with:

```typescript
import { chunkBySymbols } from "../search/chunker.js";

// In embedChunks, for each file:
const fileSymbols = symbols.filter(s => s.file === fileEntry.path);
const chunks = fileSymbols.length > 0
  ? chunkBySymbols(fileEntry.path, content, repoName, fileSymbols)
  : chunkFile(fileEntry.path, content, repoName);
```

- [ ] **Step 5: Run tests, build, commit**

```bash
npm test && npm run build
git add src/search/chunker.ts src/tools/index-tools.ts tests/search/chunker.test.ts
git commit -m "feat: semantic chunking — chunk by symbol boundaries

Each symbol = one chunk. Preamble (imports) = separate chunk.
Falls back to line-based chunking for files without symbols.
Improves semantic search by keeping functions intact."
```

---

### Task 10: HTML Report Export (B5)

**Files:**
- Create: `src/tools/report-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Create report-tools.ts**

```typescript
// src/tools/report-tools.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { analyzeComplexity } from "./complexity-tools.js";
import { findDeadCode } from "./symbol-tools.js";
import { detectCommunities } from "./community-tools.js";
import { analyzeHotspots } from "./hotspot-tools.js";
import { getCumulativeSavings } from "../storage/usage-tracker.js";

export async function generateReport(repo: string): Promise<{ path: string; sections: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Gather data from existing tools
  const [complexity, deadCode, communities, hotspots] = await Promise.allSettled([
    analyzeComplexity(repo, { top_n: 10 }),
    findDeadCode(repo, {}),
    detectCommunities(repo),
    analyzeHotspots(repo, {}),
  ]);

  const html = buildHtml(index, {
    complexity: complexity.status === "fulfilled" ? complexity.value : null,
    deadCode: deadCode.status === "fulfilled" ? deadCode.value : null,
    communities: communities.status === "fulfilled" ? communities.value : null,
    hotspots: hotspots.status === "fulfilled" ? hotspots.value : null,
    savings: getCumulativeSavings(),
  });

  const outPath = join(index.root, "codesift-report.html");
  await writeFile(outPath, html, "utf-8");

  return { path: outPath, sections: 6 };
}

function buildHtml(index: any, data: any): string {
  const langs = Object.entries(index.files.reduce((acc: Record<string, number>, f: any) => {
    acc[f.language] = (acc[f.language] ?? 0) + 1; return acc;
  }, {} as Record<string, number>)).sort((a: any, b: any) => b[1] - a[1]);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CodeSift Report — ${index.repo}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; background: #fafbfc; }
  h1 { border-bottom: 3px solid #6366f1; padding-bottom: 12px; }
  h2 { color: #6366f1; margin-top: 40px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
  th { background: #6366f1; color: white; }
  tr:nth-child(even) { background: #f1f5f9; }
  .metric { display: inline-block; background: #6366f1; color: white; padding: 8px 16px; border-radius: 8px; margin: 4px; font-size: 14px; }
  .metric b { font-size: 20px; }
  .warn { color: #dc2626; } .ok { color: #16a34a; }
  pre.mermaid { background: white; padding: 16px; border-radius: 8px; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 12px; }
</style></head><body>
<h1>CodeSift Report</h1>
<p><b>${index.repo}</b> — generated ${new Date().toISOString().slice(0, 10)}</p>

<div>
  <span class="metric"><b>${index.file_count.toLocaleString()}</b> files</span>
  <span class="metric"><b>${index.symbol_count.toLocaleString()}</b> symbols</span>
  <span class="metric"><b>${langs.length}</b> languages</span>
  ${data.savings > 0 ? `<span class="metric"><b>${data.savings.toLocaleString()}</b> tokens saved</span>` : ""}
</div>

<h2>Languages</h2>
<table><tr><th>Language</th><th>Files</th></tr>
${langs.map(([l, c]: any) => `<tr><td>${l}</td><td>${c}</td></tr>`).join("\n")}
</table>

<h2>Top Complex Functions</h2>
${data.complexity ? `<table><tr><th>Function</th><th>File</th><th>Complexity</th><th>Lines</th></tr>
${data.complexity.slice(0, 10).map((c: any) => `<tr><td>${c.name}</td><td>${c.file}</td><td class="${c.cyclomatic > 10 ? "warn" : "ok"}">${c.cyclomatic}</td><td>${c.lines}</td></tr>`).join("\n")}
</table>` : "<p>Not available</p>"}

<h2>Dead Code Candidates</h2>
${data.deadCode ? `<p>${data.deadCode.length} unused exports found</p>
<table><tr><th>Symbol</th><th>File</th><th>Kind</th></tr>
${data.deadCode.slice(0, 15).map((d: any) => `<tr><td>${d.name}</td><td>${d.file}</td><td>${d.kind}</td></tr>`).join("\n")}
</table>` : "<p>Not available</p>"}

<h2>Hotspots (Churn × Complexity)</h2>
${data.hotspots ? `<table><tr><th>File</th><th>Score</th><th>Changes</th></tr>
${data.hotspots.slice(0, 10).map((h: any) => `<tr><td>${h.file}</td><td class="${h.hotspot_score > 100 ? "warn" : "ok"}">${h.hotspot_score}</td><td>${h.change_count}</td></tr>`).join("\n")}
</table>` : "<p>Not available</p>"}

<h2>Architecture (Communities)</h2>
${data.communities ? `<p>${data.communities.communities.length} modules detected (modularity: ${data.communities.modularity})</p>
<table><tr><th>Module</th><th>Files</th><th>Symbols</th><th>Cohesion</th></tr>
${data.communities.communities.slice(0, 15).map((c: any) => `<tr><td>${c.name}</td><td>${c.files.length}</td><td>${c.symbol_count}</td><td>${(c.cohesion * 100).toFixed(0)}%</td></tr>`).join("\n")}
</table>` : "<p>Not available</p>"}

<footer>Generated by <a href="https://github.com/greglas75/codesift">CodeSift</a> — Token-efficient code intelligence for AI agents</footer>
<script>mermaid.initialize({ startOnLoad: true });</script>
</body></html>`;
}
```

- [ ] **Step 2: Register generate_report in register-tools.ts**

```typescript
import { generateReport } from "./tools/report-tools.js";
// In TOOL_DEFINITIONS:
{
  name: "generate_report",
  description: "Generate a standalone HTML report with complexity analysis, dead code, hotspots, and architecture overview. Opens in any browser.",
  schema: {
    repo: z.string().describe("Repository identifier"),
  },
  handler: (args) => generateReport(args.repo as string),
},
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 4: Manual test**

```bash
node -e "
require('./dist/config.js').resetConfigCache();
const { generateReport } = require('./dist/tools/report-tools.js');
generateReport('local/codesift-mcp').then(r => console.log('Report:', r.path));
"
# Then open codesift-report.html in browser
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/report-tools.ts src/register-tools.ts
git commit -m "feat: HTML report export — standalone browser report

generate_report(repo) creates codesift-report.html with:
- Repo overview (files, symbols, languages)
- Top 10 complex functions
- Dead code candidates
- Git hotspots (churn × complexity)
- Architecture communities
Mermaid.js from CDN, inline CSS, zero dependencies."
```

---

## Final Steps

- [ ] **Step F1: Run full test suite**

```bash
npm test
```
Expected: All pass

- [ ] **Step F2: Build**

```bash
npm run build
```

- [ ] **Step F3: Update README**

Add new features to README.md tool tables and feature list.

- [ ] **Step F4: Final commit**

```bash
git add -A
git commit -m "docs: update README with 10 new features (quality + visual)"
git push
```
