# SQL Language Support -- Design Specification

> **spec_id:** 2026-04-11-sql-support-2006
> **topic:** SQL language support (parser, extractor, analysis tools)
> **status:** Approved
> **created_at:** 2026-04-11T20:06:49Z
> **approved_at:** 2026-04-11T20:30:00Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

CodeSift MCP indexes 12 languages with tree-sitter parsers and 13 as text_stubs, but SQL files (`.sql`) are completely invisible -- not in `EXTENSION_MAP`, not searchable, not in `get_file_tree`. Any project with database migrations, schema definitions, or stored procedures has a blind spot.

**Who is affected:** Developers working on projects with SQL schemas, migrations (Rails, Django, Knex, Prisma migrate, Flyway, Liquibase), dbt models, or stored procedures. This includes most backend/fullstack projects.

**Competitive context:** Only jCodeMunch (1,500 stars) has real SQL support among MCP code indexing tools. All others (Serena 22K+, CodeGraphContext, codedb, codegraph, Axon, YoYo) have zero SQL support. jCodeMunch uses DerekStride/tree-sitter-sql with a custom extractor, Jinja preprocessor, and `search_columns` tool. CodeSift can match and exceed this with regex extraction + cross-language `trace_query` (unique on the market).

**What happens if we do nothing:** SQL files remain invisible. Agents using CodeSift on database-heavy projects get incomplete code understanding. Competitors (jCodeMunch) maintain a gap in data engineering use cases.

## Design Decisions

### DD-1: Regex-based extractor (not tree-sitter)

**Chosen:** Regex extractor following the Prisma pattern (`src/parser/extractors/prisma.ts`, ~135 lines).

**Why:** Zero new dependencies, no WASM ABI risk (PHP grammar already pinned due to ABI 14/15 breakage), no emscripten build step. The `@derekstride/tree-sitter-sql` npm package does not ship pre-built WASM -- requires custom gh-pages download or manual build. Regex handles DDL extraction cleanly (CREATE TABLE/VIEW/FUNCTION/etc. are structurally regular). Tree-sitter upgrade is a clean v2 enhancement.

**Alternatives rejected:**
- tree-sitter-sql from day 1: WASM packaging friction, ABI risk, 2x ship time
- text_stub only: too little value -- users need symbol extraction

### DD-2: New SQL-specific SymbolKinds

**Chosen:** Add `table`, `view`, `index`, `trigger`, `procedure` to the `SymbolKind` union in `types.ts`.

**Why:** Clean filtering (`search_symbols(kind="table")` returns only tables). SQL is a first-class domain, forcing TABLE into `class` and VIEW into `interface` creates confusing search results. The cost is ~10 callsites to update (search-ranker LABEL_BONUS, complexity-tools ANALYZABLE_KINDS, formatters) but it's a one-time investment.

**Alternatives rejected:**
- Reuse existing kinds (TABLE→class, VIEW→interface): pollutes kind-filtered searches, confusing UX

### DD-3: `sql-jinja` as separate language variant

**Chosen:** Files containing Jinja/dbt markers (`{{`, `{%`, `{#`) are detected pre-parse and assigned `language: "sql-jinja"`. They get a dedicated extraction path that strips Jinja tokens before applying DDL regex extraction.

**Why:** Clean separation -- the SQL parser never sees Jinja syntax. The `sql-jinja` variant can evolve independently (e.g., extracting `{{ ref('model') }}` as cross-file dependencies in v2). No pollution of the pure SQL extractor.

**Alternatives rejected:**
- Ignore Jinja in v1: corrupted symbol names when Jinja is inside DDL
- Pre-parse strip without variant: muddies the SQL extractor's responsibility

### DD-4: v1 scope = parser + extractor + analyze_schema + trace_query

**Chosen:** Ship extraction infrastructure + two analysis tools in v1. Defer `lint_schema` and `diff_migrations` to v2.

**Why:** `analyze_schema` and `trace_query` are high-value, low-risk read-only tools. `lint_schema` has high false-positive risk requiring a suppression mechanism. `diff_migrations` requires robust migration ordering heuristics. Both need more design iteration.

### DD-5: Hidden/discoverable tools (not core)

**Chosen:** `analyze_schema` and `trace_query` are registered in `TOOL_DEFINITIONS` but NOT added to `CORE_TOOL_NAMES`. They are discoverable via `discover_tools(query="SQL schema")`.

**Why:** SQL is not universal -- many repos have zero `.sql` files. Adding SQL tools to the always-visible 36 core tools would increase noise for non-SQL users. The discover/describe/reveal pattern is designed for exactly this use case.

## Solution Overview

### Component diagram

```
.sql file → EXTENSION_MAP (".sql" → "sql", detect jinja → "sql-jinja")
         → parseOneFile() branches:
           ├─ "sql"       → extractSqlSymbols(source, filePath, repo)
           └─ "sql-jinja" → stripJinja(source) → extractSqlSymbols(stripped, filePath, repo)
         → CodeSymbol[] with kinds: table, view, function, index, trigger, procedure
         → BM25 index, search_text, find_references, ranked search
         → analyze_schema(repo) — reads symbols, builds ERD
         → trace_query(repo, table) — cross-language grep for table name
```

### Delivery phases

**Phase A — Foundation (extraction):**
1. Add `.sql` → `"sql"` to `EXTENSION_MAP`
2. Add `sql-jinja` language detection + direct extractor dispatch in `parseOneFile()` (Prisma/Markdown pattern — bypasses `symbol-extractor.ts` entirely)
3. Create `src/parser/extractors/sql.ts` (regex extractor + `stripJinjaTokens`)
4. Add SQL SymbolKinds to `types.ts`
5. Update `PARSER_LANGUAGES`, `LABEL_BONUS`, complexity guard
6. Tests for all DDL constructs + edge cases

**Phase B — Analysis tools:**
8. Create `src/tools/sql-tools.ts` with `analyzeSchema()` and `traceQuery()`
9. Register in `TOOL_DEFINITIONS` (hidden/discoverable)
10. Tests for tools

## Detailed Design

### Data Model

#### New SymbolKinds (`src/types.ts`)

Add to the `SymbolKind` union:

```typescript
| "table"      // CREATE TABLE
| "view"       // CREATE VIEW
| "index"      // CREATE INDEX
| "trigger"    // CREATE TRIGGER
| "procedure"  // CREATE PROCEDURE / CREATE FUNCTION (stored)
```

Note: `"function"` (existing kind) is used for `CREATE FUNCTION` when it's a standalone SQL function. `"procedure"` is for `CREATE PROCEDURE`. Both are valid SQL constructs.

#### SQL symbol structure

```typescript
// Example: CREATE TABLE orders (id INT PRIMARY KEY, user_id INT REFERENCES users(id))
{
  id: "local/myapp:migrations/001.sql:orders:5",
  repo: "local/myapp",
  name: "orders",
  kind: "table",
  signature: "TABLE orders (id, user_id)",  // column names in signature
  docstring: "-- Orders table for e-commerce",  // preceding comment
  source: "CREATE TABLE orders (\n  id INT PRIMARY KEY,\n  ...\n);",
  parent: undefined,  // top-level
  file: "migrations/001.sql",
  start_line: 5,
  end_line: 12,
  tokens: ["orders"]
}

// Column as child symbol:
{
  id: "local/myapp:migrations/001.sql:orders.user_id:7",
  name: "user_id",
  kind: "field",
  signature: "INT REFERENCES users(id)",
  parent: "local/myapp:migrations/001.sql:orders:5",  // parent table
  ...
}
```

#### Language detection in `parseOneFile()`

```typescript
// In index-tools.ts, after language detection:
if (language === "sql") {
  // Check for Jinja markers
  if (/\{\{|\{%|\{#/.test(source)) {
    language = "sql-jinja";
  }
}
```

For `sql-jinja`:
```typescript
} else if (language === "sql-jinja") {
  const stripped = stripJinjaTokens(source);
  symbols = extractSqlSymbols(stripped, relPath, repo, source);
  // Pass original source for accurate line numbers + source field
}
```

### API Surface

#### `extractSqlSymbols(source, filePath, repo, originalSource?)`

Regex-based extractor. Handles:

| SQL Construct | Regex pattern | SymbolKind | Notes |
|---------------|--------------|------------|-------|
| `CREATE TABLE name` | `CREATE\s+(OR\s+REPLACE\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+\.)?(\w+)` | `table` | Schema-qualified names: extract last part |
| `CREATE VIEW name` | `CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(\w+\.)?(\w+)` | `view` | Includes MATERIALIZED VIEW |
| `CREATE INDEX name` | `CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)` | `index` | |
| `CREATE FUNCTION name` | `CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\w+\.)?(\w+)` | `function` | |
| `CREATE PROCEDURE name` | `CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+(\w+\.)?(\w+)` | `procedure` | |
| `CREATE TRIGGER name` | `CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(\w+\.)?(\w+)` | `trigger` | |
| `CREATE SCHEMA name` | `CREATE\s+SCHEMA\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)` | `namespace` | Uses existing kind |
| `CREATE TYPE name` | `CREATE\s+TYPE\s+(\w+\.)?(\w+)` | `type` | Uses existing kind |
| `CREATE SEQUENCE name` | `CREATE\s+SEQUENCE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+\.)?(\w+)` | `variable` | Uses existing kind |
| Column definitions | Inside TABLE body: `(\w+)\s+(INT\|VARCHAR\|...)` | `field` | Parent = table symbol |
| CTEs | `(\w+)\s+AS\s*\(` in WITH blocks | `function` | Uses existing kind |

**Source extraction**: For each symbol, capture from the `CREATE` keyword to the matching `;` or `)` (for columns within a table body). Respect `MAX_SOURCE_LENGTH = 5000`.

**Docstring extraction**: Capture `--` single-line comments or `/* */` block comments immediately preceding the `CREATE` statement.

**Signature generation**: For tables: `TABLE name (col1, col2, ...)`. For functions/procedures: `FUNCTION name(param1 TYPE, param2 TYPE) RETURNS TYPE`. For views: `VIEW name AS SELECT ...` (truncated).

#### `stripJinjaTokens(source: string): string`

Pre-processor for `sql-jinja` files. **Line-preserving**: all Jinja tokens are replaced with whitespace of equal newline count so subsequent DDL reports correct `start_line` values.

```typescript
function stripJinjaTokens(source: string): string {
  // Replace each match with whitespace preserving line breaks — zero line drift
  const preserveLines = (match: string) =>
    match.replace(/[^\n]/g, ' ');  // keep \n, replace everything else with space

  return source
    .replace(/\{#[\s\S]*?#\}/g, preserveLines)    // Jinja comments
    .replace(/\{%[\s\S]*?%\}/g, preserveLines)    // Jinja blocks
    .replace(/\{\{[\s\S]*?\}\}/g, preserveLines); // Jinja expressions
}
```

This guarantees the stripped source has identical line structure to the original. Line numbers extracted from the stripped source map 1:1 to the original file.

#### `analyzeSchema(repo, options?)`

```typescript
interface AnalyzeSchemaOptions {
  file_pattern?: string;  // default: "*.sql"
  output_format?: "json" | "mermaid";  // default: "json"
  include_columns?: boolean;  // default: true
}

interface SchemaAnalysisResult {
  tables: TableInfo[];
  views: ViewInfo[];
  relationships: Relationship[];  // FK references
  warnings: string[];  // duplicates, circular refs
  mermaid?: string;  // if output_format="mermaid"
}

interface TableInfo {
  name: string;
  file: string;
  line: number;
  columns: ColumnInfo[];
}

interface Relationship {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  type: "fk" | "self_reference" | "circular";
}
```

**Implementation**: Reads `index.symbols` filtered by `kind === "table" | "view"`, extracts FK relationships from column sources via regex (`REFERENCES\s+(\w+)\s*\((\w+)\)`), builds relationship graph with cycle detection (visited set).

**Mermaid output**: Generates `erDiagram` format for entity-relationship visualization.

**Error responses**: If `getCodeIndex(repo)` returns `null`, throw `new Error("Repository '${repo}' not found. Run index_folder first.")` -- matches the existing pattern used by `search-tools.ts` and `complexity-tools.ts`.

#### `traceQuery(repo, options)`

```typescript
interface TraceQueryOptions {
  table: string;                // table name to trace (required)
  include_orm?: boolean;        // default: true — check Prisma + Drizzle (v1 scope)
  file_pattern?: string;        // optional glob to scope ripgrep (e.g. "src/**/*.ts")
  max_references?: number;      // default: 500 — caps noisy common names
}

interface TraceQueryResult {
  table_definition: {
    file: string;
    line: number;
    kind: "table" | "view";
  } | null;
  sql_references: Array<{
    file: string;
    line: number;
    context: string;  // surrounding line
    type: "ddl" | "dml" | "view" | "fk";
  }>;
  orm_references: Array<{
    file: string;
    line: number;
    orm: "prisma" | "drizzle";   // v1: Prisma + Drizzle only. TypeORM/Knex deferred to v2.
    model_name: string;
  }>;
  warnings: string[];            // e.g., "Truncated at max_references=500"
  truncated: boolean;             // true if max_references hit
}
```

**Implementation**:
1. Validate `table` parameter is non-empty; throw on missing repo.
2. Find table definition in SQL symbols (`kind === "table"`, `name === table`)
3. Ripgrep for word-bounded table name across indexed files. Default scope: all text-indexable files. If `file_pattern` provided, pass as `--glob` to ripgrep.
4. Hard cap at `max_references` (default 500). If cap hit, set `truncated: true` and append warning `"Results truncated at ${max_references}. Pass file_pattern or increase max_references to see more."`.
5. Classify hits: DDL reference (ALTER TABLE), DML (SELECT/INSERT/UPDATE/DELETE FROM), FK (REFERENCES), view (inside CREATE VIEW AS)
6. If `include_orm`: check Prisma schema for `@@map("table_name")` or model name matching table name. Check for Drizzle `pgTable("table_name", ...)` calls. **TypeORM and Knex detection deferred to v2.**
7. If ORM detected but zero ORM references found: add warning "ORM detected but no model found for this table"

**Performance note**: Ripgrep on a large monorepo with a common table name (e.g., `users`) can return thousands of matches. The `max_references` cap (default 500) prevents unbounded response sizes. Users can narrow with `file_pattern` for precise results.

**Error responses**: If `getCodeIndex(repo)` returns `null`, throw `new Error("Repository '${repo}' not found. Run index_folder first.")` -- matches the existing pattern. If the table name is empty or undefined, throw `new Error("table parameter is required")`.

### Automatic downstream behaviors (no new code)

Once `.sql` files are in `EXTENSION_MAP` and symbols are extracted, these existing tools automatically gain SQL support -- no code changes required, but the behavior is part of ship criteria:

| Tool | Automatic behavior | Mechanism |
|------|-------------------|-----------|
| `find_references` | Finds raw string matches of SQL table names in all indexed files (including `.ts`, `.py`, `.go`). No semantic cross-language linking -- treats table names as literal tokens. A table named `user` will match any mention of `user` anywhere. Users needing precise cross-language linking should use `trace_query` which has ORM-aware detection. | `findReferences()` in `src/tools/symbol-tools.ts` uses ripgrep with word-boundary pattern on symbol name. It runs on all indexed files regardless of language. |
| `search_text` | Searches `.sql` file contents like any other text file. | Ripgrep covers all non-binary indexed files. |
| `get_file_outline` | Lists SQL symbols with line numbers. | Reads `index.symbols` filtered by file path. |
| `search_text(ranked=true)` | Classifies SQL matches by containing symbol (e.g., "match inside CREATE TABLE orders"). | `classifyHitsWithSymbols()` binary-searches symbols by line containment -- language-agnostic. |
| `impact_analysis` | SQL symbols participate in git-diff-based impact when `.sql` files change. | `impactAnalysis()` filters `index.symbols` by changed files. |
| `scan_secrets` | Scans `.sql` files for leaked credentials. | Ripgrep-based, language-agnostic. |

**Contract for `find_references` on SQL tables (Ship criterion #8)**: The behavior is literal-token matching, not semantic resolution. This is consistent with how `find_references` works for all symbols (TypeScript, Python, etc.) -- it is a ripgrep wrapper over symbol names, not a compile-time reference resolver. Ship criterion #8 is considered met if `find_references("orders")` returns hits from both `.sql` files and `.ts` files that mention `orders`. Users needing ORM-aware cross-language linking should use `trace_query`.

### Integration Points

**Dispatch pattern**: The SQL extractor follows the **Prisma/Markdown non-tree-sitter pattern** -- it is called directly from `parseOneFile()` in `index-tools.ts`, bypassing the `extractSymbols()` switch in `symbol-extractor.ts`. No case needs to be added to that switch. This mirrors how `extractPrismaSymbols`, `extractMarkdownSymbols`, `extractAstroSymbols`, and `extractConversationSymbols` are currently wired.

**Files modified:**

| File | Change |
|------|--------|
| `src/parser/parser-manager.ts` | Add `".sql": "sql"` to `EXTENSION_MAP` |
| `src/types.ts` | Add `table`, `view`, `index`, `trigger`, `procedure` to `SymbolKind` |
| `src/tools/index-tools.ts` | Add Jinja detection branch (`sql` → `sql-jinja`) + direct call to `extractSqlSymbols` for both variants, mirroring the Prisma branch. No change to `symbol-extractor.ts`. |
| `src/tools/project-tools.ts` | Add `"sql"` AND `"sql-jinja"` to `PARSER_LANGUAGES` (both produce symbols via regex extraction). **Do NOT add to `TEXT_STUB_LANGUAGES`** -- that list is for file-tree-only languages with no symbol extraction, which would make the `sql-jinja` dispatch branch unreachable. |
| `src/tools/search-ranker.ts` | Add `table: 1.0`, `view: 0.8`, `trigger: 0.6`, `procedure: 0.7`, `index: 0.5` to `LABEL_BONUS` |
| `src/tools/complexity-tools.ts` | Add guard: skip SQL files (CC is meaningless for DDL) |
| `src/register-tools.ts` | Add `analyze_schema` and `trace_query` to `TOOL_DEFINITIONS` (hidden, not in `CORE_TOOL_NAMES`) |

**Files created:**

| File | Purpose |
|------|---------|
| `src/parser/extractors/sql.ts` | `extractSqlSymbols()` + `stripJinjaTokens()` |
| `src/tools/sql-tools.ts` | `analyzeSchema()` + `traceQuery()` + formatters |

### Edge Cases

| ID | Case | Handling |
|----|------|----------|
| EC-1 | Empty `.sql` files | Extractor returns `[]`. File in `get_file_tree` with `symbol_count: 0`. |
| EC-2 | Comment-only `.sql` files | Same as EC-1. `analyze_schema` distinguishes "no .sql files" from "sql files with no DDL". |
| EC-3 | Jinja/dbt templates | Detected pre-parse → `language: "sql-jinja"`. Jinja stripped. DDL extracted from clean SQL. |
| EC-4 | Shell variable interpolation | `$VAR` and `${VAR}` treated as identifier characters by regex. May produce slightly wrong names (`$TABLE_NAME` as table name). Acceptable for v1 — rare pattern. |
| EC-5 | Multi-statement files | Regex iterates all matches globally. All `CREATE` statements extracted. |
| EC-6 | Large files (1000+ lines) | Regex is fast. `MAX_SOURCE_LENGTH = 5000` truncates individual symbol source. `analyze_schema` operates on parsed symbols, not raw source. |
| EC-7 | Mixed DDL + DML | Extractor only matches `CREATE` patterns. INSERT/UPDATE/DELETE/SELECT silently skipped. |
| EC-8 | Dialect-specific syntax | Regex patterns are permissive (PostgreSQL EXTENSION, MySQL ENGINE, etc. not matched → skipped). Core DDL extracted across dialects. |
| EC-9 | CREATE PROCEDURE/TRIGGER | Regex handles these directly (unlike tree-sitter which produces ERROR nodes). This is an advantage of the regex approach. |
| EC-10 | Syntax errors in user's SQL | Regex continues matching past errors. Partial extraction is the natural behavior. |
| EC-11 | Duplicate table names across files | Different `makeSymbolId()` (includes file path). `analyze_schema` reports duplicates as warnings. |
| EC-12 | Table referenced only via ORM | `trace_query` with `include_orm=true` checks Prisma/TypeORM/Drizzle. Warning if ORM detected but no model found. |
| EC-13 | Schema-qualified names (`public.orders`) | Regex captures the table name part after the dot. Schema prefix stored in signature. |
| EC-14 | Quoted identifiers (`"Order Items"`) | Regex pattern extended to match `"([^"]+)"` as identifier. Quotes stripped from symbol name. |
| EC-15 | Circular FK references | `analyze_schema` uses visited set. Reports circular FKs as findings, not errors. |
| EC-16 | Self-referencing tables | Detected and reported as `type: "self_reference"` in relationships. |

### Failure Modes

#### SQL regex extractor

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Regex misses a valid DDL construct (e.g., uncommon syntax variant) | Missing symbol in `get_file_outline` | Single file | Table/view not found in `search_symbols` | User reports; regex pattern expanded | Index missing symbols (no corruption) | Silent until user searches |
| Regex false-matches a non-DDL line as CREATE TABLE | Extra symbol in index | Single file | Phantom table in `analyze_schema` | Pattern tightened with anchor requirements | Extra symbol in index (no corruption) | Silent until user notices |
| Multi-line CREATE with unusual formatting breaks regex | Partial extraction | Single file | Some columns missing from signature | Pattern updated with multiline flag | Partial symbol (truncated, not corrupt) | Silent |

**Cost-benefit:** Frequency: occasional (~5% of files have unusual formatting) x Severity: low (missing symbols, no data loss) → Mitigation cost: trivial (regex pattern fixes) → **Decision: Accept for v1, iteratively fix patterns based on real-world usage.**

#### Jinja preprocessor (sql-jinja)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Jinja block removal destroys a valid CREATE TABLE statement | Missing symbol | Single file | Table not indexed from dbt model | Improve Jinja stripping to preserve DDL around blocks | Index gap | Silent |
| Nested Jinja (`{{ config({{ var }}) }}`) breaks regex strip | Incomplete strip → corrupted SQL → missed symbols | Single file | Garbled symbol name or missing symbol | Recursive Jinja strip or depth-aware parsing | Index gap or wrong name | Silent |
| Line number drift: removing `{% if %}...{% endif %}` blocks shifts subsequent lines | DDL after removed block reports wrong `start_line` in index | Single file, all symbols after the first removed block | User clicks "go to symbol" and lands on wrong line | Pass `originalSource` alongside stripped source; compute line numbers via line-offset mapping, not from stripped positions | Line numbers wrong, symbol content correct | Silent |

**Cost-benefit:** Frequency: occasional (dbt users ~10% of SQL users) x Severity: medium (degraded for dbt-heavy teams) → Mitigation cost: trivial (replace blocks with equivalent-length whitespace or maintain line-offset map) → **Decision: Mitigate -- replace Jinja blocks with newline-preserving whitespace so line numbers stay stable. Accept nested Jinja gaps for v1.**

#### analyze_schema tool

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| No `.sql` files in repo | `index.files.filter(f => f.language === "sql").length === 0` | Tool output | "No SQL files indexed in this repository" message | Clear informational message | Clean | Immediate |
| FK regex misses a REFERENCES clause (unusual formatting) | Missing relationship in output | Schema graph | Incomplete ERD — missing edge | FK regex pattern expanded | Partial graph | Silent until user inspects ERD |
| Circular FK causes infinite loop in graph traversal | Visited set prevents loop | None (prevented) | Circular FK reported as finding | N/A (handled) | Clean | Immediate |

**Cost-benefit:** Frequency: rare (circular FK) to occasional (missed FK regex) x Severity: low → Mitigation cost: trivial → **Decision: Mitigate with cycle detection (required), accept FK regex gaps for v1.**

#### trace_query tool

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Table only used via ORM (zero raw SQL refs) | `sql_references.length === 0 && orm_detected` | Tool output | Warning: "ORM detected. Raw SQL references not found does not mean table is unused." | ORM model cross-reference | Clean | Immediate (warning shown) |
| Table name is a common word ("users", "items") | High false-positive grep matches | Tool output | Noisy results with non-SQL matches | `file_pattern` scoping + word-boundary grep | Clean (just noisy) | Immediate |
| Table doesn't exist in index (typo or external DB) | `table_definition === null` | Tool output | "Table 'xyz' not found in indexed SQL files" | User corrects name | Clean | Immediate |
| ORM detection misidentifies framework | Wrong `orm` field in output | Tool output | "prisma" label on a Drizzle project | ORM detection heuristic improved | Cosmetic error | Silent |

**Cost-benefit:** Frequency: frequent (ORM-only is common) x Severity: medium (misleading "unused") → Mitigation cost: moderate (ORM detection) → **Decision: Mitigate ORM detection for Prisma + Drizzle in v1. TypeORM/Knex in v2.**

## Acceptance Criteria

### Ship criteria (must pass for release)

**Must have:**
1. `.sql` files appear in `get_file_tree` output
2. `.sql` files are searchable via `search_text`
3. `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX`, `CREATE FUNCTION`, `CREATE PROCEDURE`, `CREATE TRIGGER`, `CREATE SCHEMA`, `CREATE TYPE`, `CREATE SEQUENCE` extracted as symbols with correct SymbolKind
4. Column definitions extracted as `field` children of their parent table
5. Multi-statement SQL files extract all symbols (not just the first)
6. `search_symbols(kind="table")` returns only SQL tables
7. `get_file_outline` shows SQL symbols with correct line numbers
8. `find_references` finds SQL table names referenced in `.ts`/`.py`/`.go` files
9. `analyze_schema` returns clear message when no SQL files indexed
10. `trace_query` warns when ORM detected but zero raw SQL references found
11. `sql-jinja` files detected and handled without crashing the extractor

**Should have:**
1. `analyze_schema(output_format="mermaid")` generates valid erDiagram
2. `trace_query(include_orm=true)` detects Prisma and Drizzle model references
3. Schema-qualified names (`public.orders`) extract correct table name
4. Quoted identifiers (`"Order Items"`) handled correctly
5. Preceding SQL comments extracted as docstrings

**Edge case handling:**
1. Empty and comment-only `.sql` files produce zero symbols without crash
2. Circular and self-referencing FK relationships reported as findings, not errors
3. Duplicate table names across files produce warnings in `analyze_schema`
4. `complexity-tools.ts` skips SQL files (no meaningless CC=1 results)

### Success criteria (must pass for value validation)

1. **Extraction accuracy:** 100% of CREATE TABLE/VIEW/INDEX statements extracted from a 50-table reference schema (zero silent misses for supported constructs)
2. **Zero crashes:** No crashes on any SQL file in test corpus (empty, comment-only, Jinja, large 1000+ lines, multi-statement, mixed DDL/DML)
3. **Search quality:** `search_symbols(query="orders", kind="table")` returns the correct table on the first result for a 50-table schema
4. **Cross-language trace:** `trace_query` correctly identifies all raw SQL files that reference a given table name in a mixed TS+SQL codebase
5. **Performance (CI-gated):** Index time for 100 SQL files (avg 200 lines of DDL) < **8 seconds on GitHub Actions `ubuntu-latest`** (primary gate). Informational local target: < 5 seconds on MacBook M2. CI is the enforceable gate -- the M2 number is recorded for developer signal only.
6. **Validation method:** Automated test suite with reference SQL corpus covering all DDL types, edge cases, and a realistic multi-framework project (Prisma + raw SQL + dbt)

## Validation Methodology

Each success criterion maps to a concrete, mechanically-runnable validation step. All validation lives in `tests/` and runs via `vitest`.

| # | Criterion | Validation | Measurable Output |
|---|-----------|------------|-------------------|
| 1 | Extraction accuracy: 100% of CREATE TABLE/VIEW/INDEX on 50-table schema | Test file `tests/parser/extractors/sql.test.ts` loads fixture `tests/fixtures/sql/reference-schema.sql` (50 tables, 10 views, 20 indexes) with an accompanying `reference-schema.expected.json` manifest listing exact expected symbol names, kinds, and start lines. Asserts `extractSqlSymbols()` output matches the manifest exactly -- name-for-name, not `>=` counts. Any extra or missing symbol fails the test. | Exact name/kind/line match per manifest -- pass/fail |
| 2 | Zero crashes on edge case corpus | Test `tests/parser/extractors/sql-edge-cases.test.ts` iterates fixtures in `tests/fixtures/sql/edge-cases/`: `empty.sql`, `comment-only.sql`, `jinja-dbt.sql`, `large-1000-lines.sql`, `multi-statement.sql`, `mixed-ddl-dml.sql`, `syntax-error.sql`, `circular-fk.sql`. For each, asserts `extractSqlSymbols()` does not throw and returns a `CodeSymbol[]`. | Boolean pass/fail per fixture |
| 3 | Search quality: `search_symbols(query="orders", kind="table")` returns correct table first | Test `tests/tools/sql-search.test.ts` indexes fixture `tests/fixtures/sql/reference-schema.sql`, calls `searchSymbols({ query: "orders", kind: "table" })`, asserts first result has `name === "orders"`. | First-result match -- pass/fail |
| 4 | Cross-language trace correctness | Test `tests/tools/trace-query.test.ts` indexes fixture `tests/fixtures/sql/mixed-project/` containing at minimum: 2 `.sql` files with `CREATE TABLE orders` and `ALTER TABLE orders`, 2 `.ts` files containing raw SQL strings `"SELECT * FROM orders"` and `"DELETE FROM orders"`, 1 `schema.prisma` with `model Order { @@map("orders") }`. Calls `traceQuery({ table: "orders", include_orm: true })`. Asserts: `sql_references.length >= 3` (DDL + ALTER + at least one DML), `orm_references.length >= 1` (Prisma model), no warnings about missing ORM. | Count assertions -- pass/fail |
| 5 | Performance: 100 SQL files < 8s CI | Benchmark test `tests/perf/sql-index.bench.ts` (vitest bench mode) generates fixture `tests/fixtures/sql/corpus-100/` programmatically (100 files × ~200 lines of DDL). Runs `indexFolder()` on it, asserts `elapsed_ms < 8000`. **Enforced in GitHub Actions on `ubuntu-latest`** (the CI gate). Local developer runs on M2 should see ~3-5s; any CI run > 8s fails the PR. | Milliseconds measurement -- pass/fail vs 8000ms CI threshold |
| 6 | Multi-framework corpus coverage | Test `tests/integration/sql-multi-framework.test.ts` exercises: regex DDL extraction, Jinja preprocessing on dbt file, analyze_schema ERD generation, trace_query ORM detection. All four in one integration test on a single fixture project. | Boolean pass/fail |

**Regression safety:** All validation tests run in CI on every PR. Performance benchmark runs on main branch with history tracking via vitest's `--reporter=json` output.

**Fixture creation:** Fixtures in `tests/fixtures/sql/` must be committed to the repo. The `corpus-100/` fixture may be generated at test time to keep the repo small -- if so, generation must be deterministic (seeded) and reproducible.

## Rollback Strategy

**Kill switch:** Remove `".sql": "sql"` from `EXTENSION_MAP` in `parser-manager.ts`. This single line change makes `.sql` files invisible to the indexer again — no symbols extracted, no SQL content appears in search results.

**Tool behavior after rollback:** `analyze_schema` and `trace_query` tools remain registered and discoverable. When called after rollback:
- `analyze_schema` returns the "no SQL files indexed" informational message (zero tables found in the index).
- `trace_query` returns `table_definition: null` and zero references, with a warning: "No SQL files indexed. If SQL support was disabled, this is expected."

To fully unregister the tools (e.g., a permanent revert), remove their entries from `TOOL_DEFINITIONS` in `register-tools.ts` -- this is a larger code revert, not a kill switch.

**Fallback behavior:** With `.sql` removed from `EXTENSION_MAP`, `.sql` files revert to being completely unindexed (current behavior). No data loss — the index simply excludes SQL symbols on next reindex.

**Data preservation:** No persistent state beyond the in-memory index. Removing SQL support requires no migration or cleanup. `index_file` / `index_folder` rebuild cleanly.

## Backward Compatibility

**SymbolKind union expansion:** Adding `table`, `view`, `index`, `trigger`, `procedure` is additive. Existing code that switches on SymbolKind will hit `default` branches for new kinds. No existing functionality breaks.

**Index format:** `CodeIndex` structure is unchanged. SQL symbols are `CodeSymbol` entries with new `kind` values. Older index snapshots (if persisted) simply lack SQL symbols — they don't break.

**Tool count:** Increases from 72 to 74 (2 new hidden tools: `analyze_schema`, `trace_query`). `discover_tools` and `describe_tools` automatically discover them. No change to existing 36 core tools.

**PARSER_LANGUAGES array:** Adding `"sql"` is additive. `get_extractor_versions` includes it in the response. No breaking change.

## Out of Scope

### Deferred to v2

- **`lint_schema`** — SQL schema linting (anti-patterns like missing FK indexes, unbounded VARCHAR). Requires suppression mechanism and conservative rule set to avoid false-positive trust erosion.
- **`diff_migrations`** — Migration diff analysis with destructive operation detection. Requires robust migration file ordering heuristic (numeric, timestamp, mixed).
- **tree-sitter-sql upgrade** — Replace regex extractor with tree-sitter AST for richer expression analysis (query complexity, column type inference). Blocked on WASM packaging.
- **dbt context provider** — Full dbt model parsing (`dbt_project.yml`, `schema.yml`, `{{ doc() }}` refs). jCodeMunch has this; low priority unless data engineering segment is targeted.
- **`search_columns` tool** — Dedicated column name search across all tables. Can be approximated with `search_symbols(kind="field")` in v1.
- **SQL-specific `search_patterns`** — Built-in patterns like `unbounded-select`, `missing-where-on-update`, `implicit-type-cast`.
- **`trace_route` extension** — Extend route tracing to include SQL table as the terminal node (route → handler → service → table).
- **ORM schema drift detection** — Compare Prisma/TypeORM model definitions against SQL table definitions and report mismatches.

### Permanently out of scope

- **Dialect-specific grammars** — No BigQuery, PL/pgSQL, T-SQL specific parsers. The regex extractor is dialect-agnostic for DDL.
- **SQL query execution** — CodeSift does not connect to databases. All analysis is static (source code only).
- **SQL formatting/linting** — Not a formatter. Use sqlfluff/sqlfmt for that.
- **Database migration generation** — Not an ORM. Use Prisma/Knex/Flyway for that.

## Open Questions

None -- all questions resolved in Phase 2 design dialogue.
