# Secret Detection Tool (`scan_secrets`) — Design Specification

> **Date:** 2026-03-28
> **Status:** Approved
> **Author:** zuvo:brainstorm

## Problem Statement

CodeSift indexes source code for navigation and search but has zero awareness of hardcoded secrets (API keys, JWT tokens, passwords, connection strings). Users discover leaked credentials only when a separate tool (gitleaks, TruffleHog) is run manually — or worse, after a breach.

No existing MCP server provides local, AST-aware secret detection. The competitive landscape has registry-querying tools (npm-sentinel-mcp) and CLI wrappers (Knip MCP), but nothing that combines code intelligence with secret scanning.

Adding `scan_secrets` to CodeSift fills this gap: automatic, incremental secret detection that leverages the existing tree-sitter index for false-positive reduction, with results available instantly via MCP.

## Design Decisions

### DD1: Scan target — Hybrid (raw file content + AST enrichment)

**Chosen:** Scan raw file content from disk, then enrich each finding with AST context from the symbol index (symbol kind, name, test file detection).

**Alternatives considered:**
- (A) Symbol-only: fast, free AST context, but misses `.env`, `.yaml`, and secrets in truncated symbol source (>5K chars)
- (B) Raw-only: catches everything, but no AST context for FP reduction

**Why hybrid:** `.env` files are the #1 secret source but have zero symbols in the index. `symbol.source` is capped at 5K chars. Raw content catches everything; AST enrichment from the index reduces false positives where available.

### DD2: Non-indexed file types — Extend index with symbol-less FileEntries

**Chosen:** Modify `parseOneFile` to create a `FileEntry` with `symbols: []` for files with no tree-sitter parser (`.env`, `.yaml`, `.yml`, `.toml`, `.json`, `.properties`, `.ini`), instead of returning `null`.

**Alternatives considered:**
- (A) Separate mini-walk inside `scan_secrets`: simpler but creates a shadow index that diverges from `index.files`

**Why extend index:** The watcher automatically covers these files, `search_text` and `get_file_tree` gain visibility into config files, and `index.files` remains the single source of truth. Other tools benefit too.

### DD3: Output — Masked only, no raw secret exposure

**Chosen:** Always mask secrets in output (first 4 + `***` + last 4 chars). No opt-in `findings` mode.

**Why:** Exposing raw secrets through MCP risks leakage via response cache, usage logs, and LLM context window. The tool provides `file:line` — user opens the file to see the actual value. Simpler and safer.

### DD4: False positive management — Auto-classification + inline comments

**Chosen:** Two mechanisms:
1. **Auto-classification:** Test files (`isTestFile()`) and documentation files (`.md`, `.mdx`, `.txt`, `.rst`) get `confidence: "low"` automatically. Symbols with names containing `TEST_`, `FAKE_`, `EXAMPLE_`, `PLACEHOLDER_` are demoted.
2. **Inline allowlist:** `// codesift:allow-secret` comment on the line above or same line as the match suppresses the finding.

**Why:** Auto-classification handles ~80% of FP. Inline comments are zero-infrastructure and natural for developers. A persistent allowlist file is deferred to v2.

### DD5: Watcher integration — Eager scanning on file change

**Chosen:** Scan each file in `handleFileChange` immediately after re-indexing. Results are cached per file (keyed by `filePath + mtime_ms`). When user calls `scan_secrets()`, cached results are returned instantly.

**Alternatives considered:**
- Lazy: only invalidate cache on change, scan on next `scan_secrets()` call. Simpler but requires manual invocation.

**Why eager:** User should never need to manually trigger a scan. Findings accumulate automatically. `scan_secrets()` becomes a read-from-cache operation, not a compute operation. Cost per file: ~0.15ms scan + ~1ms read = negligible on 500ms debounce.

### DD6: Reporting — Inline warnings in existing tools + dedicated tool + dashboard-ready events

**Chosen:** Three reporting channels:
1. **Inline warnings:** `index_file` and `index_folder` responses include a secrets summary (e.g., "⚠ 2 potential secrets detected in src/config.ts")
2. **Dedicated tool:** `scan_secrets(repo)` returns full findings list with filtering
3. **Dashboard-ready:** Scan results are structured for consumption by the codesift-dashboard (findings count per repo, severity breakdown, trend data)

## Solution Overview

```
File change detected (watcher)
  → handleFileChange() re-indexes symbols
  → scanFileForSecrets(filePath, repoName):
      1. Read raw file content from disk
      2. Skip if binary (null byte in first 512 bytes) or oversized (>500KB)
      3. Call @sanity-labs/secret-scan scan(content)
      4. Map Secret.start/end → line numbers
      5. Check for // codesift:allow-secret on same/previous line → suppress
      6. Enrich with AST context: find overlapping CodeSymbol by line range
         → add symbol_kind, symbol_name, in_test_file, in_doc_file
      7. Apply confidence classification (test/doc/placeholder → low)
      8. Mask secret values (first4 + *** + last4)
      9. Cache result keyed by filePath + mtime_ms
  → Store in secretScanCache: Map<repoName, Map<filePath, SecretFinding[]>>

User calls scan_secrets(repo)
  → Read from secretScanCache
  → Filter by file_pattern, min_confidence, exclude_tests
  → Return masked SecretFinding[]

User calls index_file / index_folder
  → Normal response + appended secrets summary if any found
```

## Detailed Design

### Data Model

**Library API mapping:** `@sanity-labs/secret-scan` `scan()` returns `Secret { rule, label, text, confidence: 'high'|'medium', start, end }`. Map `Secret.text` → masking input. Treat library `confidence` as the base signal; CodeSift only **demotes** (never promotes) via its own classification (test file, docs, placeholder name).

```typescript
// New type in src/types.ts or src/tools/secret-tools.ts
interface SecretFinding {
  file: string;              // relative to repo root (same convention as CodeSymbol.file)
  line: number;              // 1-based
  rule: string;              // e.g. "openai", "github-v2"
  label: string;             // e.g. "OpenAI API Key"
  severity: SecretSeverity;  // mapped from rule
  confidence: 'high' | 'medium' | 'low';
  match_masked: string;      // "sk-p...3xYz"
  context: SecretContext;    // production | test | config | docs | unknown
  symbol_name?: string;      // enclosing symbol if available
  symbol_kind?: string;      // function, constant, etc.
}

type SecretSeverity = 'critical' | 'high' | 'medium' | 'low';
type SecretContext = 'production' | 'test' | 'config' | 'docs' | 'unknown';

// Severity mapping: library confidence is the BASE, then promote by rule category.
// Library 'high' confidence → at least 'high' severity (promote to 'critical' for cloud/payment).
// Library 'medium' confidence → 'medium' severity floor.
// CodeSift context can only DEMOTE (test/doc/placeholder → lower confidence), never promote.
const SEVERITY_MAP: Record<string, SecretSeverity> = {
  // Critical: cloud provider keys, payment keys (only when library confidence = 'high')
  'aws': 'critical', 'gcp': 'critical', 'azure': 'critical',
  'stripe': 'critical', 'paypal': 'critical',
  // High: API keys, tokens
  'openai': 'high', 'anthropic': 'high', 'github': 'high',
  'slack': 'high', 'twilio': 'high',
  // Medium: generic patterns, connection strings
  'generic': 'medium', 'jdbc': 'medium',
  // Default for unknown rules: use library confidence as-is
};

// Per-file cache entry
interface SecretCacheEntry {
  mtime_ms: number;
  findings: SecretFinding[];
}
```

### API Surface

#### `scan_secrets` MCP Tool

```typescript
// Parameters
{
  repo: z.string(),                                           // required
  file_pattern: z.string().optional(),                        // picomatch glob
  min_confidence: z.enum(['high', 'medium', 'low']).optional(), // default: 'medium'
  exclude_tests: z.boolean().optional(),                      // default: true
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), // minimum severity
}

// Response shape
{
  total_findings: number,
  files_scanned: number,
  files_with_secrets: number,
  scan_coverage: 'full' | 'partial' | 'none',  // 'none' = cold start, no files scanned yet
  last_scanned_at: number | null,               // epoch ms of most recent scan
  findings: SecretFinding[],       // filtered, masked
  skipped: {                       // transparency
    binary: number,
    oversized: number,
    allowlisted: number,
  }
}

// Cold start handling: when scan_coverage === 'none' (server just started,
// no watcher events yet), scan_secrets triggers a one-time full scan to
// warm the cache. Subsequent calls read from cache.
```

#### Inline warnings in `index_file` / `index_folder`

Appended to existing response when secrets found:
```
⚠ Secrets detected:
  src/config.ts:12 — OpenAI API Key (high)
  .env:3 — Generic API Key (medium)
```

### Integration Points

#### Files to create:
- **`src/tools/secret-tools.ts`** — Tool handler, cache, scan logic, severity mapping. Follows `pattern-tools.ts` structure.

#### Files to modify:
- **`src/register-tools.ts`** — Add `scan_secrets` to `TOOL_DEFINITIONS[]` array
- **`src/tools/index-tools.ts`** — In `handleFileChange`: call `scanFileForSecrets()` **before** the `if (!result) return` guard so config files (.env, .yaml) are scanned even when `parseOneFile` returns null. In `handleFileDelete`: remove file from `secretScanCache`. In `index_file`/`index_folder` response: append secrets summary.
- **`src/parser/parser-manager.ts`** or **`src/tools/index-tools.ts`** — Modify `parseOneFile` to return `FileEntry` with `symbols: []` for unrecognized extensions instead of `null`. Add scannable extensions list: `.env`, `.yaml`, `.yml`, `.toml`, `.json`, `.properties`, `.ini`. **⚠ DD2 is a blocking prerequisite for watcher integration** — must land in the same PR before the watcher hook, otherwise `.env` files (the #1 secret source) are silently skipped.
- **`src/config.ts`** — Add `secretScanEnabled: boolean` (env: `CODESIFT_SECRET_SCAN`, default: `true`)
- **`src/server-helpers.ts`** — Add `scan_secrets` to `SAVINGS_MULTIPLIER`. Ensure masking happens before `setCache`.
- **`src/storage/usage-tracker.ts`** — Add `scan_secrets` to `TOOL_ARG_FIELDS`

#### External dependency:
- **`@sanity-labs/secret-scan`** — Add to `package.json` dependencies (MIT, 0 transitive deps, 1.1MB)

### Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Binary files (.wasm, .png, .db) | Check first 512 bytes for null byte → skip, annotate `skipped_binary` |
| Files > 500KB | Skip → `skipped_oversized` |
| Minified JS (single line >10KB) | Skip → `skipped_minified` |
| `.env` not in index | DD2 solves this: `parseOneFile` creates FileEntry with empty symbols |
| tree-sitter parse fails | Scan raw content, `ast_context: null` — graceful degradation |
| Test fixture secrets | Auto-classify `confidence: low` via `isTestFile()` + symbol kind |
| README example keys | `.md`/`.mdx`/`.txt`/`.rst` → `confidence: low`, `context: docs` |
| JWT-like base64 (not actually JWT) | Post-filter: decode header, check `alg` field. Invalid → `confidence: low` |
| `// codesift:allow-secret` comment | Check line above and same line → suppress finding |
| File modified during scan | Compare `mtime_ms` before and after scan. If changed, discard result (don't cache) |
| 10K+ file repo, full scan | Batch with `PARSE_CONCURRENCY` (8). mtime cache skips unchanged files. |
| Lock files (`package-lock.json`, `yarn.lock`) | Excluded by default (high entropy, zero real secrets). Add to skip list. |
| Build artifacts (`dist/`, `build/`, `.next/`) | Already in `IGNORE_DIRS` in `walk.ts` |
| `audits/artifacts/` directory | Skip — contains triaged gitleaks output, would re-surface old findings |
| Secret in `wrapTool` response cache | Masking applied in `secretScanCache` at scan time — `SecretFinding` only ever contains masked values. The `wrapTool` 30s response cache is safe to use normally because it only ever sees already-masked data. No special cache bypass needed. |

### Dashboard Integration (future-ready)

The `SecretFinding` type and scan results are structured for dashboard consumption:

- **Aggregate endpoint data:** `total_findings`, `files_with_secrets`, severity breakdown per repo
- **Trend data:** Cache includes `mtime_ms` per file — dashboard can track findings over time by polling `scan_secrets` periodically
- **Event hook:** When eager scan finds NEW secrets (not in previous cache), emit a structured event that the dashboard can subscribe to via the existing MCP notification pattern

Implementation of the dashboard integration is out of scope for this spec but the data model supports it without changes.

## Acceptance Criteria

### Must have:
1. `scan_secrets(repo)` returns masked `SecretFinding[]` with file, line, rule, severity, confidence, context
2. Secrets are always masked (first 4 + `***` + last 4). Raw values never appear in MCP response, cache, or logs
3. `.env`, `.yaml`, `.toml`, `.json`, `.properties`, `.ini` files are scanned (DD2: index extension)
4. Binary files detected and skipped (null byte probe)
5. Files >500KB skipped with annotation
6. Per-file cache keyed by `filePath + mtime_ms` — unchanged files not re-scanned
7. Eager scanning on file change via watcher integration
8. `index_file` / `index_folder` responses include secrets summary when findings exist
9. Test files auto-classified `confidence: low` via `isTestFile()`
10. `// codesift:allow-secret` inline comment suppresses finding
11. Graceful degradation when tree-sitter parse fails (scan raw content, no AST context)
12. Tool returns `errorResult` for non-existent repo (consistent with other tools)

### Should have:
13. `file_pattern` parameter for scoped scanning (picomatch glob)
14. `min_confidence` parameter (default: `medium`)
15. `exclude_tests` parameter (default: `true`)
16. `severity` filter parameter
17. Severity mapping from rule IDs to critical/high/medium/low
18. Documentation files (`.md`, `.mdx`) auto-classified `confidence: low`, `context: docs`
19. JWT post-validation (decode header, check `alg`) before reporting
20. Lock files and minified bundles excluded by default
21. `secretScanEnabled` config flag (env: `CODESIFT_SECRET_SCAN`)
22. Usage tracking via `TOOL_ARG_FIELDS`
23. Dashboard-ready data structure (aggregate counts, severity breakdown)

### Edge case handling:
24. mtime drift detection: discard scan result if file changed during scan
25. Symbols with `TEST_`/`FAKE_`/`EXAMPLE_`/`PLACEHOLDER_` in name → demote confidence
26. `audits/artifacts/` directory skipped to avoid re-surfacing triaged findings

## Out of Scope

- **Raw secret exposure mode** — masked only in v1, no opt-in findings mode
- **Persistent allowlist file** (`.codesift/scan-secrets-allowlist.json`) — deferred to v2
- **Rule filtering** (`rules` parameter to select specific detectors) — `@sanity-labs/secret-scan` doesn't support it; deferred
- **Live credential verification** (API calls to check if key is active) — too invasive for local tool
- **Git history scanning** — gitleaks/TruffleHog do this better; CodeSift scans current files only
- **Custom rule authoring** — use built-in ~1,100 rules (1,108 compiled + 8 custom in library); custom rules deferred
- **Dashboard UI implementation** — data model is dashboard-ready but UI is separate work
- **`manage_allowlist` companion tool** — deferred to v2 with persistent allowlist

## Open Questions

None — all design decisions resolved during brainstorm dialogue.
