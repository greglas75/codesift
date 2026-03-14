# CodeSift Tool Recommendation Matrix

**Date:** 2026-03-14
**Based on:** Categories A-G benchmark (70 tasks, CodeSift CLI vs Bash grep/Read, promptvault 4127 files)

---

## Summary Scorecard

| Category | Tool | CodeSift | Bash | Winner | Δ tokens |
|----------|------|----------|------|--------|----------|
| **A** | search_text | **48,930** | 72,993 | **CodeSift -33%** | ✅ |
| **B** | search_symbols | 63,829 | **60,282** | Bash -6% | ❌ |
| **C** | tree/outline | **36,580** | 45,489 | **CodeSift -20%** | ✅ |
| **D** | get_symbol | **57,703** | 60,482 | **CodeSift -5%** | ✅ |
| **E** | refs/trace | timeout | **60,810** | **Bash** | ❌ |
| **G** | semantic | **7.8/10** | 6.5/10 | **CodeSift +20%** | ✅ |

**CodeSift wins 4/6 categories.** Loses on B (verbosity, fixable) and E (trace broken, needs rewrite).

---

## When to Use Each Tool

### USE CODESIFT ✅

| Task | CodeSift Command | Why Better Than Bash |
|------|-----------------|---------------------|
| **Find text in files** | `codesift search <repo> <query>` | -33% tokens, file_pattern filtering, BM25 ranking |
| **Find function/type by name** | `codesift symbols <repo> <query> --kind function` | Returns signature+body in 1 call (no grep→Read) |
| **Get file structure** | `codesift tree <repo> --path <dir> --compact` | -20% tokens, symbol counts per file |
| **Read function body** | `codesift symbols <repo> <name> --include-source` | Exact symbol boundaries, no line math |
| **Answer "how does X work?"** | `codesift retrieve <repo> --queries '[{"type":"semantic",...}]'` | +20% quality vs grep on concept questions |
| **Batch multiple queries** | `codesift retrieve <repo> --queries '[{...},{...}]'` | Multiple queries in 1 call |

### USE BASH GREP ✅

| Task | Bash Command | Why Better Than CodeSift |
|------|-------------|------------------------|
| **Find ALL occurrences** | `grep -rn "pattern" src/` | Complete coverage, no top_k cap |
| **Count things** | `grep -c "pattern" file` | Simple, exact count |
| **Call chain tracing** | `grep -rn "functionName(" src/` | CodeSift trace is broken |
| **File inventory** | `find src -name "*.ts" \| wc -l` | Faster for simple listings |
| **Show me all X** | `grep -rn "pattern" --include="*.ts"` | Better for enumeration tasks |

### USE CODESIFT SEMANTIC 🔍

| Task | When | Quality |
|------|------|---------|
| "How does auth work?" | New codebase, don't know structure | 9/10 |
| "What caching strategies?" | Cross-cutting concerns | 8/10 |
| "How are errors handled?" | Architecture understanding | 9/10 |
| "How does the pipeline work?" | Complex multi-file flows | 10/10 |

**Requires:** `CODESIFT_OPENAI_API_KEY` or `CODESIFT_VOYAGE_API_KEY` configured.

### DON'T USE (BROKEN) ❌

| Tool | Status | Workaround |
|------|--------|------------|
| `codesift trace` | Token matching, not call graph. Timeout on large codebases. | Use `grep -rn "functionName(" src/` |
| `codesift refs` | Works but output too large for common names. | Use `grep -rn "name" src/ --include="*.ts"` |
| `codesift context` (BM25) | Low quality on concept queries (5.2/10). | Use `codesift retrieve` with `type: "semantic"` |

---

## Agent Instructions (for CLAUDE.md)

```markdown
## Code Search Tool Selection

When searching code, choose the right tool:

1. **"Find X in codebase"** → `codesift search <repo> "pattern"` (33% fewer tokens than grep)
2. **"Find function/type"** → `codesift symbols <repo> "name" --kind function` (returns body in 1 call)
3. **"File structure"** → `codesift tree <repo> --path <dir> --compact` (20% fewer tokens)
4. **"How does X work?"** → `codesift retrieve <repo> --queries '[{"type":"semantic","query":"..."}]'`
5. **"Find ALL occurrences"** → `grep -rn "pattern" src/` (exhaustive, CodeSift has top_k limit)
6. **"Call chain/who calls X"** → `grep -rn "functionName(" src/` (CodeSift trace is broken)

Install: `npm install -g codesift-mcp` then `codesift index .`
```

---

## Bugs Fixed During Benchmarking (14 fixes)

| # | Bug | Category | Impact |
|---|-----|----------|--------|
| 1 | search_text 100-result cap | A | +50% results for large matches |
| 2 | search_text scope (only indexed files) | A | Finds .env, .prisma, config files |
| 3 | `src/**` glob pattern broken | A | No retries needed |
| 4 | search_symbols top_k default 20→50 | B | Complete results |
| 5 | Kind filter BM25 truncation | B | Interfaces findable |
| 6 | Empty query + file_pattern | B | Browse symbols by file |
| 7 | .tsx parser (tree-sitter-tsx.wasm) | B | +508 symbols, React components found |
| 8 | get_file_tree depth truncation | C | Depth parameter works |
| 9 | get_file_tree name_pattern glob | C | Multi-wildcard patterns |
| 10 | Compact mode + min_symbols | C | -22× output for large queries |
| 11 | Outline test_case IDs undefined | D | get_symbol on test cases |
| 12 | Prisma file parser | D | Enums from .prisma indexed |
| 13 | refs/trace source stripping | E | -99% output (684K→6.6K) |
| 14 | include_source verbosity | B,D | Default top_k=5 with source |

## Remaining Issues

| # | Issue | Priority | Status |
|---|-------|----------|--------|
| 1 | trace_call_chain uses token matching, not AST | P0 | Needs full rewrite |
| 2 | find_references output too large for common names | P1 | Needs pagination/limit |
| 3 | Semantic returns test files in budget | P1 | Need --exclude-tests |
| 4 | Duplicate Prisma schemas in semantic results | P2 | Exclude generated/ |

---

## Index Stats (after all fixes)

| Metric | Before | After | Δ |
|--------|--------|-------|---|
| **Symbols** | 15,696 | **19,707** | +25.5% |
| **Files** | 1,311 | **1,835** | +40.0% |
| **Symbol kinds** | 10 | **14** | +4 (constant, test_hook, section, metadata) |
| **Tests passing** | 136 | **168** | +32 new tests |
| **CLI commands** | 0 | **22** | Full CLI built |
