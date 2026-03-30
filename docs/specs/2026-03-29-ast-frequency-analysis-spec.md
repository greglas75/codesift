# AST Frequency Analysis — Design Specification

> **Date:** 2026-03-29
> **Status:** Approved
> **Author:** zuvo:brainstorm

## Problem Statement

CodeSift's quality mining pipeline has two levels today:

- **Level 1 (search_patterns + search_text):** Scan for known anti-patterns via regex. Finds what you already know to look for.
- **Level 2 (perl + sort):** Bottom-up text frequency analysis. Extracts most common text patterns. Finds unknown patterns — but only at the text level.

Both miss **structural patterns** — code that has the same shape but different variable names, literal values, or model names. Example: 47 functions follow the "find-or-throw" pattern (`await db.X.findUnique({ where: { id } }); if (!result) throw new NotFoundException(); return result;`) but regex can't group them because names differ.

**Level 3** normalizes tree-sitter AST nodes (replace identifiers/literals with placeholders), hashes the normalized subtrees, groups by hash, and returns the TOP N most common code structures. This discovers emergent patterns invisible to text mining.

Without this, we don't know what we don't know. The perl approach found 8 new patterns in one session — but admitted it can't find structural similarity. AST clustering fills that gap.

## Design Decisions

### D1: Normalization — re-parse with tree-sitter (not regex)

**Chosen:** Re-parse `symbol.source` with tree-sitter, walk the AST, normalize node values by type.

**Why:** Regex approximation can't distinguish identifiers from keywords inside strings, misses template literals, and doesn't understand AST structure. Tree-sitter already exists in the project (WASM grammars loaded). Re-parsing a 5000-char source snippet takes ~1-5ms. For 5,000 symbols = 5-25s worst case, acceptable for an analysis tool (not a search tool).

**Rejected:** Regex on source text — faster (~50ms total) but approximate. False positives where keywords inside strings get replaced, or template literal interpolations get mangled. Not acceptable when the whole point is precision over text-level mining.

### D2: Granularity — hierarchical (hash all nodes, report per category)

**Chosen:** Hash every AST node during bottom-up traversal. In the output, return TOP 30 clusters overall with `root_node_type` on each cluster so the consumer can filter.

**Why:** Merkle-style bottom-up hashing visits every node anyway — filtering at hash time saves nothing. Collecting all levels and letting the consumer filter is strictly more useful. An agent can ask "show me only function-level patterns" or "show me only catch-clause patterns" from the same data.

**Rejected alternatives:**
- Function-only: misses statement-level patterns (e.g., 89 identical try-catch blocks).
- Hardcoded categories: limits usefulness and requires maintaining a category list per language.

### D3: Clustering — exact hash match only (MVP)

**Chosen:** Group by identical normalized-AST hash. O(n) via `Map<hash, symbols[]>`.

**Why:** The feature asks for frequency ranking ("what shapes are most common"), not near-miss detection ("what shapes are similar"). Exact matching is O(n), deterministic, and produces clean results. DECKARD-style LSH fuzzy clustering is 5x more complex and introduces tuning parameters (epsilon, vector dimensions).

**Rejected:** Fuzzy clustering (DECKARD/LSH). Better suited for bug-finding and near-miss clone detection, which `find_clones` already covers. Can be added as a follow-up (Level 3b).

### D4: Minimum subtree size — 5 nodes

**Chosen:** Skip subtrees with fewer than 5 AST nodes. Default `min_nodes = 5`.

**Why:** Leaf nodes and tiny subtrees (single `return`, single assignment) produce enormous clusters that dominate TOP N with noise. Research consensus (Baxter 1998, DECKARD 2007) recommends 5-10 node minimum. 5 is the lower bound — still catches meaningful 2-3 line patterns while excluding trivial leaves.

### D5: Truncated source handling — exclude

**Chosen:** Symbols where `source` ends with `"..."` (truncated at `MAX_SOURCE_LENGTH = 5000`) are excluded from clustering and counted in `skipped_truncated`.

**Why:** Two different large functions may share the same truncated prefix, producing false positives. Better to skip ~0.1% of symbols than corrupt clusters.

### D6: Shape description — normalized source preview

**Chosen:** `shape_preview` = first 300 characters of the normalized source of the first example in the cluster.

**Why:** Auto-generating a semantic label ("find-or-throw pattern") requires NLP or heuristics that are fragile. The normalized source IS the shape description — an agent or developer can read it directly. 300 chars covers 5-10 lines of normalized code, enough to understand the pattern.

### D7: Output shape — flat clusters with root_node_type

**Chosen:** Return TOP 30 clusters sorted by descending count, each with `root_node_type` field. No hardcoded categories. Agent filters client-side if needed.

**Why:** Simpler API. The agent gets one sorted list. If it wants "only function patterns" it filters by `root_node_type === "function_declaration"`. No need for the tool to guess what categories matter.

## Solution Overview

```
symbol.source  →  tree-sitter re-parse  →  post-order walk
                                              ↓
                                    normalize each node:
                                      identifier → _
                                      string_literal → _S
                                      number_literal → _N
                                      keywords/operators → keep as-is
                                              ↓
                                    hash(node) = hash(node.type + children_hashes)
                                              ↓
                                    Map<hash, { node_type, size, symbols[] }>
                                              ↓
                                    filter: size >= min_nodes
                                              ↓
                                    sort by count desc → TOP 30
                                              ↓
                                    serialize: shape_preview + examples
```

New file: `src/tools/frequency-tools.ts` (~200-250 LOC)
Modified: `src/register-tools.ts` (1 import + 1 array entry)
New test: `tests/tools/frequency-tools.test.ts`

## Detailed Design

### Data Model

No schema changes. No new types in `src/types.ts`.

Tool-local interfaces in `frequency-tools.ts`:

```typescript
interface ShapeCluster {
  hash: string;              // unsigned 32-bit hex: (hash >>> 0).toString(16).padStart(8, '0')
  root_node_type: string;    // tree-sitter node type at cluster root (e.g., "function_declaration")
  count: number;             // symbols in this cluster
  node_count: number;        // AST nodes in the shape
  shape_preview: string;     // first 300 chars of normalized source
  examples: Array<{
    name: string;
    kind: SymbolKind;
    file: string;
    start_line: number;
  }>;                        // max 5 examples, sorted by file path
}

interface FrequencyResult {
  clusters: ShapeCluster[];  // top_n clusters, sorted by count desc
  summary: {
    total_symbols_analyzed: number;
    total_nodes_hashed: number;
    total_clusters_found: number;
    clusters_returned: number;
    skipped_no_source: number;
    skipped_truncated: number;
    skipped_below_min: number;
    low_signal: boolean;     // true when total_symbols_analyzed < 50 or largest cluster < 3
  };
}
```

### API Surface

MCP tool registration:

```typescript
{
  name: "frequency_analysis",
  description: "Find the most common code structures by normalizing AST and grouping by shape. " +
    "Discovers emergent patterns invisible to regex: functions with the same control flow but " +
    "different variable names are grouped together. Returns TOP N clusters with examples. " +
    "For similar-but-not-identical pairs, use find_clones instead.",
  schema: {
    repo: z.string().describe("Repository identifier"),
    top_n: zNum().optional().describe("Number of clusters to return (default: 30)"),
    min_nodes: zNum().optional().describe("Minimum AST nodes in a subtree to include (default: 5)"),
    file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    kind: z.string().optional().describe("Filter symbols by kind (default: function,method)"),
    include_tests: z.boolean().optional().describe("Include test files (default: false)"),
    token_budget: zNum().optional().describe("Max tokens for response"),
  },
  handler: (args) => frequencyAnalysis(args.repo as string, { ... }),
}
```

### Core Algorithm

**Step 1: Collect symbols**

```typescript
const index = await getCodeIndex(repo);
// filterSymbols is a LOCAL helper (not imported — follow loop pattern from clone-tools.ts prepareEntries)
// Filters by: kind (comma-separated, e.g. "function,method"), file_pattern, include_tests, has source
const symbols = filterSymbols(index.symbols, { file_pattern, kind, include_tests });
// Skip: no source, truncated source (ends with "..."), < min_nodes after parse
```

The `kind` parameter is a comma-separated list of `SymbolKind` values (e.g., `"function,method"`). Split on commas and filter inclusively. Default: `"function,method"`.

**Step 2: Re-parse and normalize each symbol**

For each symbol with valid source:

```typescript
// Use parseFile from parser-manager.ts — it derives language from file extension
const tree = await parseFile(symbol.file, symbol.source);
if (!tree) { skippedNoSource++; continue; }
const hash = hashSubtree(tree.rootNode);
// hashSubtree is recursive, post-order:
//   leaf: hash(node.type + normalizedText(node))
//   internal: hash(node.type + concat(childHashes))
```

Normalization rules for `normalizedText(node)`:
- `node.type === "identifier"` → `"_"`
- `node.type === "property_identifier"` → `"_"`
- `node.type === "type_identifier"` → `"_"`
- `node.type === "string"` or `"template_string"` → `"_S"`
- `node.type === "number"` → `"_N"`
- `node.type === "true"` or `"false"` → `"_B"`
- Everything else (keywords, operators, punctuation) → keep `node.type` as-is

**Step 3: Group by hash**

```typescript
// Key is number (djb2 output). Convert to hex string for API output: (hash >>> 0).toString(16).padStart(8, '0')
const clusters = new Map<number, { nodeType: string, nodeCount: number, symbols: SymbolRef[] }>();
// For each symbol, add to clusters.get(hash) or create new entry
```

**Step 4: Filter and rank**

```typescript
// Remove clusters with count === 1 (unique shapes)
// Sort by count descending
// Take top_n (default 30)
// For each cluster, take max 5 examples sorted by file path
// Generate shape_preview from first example's normalized source
```

**Step 5: Token budget**

```typescript
// Summary is always included (~200 tokens)
// Pack clusters greedily until token_budget exhausted
// Record clusters_returned vs total_clusters_found
```

### Integration Points

- **`src/parser/parser-manager.ts`** — `parseFile()` / `parser.parse()` is already exported. Re-parsing a source string is a supported operation (used in tests). Need to access the correct language grammar based on file extension.
- **`src/tools/index-tools.ts`** — `getCodeIndex(repo)` for symbol access. Standard entry point.
- **`src/tools/clone-tools.ts`** — Reference for patterns only. `ANALYZABLE_KINDS` is not exported — define a local copy. `djb2` hash function can be duplicated (it's 5 lines). `filterSymbols` does not exist — implement inline following the loop structure from `prepareEntries` in `clone-tools.ts`.
- **`src/register-tools.ts`** — Add import and `TOOL_DEFINITIONS` entry.
- **`src/server-helpers.ts`** — `SAVINGS_MULTIPLIER` map: add entry for `frequency_analysis`.

### Edge Cases

| # | Edge Case | Handling |
|---|-----------|----------|
| EC-1 | One-liner functions | Excluded by `min_nodes = 5` default. Opt-in via `min_nodes=1`. |
| EC-2 | Empty/trivial functions (`constructor() {}`) | Produce <5 nodes, excluded by default. Counted in `skipped_below_min`. |
| EC-3 | Truncated source (>5000 chars) | Detected by trailing `"..."`. Excluded. Counted in `skipped_truncated`. |
| EC-4 | Cross-language hash collision | `file_pattern` scopes to one language. Shape clusters include `file` paths so mixed-language clusters are visible. |
| EC-5 | Repo with <50 symbols | Returns results with `low_signal: true` and note. Does not throw. |
| EC-6 | Exact vs similar shapes | Exact hash only in MVP. Documented: "For similar pairs, use find_clones." |
| EC-7 | Normalization over-collapse | Keywords preserved, only identifiers/literals replaced. `find-or-throw` and `find-or-return-null` hash differently because `throw` vs `return` are different node types. |
| EC-8 | Shape naming | `shape_preview` = 300 chars of normalized source. Agent interprets from context. |
| EC-9 | Symbols without source | Skipped. Counted in `skipped_no_source`. |
| EC-10 | 5000+ symbols performance | Re-parse at ~2ms each = ~10s. Hash grouping O(n). Output truncated by token_budget. |

## Acceptance Criteria

1. `frequency_analysis` is registered as an MCP tool with parameters: `repo`, `top_n`, `min_nodes`, `file_pattern`, `kind`, `include_tests`, `token_budget`.
2. Returns `FrequencyResult` with `clusters[]` and `summary`.
3. Each cluster has: `hash`, `root_node_type`, `count`, `node_count`, `shape_preview` (max 300 chars), `examples` (max 5, with name/kind/file/start_line).
4. Normalization uses tree-sitter re-parse: identifiers → `_`, strings → `_S`, numbers → `_N`, booleans → `_B`. Keywords and operators preserved.
5. Hash is Merkle-style bottom-up: `hash(node) = djb2(node.type + childHashes)`.
6. Clusters sorted by count descending. Only clusters with count >= 2 returned.
7. `min_nodes = 5` default excludes trivial subtrees.
8. Truncated source symbols (trailing `"..."`) excluded and counted.
9. `token_budget` supported: summary always included, clusters packed greedily.
10. `low_signal` flag when `total_symbols_analyzed < 50` or largest cluster count < 3.
11. Tested: integration test with fixture repo containing known duplicate shapes.
12. On `local/codesift-mcp` (self-test): returns clusters where known patterns exist (e.g., multiple extractors with similar structure in `src/parser/extractors/`).

## Out of Scope

- **Fuzzy/near-miss clustering** (DECKARD-style LSH). MVP is exact hash match only. Follow-up as Level 3b.
- **Storing hashes in the index.** MVP re-computes on each call. Caching in the symbol index is an optimization for later.
- **Cross-repo frequency analysis.** MVP operates on one repo. Cross-repo comparison (which shapes are common across ALL repos) is a separate feature.
- **Auto-naming shapes** with semantic labels ("find-or-throw pattern"). `shape_preview` is the label. NLP-based naming is a follow-up.
- **UI/dashboard integration.** This is an MCP tool. Dashboard visualization is a separate feature.

## Open Questions

None. All design decisions resolved during brainstorm.
