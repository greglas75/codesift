# Implementation Plan: SQL Language Support

**Spec:** docs/specs/2026-04-11-sql-support-spec.md
**spec_id:** 2026-04-11-sql-support-2006
**planning_mode:** spec-driven
**plan_revision:** 2
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 17
**Estimated complexity:** 13 standard, 4 complex

## Architecture Summary

**Integration point:** The SQL extractor plugs into the existing Prisma/Markdown non-tree-sitter pattern in `src/tools/index-tools.ts:parseOneFile()`. It bypasses `src/parser/symbol-extractor.ts` (the tree-sitter dispatch switch) entirely — same architecture as `extractPrismaSymbols`, `extractMarkdownSymbols`, `extractAstroSymbols`.

**Data flow:**
```
.sql file → parser-manager.EXTENSION_MAP (".sql" → "sql")
         → index-tools.parseOneFile() detects language
         → if source contains {{ or {% → language becomes "sql-jinja"
         → extractSqlSymbols(stripJinjaTokens(source), relPath, repo)  // sql-jinja
         → extractSqlSymbols(source, relPath, repo)                    // plain sql
         → CodeSymbol[] with kinds: table, view, index, trigger, procedure, function, namespace, type, field
         → stored in CodeIndex.symbols, indexed by BM25 + search tools
```

**New components:**
- `src/parser/extractors/sql.ts` — `extractSqlSymbols()` + `stripJinjaTokens()` (regex-based, ~300 lines)
- `src/tools/sql-tools.ts` — `analyzeSchema()` + `traceQuery()` (new analysis tools, ~400 lines)
- `tests/parser/extractors/sql.test.ts` — extractor unit tests
- `tests/parser/extractors/sql-edge-cases.test.ts` — edge case suite
- `tests/tools/sql-tools.test.ts` — tool tests
- `tests/fixtures/sql/reference-schema.sql` — 50-table reference fixture
- `tests/fixtures/sql/reference-schema.expected.json` — exact symbol manifest
- `tests/fixtures/sql/edge-cases/` — empty, comment-only, jinja, mixed, etc.
- `tests/fixtures/sql/mixed-project/` — cross-language fixture for trace_query

**Modified components:**
- `src/types.ts` — add 5 new SymbolKinds
- `src/parser/parser-manager.ts` — add `.sql` → `"sql"` to EXTENSION_MAP
- `src/tools/index-tools.ts` — add sql/sql-jinja branches in parseOneFile
- `src/tools/project-tools.ts` — add `"sql"` and `"sql-jinja"` to PARSER_LANGUAGES
- `src/tools/search-ranker.ts` — add SQL SymbolKind bonuses to LABEL_BONUS
- `src/tools/complexity-tools.ts` — skip SQL files in complexity analysis
- `src/register-tools.ts` — register analyze_schema + trace_query in TOOL_DEFINITIONS

## Technical Decisions

**Regex extractor (not tree-sitter)** — Zero new deps, no WASM ABI risk, handles CREATE PROCEDURE/TRIGGER natively (tree-sitter-sql produces ERROR nodes on those). Follows existing Prisma pattern.

**New SymbolKinds** — `table`, `view`, `index`, `trigger`, `procedure` added to `SymbolKind` union. Clean `search_symbols(kind="table")` semantics. Cost: ~10 callsites updated.

**sql-jinja as separate language variant** — Detected pre-parse by `{{`, `{%`, `{#` markers. Routed to `stripJinjaTokens` → same `extractSqlSymbols`. Jinja stripped with newline-preserving whitespace so line numbers stay stable.

**Hidden tools (discoverable only)** — `analyze_schema` and `trace_query` not added to `CORE_TOOL_NAMES`. Follows existing pattern for domain-specific tools.

**Reuse existing SymbolKinds where semantic:**
- `namespace` for CREATE SCHEMA (existing)
- `type` for CREATE TYPE (existing)
- `variable` for CREATE SEQUENCE (existing — sequences are value generators)
- `function` for CREATE FUNCTION (existing — SQL functions are like code functions)
- `function` for CTEs (existing — already used for similar "named query" concepts)
- `field` for columns (existing — already used for class fields)

## Quality Strategy

**Test framework:** Vitest (existing). Test command: `npx vitest run`.

**Fixture strategy:** Deterministic reference schema (50 tables, 10 views, 20 indexes) with exact-match manifest `reference-schema.expected.json`. Edge cases in separate `edge-cases/` subdirectory, one scenario per file.

**Critical CQ gates to watch:**
- **CQ3** (validation): All tools validate inputs — non-empty table name, repo exists
- **CQ8** (errors): No empty catches; all regex failures logged; graceful fallback on malformed SQL
- **CQ10** (null guards): `.find()` + null check on index lookups
- **CQ11** (file size): Extractor stays under 300 lines; tool file under 300 lines
- **CQ14** (no duplication): Shared regex patterns extracted to constants

**Critical Q gates:**
- **Q7** (error paths tested): Every throw in tools has a test
- **Q11** (branch coverage): Every regex branch, every SymbolKind mapping
- **Q13** (real imports): Tests import from production, not local copies
- **Q17** (computed output): Expected values from spec/fixture, not copied from implementation

**Risk areas:**
1. **Regex patterns** — greedy matching, line continuation, multi-statement boundaries. Mitigation: exact-match fixture tests.
2. **Jinja stripping + line numbers** — must preserve newlines. Mitigation: dedicated test asserting line numbers after Jinja removal.
3. **analyze_schema cycle detection** — circular FK infinite loop. Mitigation: visited set + dedicated circular-fk fixture test.
4. **trace_query noise** — common names produce thousands of matches. Mitigation: `max_references` hard cap + truncation warning.

## Task Breakdown

### Task 1: Extend SymbolKind union with SQL types
**Files:**
- `src/types.ts`

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add a type-level test in `tests/types.test.ts` (or inline type assertion) that imports `SymbolKind` and asserts `"table" | "view" | "index" | "trigger" | "procedure"` are all assignable. TypeScript compile must fail before the change.
- [ ] GREEN: Add `"table" | "view" | "index" | "trigger" | "procedure"` to the `SymbolKind` union in `src/types.ts`. No other changes — downstream switches will hit `default` branches which is fine for now.
- [ ] Verify: `npx vitest run` — all existing tests still pass (should be unchanged since no logic depends on these new values yet). `npx tsc --noEmit` — no type errors.
  Expected: vitest "0 failed"; tsc exit code 0.
- [ ] Acceptance: Ship criterion #3 (new SymbolKinds in union); backward compat statement (additive SymbolKind expansion).
- [ ] Commit: `feat(types): add SQL-specific SymbolKinds (table/view/index/trigger/procedure)`

---

### Task 2: Add .sql to EXTENSION_MAP
**Files:**
- `src/parser/parser-manager.ts`
- `tests/parser/parser-manager.test.ts` (existing — extend)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add test in `tests/parser/parser-manager.test.ts`: `expect(getLanguageForExtension(".sql")).toBe("sql")`. Test must fail (currently returns null/undefined).
- [ ] GREEN: Add `".sql": "sql"` entry to `EXTENSION_MAP` in `src/parser/parser-manager.ts`. Place alphabetically near `.rs` or at the end of the data-language block.
- [ ] Verify: `npx vitest run tests/parser/parser-manager.test.ts`
  Expected: new test passes; no regressions.
- [ ] Acceptance: Ship criterion #1 (`.sql` files appear in `get_file_tree`).
- [ ] Commit: `feat(parser): register .sql extension as "sql" language`

---

### Task 3: Create sql extractor with basic CREATE TABLE support
**Files:**
- `src/parser/extractors/sql.ts` (new)
- `tests/parser/extractors/sql.test.ts` (new)
- `tests/fixtures/sql/basic-table.sql` (new)

**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: Write test in `tests/parser/extractors/sql.test.ts`:
  - Fixture `basic-table.sql` contains a single `CREATE TABLE orders (id INT PRIMARY KEY);`
  - Test asserts: `extractSqlSymbols(source, "test.sql", "repo")` returns array with one symbol where `name === "orders"`, `kind === "table"`, `start_line === 1`, `end_line >= 1`.
- [ ] GREEN: Create `src/parser/extractors/sql.ts` with:
  - `extractSqlSymbols(source: string, filePath: string, repo: string, originalSource?: string): CodeSymbol[]` -- 4th arg is used when source has been Jinja-stripped; the extractor uses `source` for parsing/line numbers (line-preserving strip guarantees identity) but reads symbol `source` field ranges from `originalSource ?? source` so displayed source contains the real Jinja tokens, not placeholders.
  - Import `CodeSymbol` from `../../types.js`, `tokenizeIdentifier` + `makeSymbolId` from `../symbol-extractor.js`
  - Regex for `CREATE TABLE`: `/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s*\(/gim`
  - Extract name (prefer group 2, fall back to group 1.group 2), compute start_line by counting newlines before match index
  - Scan forward for matching closing `)` with depth tracking; end_line = line of closing paren
  - Build CodeSymbol with `kind: "table"`, source truncated at 5000 chars
- [ ] Verify: `npx vitest run tests/parser/extractors/sql.test.ts`
  Expected: test passes.
- [ ] Acceptance: Ship criterion #3 (CREATE TABLE extracted).
- [ ] Commit: `feat(sql): extract CREATE TABLE symbols via regex`

---

### Task 4: Extend sql extractor for VIEW, INDEX, FUNCTION, PROCEDURE, TRIGGER, SCHEMA, TYPE, SEQUENCE
**Files:**
- `src/parser/extractors/sql.ts`
- `tests/parser/extractors/sql.test.ts`
- `tests/fixtures/sql/all-ddl.sql` (new)

**Complexity:** complex
**Dependencies:** Task 3
**Execution routing:** deep implementation tier

- [ ] RED: Add test case loading `all-ddl.sql` containing one of each: `CREATE VIEW`, `CREATE MATERIALIZED VIEW`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `CREATE FUNCTION`, `CREATE PROCEDURE`, `CREATE TRIGGER`, `CREATE SCHEMA`, `CREATE TYPE`, `CREATE SEQUENCE`. Assert the extractor returns exactly 10 symbols with correct `kind` for each (`view`, `view`, `index`, `index`, `function`, `procedure`, `trigger`, `namespace`, `type`, `variable`).
- [ ] GREEN: Add regex patterns to `sql.ts` for each construct. Use a `PATTERNS` array of `{ regex, kind }` pairs to avoid duplicated match logic:
  ```typescript
  const PATTERNS: Array<{ regex: RegExp; kind: SymbolKind }> = [
    { regex: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)/gim, kind: "table" },
    { regex: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:\w+\.)?(\w+)/gim, kind: "view" },
    // ...
  ];
  ```
  Iterate all patterns over the source, collect matches with start_line computed from match index, dedupe by (name, startLine) if needed.
- [ ] Verify: `npx vitest run tests/parser/extractors/sql.test.ts`
  Expected: all-ddl test passes; 10 symbols extracted with correct kinds.
- [ ] Acceptance: Ship criterion #3 (all DDL constructs extracted with correct SymbolKind).
- [ ] Commit: `feat(sql): extract VIEW/INDEX/FUNCTION/PROCEDURE/TRIGGER/SCHEMA/TYPE/SEQUENCE`

---

### Task 5: Extract column definitions as field children of tables
**Files:**
- `src/parser/extractors/sql.ts`
- `tests/parser/extractors/sql.test.ts`
- `tests/fixtures/sql/columns.sql` (new)

**Complexity:** standard
**Dependencies:** Task 4

- [ ] RED: Fixture `columns.sql`: `CREATE TABLE orders (id INT PRIMARY KEY, user_id INT REFERENCES users(id), total INT);`. Test asserts output includes 4 symbols: 1 table + 3 field children. Find the table symbol (`kind === "table"`, `name === "orders"`), then assert each field has `parent === tableSymbol.id` (the parent table's full symbol id string, e.g., `"repo:test.sql:orders:1"`), `kind === "field"`, names `["id", "user_id", "total"]`, and line numbers matching the source.
- [ ] GREEN: In the TABLE branch, after finding the body `(...)`, split on top-level commas (respecting parens depth), parse each segment as `^\s*(\w+)\s+(\S+)` to extract column name + type. Build field symbol with `parent` pointing to the table's `id`, `signature` set to the type declaration. Skip constraint lines (`PRIMARY KEY (...)`, `FOREIGN KEY (...)`, `CONSTRAINT name ...`).
- [ ] Verify: `npx vitest run tests/parser/extractors/sql.test.ts`
  Expected: columns test passes.
- [ ] Acceptance: Ship criterion #4 (column definitions as field children).
- [ ] Commit: `feat(sql): extract column definitions as field children of tables`

---

### Task 6: Add stripJinjaTokens with line-preserving whitespace
**Files:**
- `src/parser/extractors/sql.ts`
- `tests/parser/extractors/sql.test.ts`
- `tests/fixtures/sql/jinja-model.sql` (new)

**Complexity:** standard
**Dependencies:** Task 5

- [ ] RED: Three tests:
  1. `stripJinjaTokens("SELECT {{ ref('x') }} FROM a")` returns `"SELECT              FROM a"` (same length, Jinja replaced with spaces).
  2. `stripJinjaTokens("{% if x %}\nCREATE TABLE foo (id INT);\n{% endif %}")` → `"          \nCREATE TABLE foo (id INT);\n          "` (newlines preserved).
  3. `extractSqlSymbols(stripJinjaTokens(jinjaModelSource), ...)` finds `foo` table at the original `start_line` of 2.
- [ ] GREEN: Add to `sql.ts`:
  ```typescript
  export function stripJinjaTokens(source: string): string {
    const preserveLines = (match: string) => match.replace(/[^\n]/g, ' ');
    return source
      .replace(/\{#[\s\S]*?#\}/g, preserveLines)
      .replace(/\{%[\s\S]*?%\}/g, preserveLines)
      .replace(/\{\{[\s\S]*?\}\}/g, preserveLines);
  }
  ```
- [ ] Verify: `npx vitest run tests/parser/extractors/sql.test.ts`
  Expected: all 3 Jinja tests pass.
- [ ] Acceptance: Should-have #2 (Jinja files handled), failure mode mitigation for line drift.
- [ ] Commit: `feat(sql): add Jinja preprocessor with line-preserving strip`

---

### Task 7: Wire sql extractor into parseOneFile with sql-jinja detection
**Files:**
- `src/tools/index-tools.ts`
- `src/tools/project-tools.ts`
- `tests/integration/index-folder.test.ts` (existing — extend)

**Complexity:** standard
**Dependencies:** Task 2, Task 6

- [ ] RED: Extend `tests/integration/index-folder.test.ts` with new test cases: create temp dir with `schema.sql` (plain CREATE TABLE) and `model.sql` (with `{{ ref('x') }}` + CREATE TABLE). Call `indexFolder(tmpDir)`. Assert the index contains both files, each with one table symbol, correct line numbers in the Jinja file. Assert `FileEntry.language === "sql"` for the plain file and `"sql-jinja"` for the Jinja file.
- [ ] GREEN:
  - In `src/tools/index-tools.ts:parseOneFile()`, introduce a mutable `effectiveLanguage = language` and add branches **before** the final tree-sitter `else`:
    ```typescript
    } else if (language === "sql") {
      const hasJinja = /\{\{|\{%|\{#/.test(source);
      if (hasJinja) {
        const stripped = stripJinjaTokens(source);
        symbols = extractSqlSymbols(stripped, relPath, repoName, source);  // pass originalSource
        effectiveLanguage = "sql-jinja";
      } else {
        symbols = extractSqlSymbols(source, relPath, repoName);
      }
    }
    ```
  - Use `effectiveLanguage` instead of `language` in the FileEntry construction at the end of `parseOneFile()`.
  - Import `extractSqlSymbols` and `stripJinjaTokens` from `../parser/extractors/sql.js`
  - Add `"sql"` and `"sql-jinja"` to `PARSER_LANGUAGES` in `project-tools.ts`
- [ ] Verify: `npx vitest run tests/tools/index-tools.test.ts tests/parser/extractors/sql.test.ts`
  Expected: integration test passes; no regressions.
- [ ] Acceptance: Ship criteria #1, #2, #3, #11 (sql-jinja files detected and handled).
- [ ] Commit: `feat(sql): wire extractor into indexer with sql-jinja detection`

---

### Task 8: Update search-ranker LABEL_BONUS + complexity-tools SQL guard
**Files:**
- `src/tools/search-ranker.ts`
- `src/tools/complexity-tools.ts`
- `tests/tools/search-ranker.test.ts` (existing — extend)
- `tests/tools/complexity-tools.test.ts` (existing — extend)

**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: Two tests:
  1. search-ranker: a TextMatch inside a `kind: "table"` symbol gets a `score` higher than `DEFAULT_LABEL_BONUS (0.3)`. Directly assert `LABEL_BONUS.table === 1.0`, `LABEL_BONUS.view === 0.8`, etc.
  2. complexity-tools: verify the SQL-file-level guard is in place. Build a mock CodeIndex with one SQL file containing a `function` symbol (e.g., a stored function). Without the guard, a `kind: "function"` SQL symbol would pass `ANALYZABLE_KINDS`. Assert `analyzeComplexity` returns zero entries for that SQL function, proving the language-level guard (not just the kind filter) is active.
- [ ] GREEN:
  - `search-ranker.ts`: Extend `LABEL_BONUS` with: `table: 1.0, view: 0.8, trigger: 0.6, procedure: 0.7, index: 0.5`.
  - `complexity-tools.ts`: At the start of `analyzeComplexity`, filter out symbols from files where `language === "sql" || language === "sql-jinja"`. Guard needs to look up `index.files` for the language of each symbol's file.
- [ ] Verify: `npx vitest run tests/tools/search-ranker.test.ts tests/tools/complexity-tools.test.ts`
  Expected: both new tests pass; no regressions.
- [ ] Acceptance: Edge case handling #4 (complexity skips SQL), BACKLOG-3 resolved.
- [ ] Commit: `feat(ranker): boost SQL SymbolKinds + skip SQL in complexity analysis`

---

### Task 9: Author edge-case fixtures
**Files:**
- `tests/fixtures/sql/edge-cases/empty.sql` (new, 0 bytes)
- `tests/fixtures/sql/edge-cases/comment-only.sql` (new, only `--` comments)
- `tests/fixtures/sql/edge-cases/multi-statement.sql` (new, 5+ CREATE TABLEs)
- `tests/fixtures/sql/edge-cases/mixed-ddl-dml.sql` (new, CREATE TABLE + INSERT + SELECT)
- `tests/fixtures/sql/edge-cases/circular-fk.sql` (new, two tables with mutual FKs)
- `tests/fixtures/sql/edge-cases/syntax-error.sql` (new, intentionally malformed)

**Complexity:** standard
**Dependencies:** Task 5

- [ ] RED: Write `tests/parser/extractors/sql-edge-cases.test.ts` with parametrized assertions: empty → `[]`, comment-only → `[]`, multi-statement → N symbols, mixed-ddl-dml → only DDL symbols, circular-fk → at least 2 table symbols, syntax-error → does not throw. Tests fail because fixtures do not exist.
- [ ] GREEN: Author each fixture file. No production code changes in this task -- just fixtures and the test skeleton iterating them.
- [ ] Verify: `npx vitest run tests/parser/extractors/sql-edge-cases.test.ts`
  Expected: all tests pass (or surface extractor bugs to fix in Task 10).
- [ ] Acceptance: Success criterion #2 (zero crashes on edge cases).
- [ ] Commit: `test(sql): edge case fixtures and parametrized test suite`

---

### Task 10: Reference schema fixture + exact-match manifest
**Files:**
- `tests/fixtures/sql/reference-schema.sql` (new, ~400-500 lines)
- `tests/fixtures/sql/reference-schema.expected.json` (new)
- `tests/parser/extractors/sql-reference.test.ts` (new)

**Complexity:** complex
**Dependencies:** Task 9
**Execution routing:** deep implementation tier

- [ ] RED: Write test in `tests/parser/extractors/sql-reference.test.ts`: load both files, call `extractSqlSymbols` on the SQL, assert the output matches `reference-schema.expected.json` exactly (compare name, kind, start_line per symbol). Test fails because files do not exist yet.
- [ ] GREEN:
  - Author `reference-schema.sql` with exactly 50 tables, 10 views, 20 indexes. Realistic e-commerce/SaaS shapes with FK relationships.
  - Generate `reference-schema.expected.json` by running the extractor output through a one-off script or manual copy. Each entry: `{"name": string, "kind": string, "start_line": number}`.
  - Freeze the manifest as the contract -- any future extractor change that breaks this fails the test.
- [ ] Verify: `npx vitest run tests/parser/extractors/sql-reference.test.ts`
  Expected: 80 symbols match the manifest exactly.
- [ ] Acceptance: Success criterion #1 (100% extraction accuracy on reference schema).
- [ ] Commit: `test(sql): reference-schema fixture with exact-match manifest`

---

### Task 11: Extractor bug-fix pass (if edge cases or reference schema surfaced issues)
**Files:**
- `src/parser/extractors/sql.ts` (modify based on findings)
- Any failing tests from Task 9/10

**Complexity:** standard
**Dependencies:** Task 10

- [ ] RED: Any failing assertions from Task 9 or Task 10 serve as RED.
- [ ] GREEN: Fix regex patterns, column parsing, or edge case handling to make all tests pass. No new behavior -- only bug fixes.
- [ ] Verify: `npx vitest run tests/parser/extractors/`
  Expected: all SQL extractor tests green.
- [ ] Acceptance: Success criterion #1 + #2 fully met.
- [ ] Commit: `fix(sql): extractor fixes surfaced by reference + edge case suites`

  **Note:** If all Task 9 + 10 tests pass without changes, skip this task (mark as completed with message "no fixes needed").

---

### Task 12: Implement analyzeSchema tool
**Files:**
- `src/tools/sql-tools.ts` (new)
- `tests/tools/sql-tools.test.ts` (new)
- `tests/fixtures/sql/e-commerce-schema.sql` (new, smaller schema with FKs)

**Complexity:** complex
**Dependencies:** Task 11
**Execution routing:** deep implementation tier

- [ ] RED: Tests for `analyzeSchema`:
  1. On a fixture with 5 tables and 3 FK relationships, returns matching `tables`, `relationships`, correct counts.
  2. On an empty repo (no `.sql` files), returns `tables: []` with a warning "No SQL files indexed in this repository".
  3. On a repo with missing index (`getCodeIndex(repo)` returns null), throws `Error("Repository 'X' not found. Run index_folder first.")`.
  4. On circular FK fixture, returns the cycle in `warnings` without infinite loop.
  5. `output_format: "mermaid"` returns a `mermaid` string containing `erDiagram`.
- [ ] GREEN: Create `src/tools/sql-tools.ts`:
  - `analyzeSchema(repo: string, options?: AnalyzeSchemaOptions): Promise<SchemaAnalysisResult>`
  - Read `getCodeIndex(repo)` from `../storage/index.js` (check existing import path via grep); throw if null
  - Filter `index.symbols` by `kind === "table" | "view"`
  - For each table, re-parse its source field for `REFERENCES (\w+)\s*\((\w+)\)` patterns to build relationships
  - Cycle detection: build adjacency map, DFS with visited set
  - Mermaid output: iterate tables as `erDiagram` entities, relationships as lines
  - Error path: `if (!index) throw new Error("Repository '${repo}' not found. Run index_folder first.")`
- [ ] Verify: `npx vitest run tests/tools/sql-tools.test.ts`
  Expected: all 5 analyzeSchema tests pass.
- [ ] Acceptance: Ship criteria (analyze_schema returns message on empty), Should-have #1 (mermaid output), Edge cases #15, #16.
- [ ] Commit: `feat(sql): add analyze_schema tool with ERD and cycle detection`

---

### Task 13: Implement traceQuery tool
**Files:**
- `src/tools/sql-tools.ts`
- `tests/tools/sql-tools.test.ts`
- `tests/fixtures/sql/mixed-project/schema.sql` (new)
- `tests/fixtures/sql/mixed-project/migration.sql` (new)
- `tests/fixtures/sql/mixed-project/app.ts` (new)
- `tests/fixtures/sql/mixed-project/schema.prisma` (new)

**Complexity:** complex
**Dependencies:** Task 12
**Execution routing:** deep implementation tier

- [ ] RED: Tests for `traceQuery`:
  1. Mixed project fixture: `traceQuery(repo, { table: "orders", include_orm: true })` returns `table_definition` from `schema.sql`, at least 2 `sql_references` (ALTER in migration.sql + DML in app.ts if embedded), and 1 `orm_references` (Prisma `Order` model).
  2. Empty table param throws `"table parameter is required"`.
  3. Missing repo throws `"Repository 'X' not found."`
  4. `max_references: 2` on a fixture with 5 matches returns `truncated: true` and a warning.
  5. `file_pattern: "*.ts"` limits hits to `.ts` files.
- [ ] GREEN: Add to `src/tools/sql-tools.ts`:
  - `traceQuery(repo: string, options: TraceQueryOptions): Promise<TraceQueryResult>`
  - Validate `options.table` non-empty
  - Look up table def in `index.symbols`
  - Use ripgrep via existing search infrastructure (check `src/tools/search-tools.ts` for the ripgrep helper — likely `searchText` function) with word-boundary pattern `\b<table>\b`
  - Pass `file_pattern` through to search
  - Cap results at `max_references ?? 500`; set `truncated: true` if exceeded
  - Classify hits by regex: `ALTER\s+TABLE` → ddl, `SELECT|INSERT|UPDATE|DELETE\s+FROM` → dml, `REFERENCES` → fk, else dml
  - ORM detection: look for `schema.prisma` file (check `index.files`). If found, grep it for `@@map\("<table>"\)` or model name matching table (case-insensitive); add hits as `orm: "prisma"`. Similarly for Drizzle `pgTable("<table>"`.
- [ ] Verify: `npx vitest run tests/tools/sql-tools.test.ts`
  Expected: all traceQuery tests pass.
- [ ] Acceptance: Ship criterion #10 (ORM warning), Should-have #2 (Prisma+Drizzle detection), Success criterion #4 (cross-language trace).
- [ ] Commit: `feat(sql): add trace_query tool with ORM detection`

---

### Task 14: Register analyze_schema and trace_query in TOOL_DEFINITIONS
**Files:**
- `src/register-tools.ts`
- `tests/integration/tools.test.ts` (existing — extend)

**Complexity:** standard
**Dependencies:** Task 13

- [ ] RED: Integration test: call `discover_tools({ query: "SQL schema" })` — expect result includes `analyze_schema` and `trace_query`. Call `describe_tools({ names: ["analyze_schema"] })` — expect schema shape returned.
- [ ] GREEN: In `src/register-tools.ts`, add two entries to `TOOL_DEFINITIONS`:
  ```typescript
  {
    name: "analyze_schema",
    category: "analysis",
    searchHint: "SQL schema ERD entity relationship tables views database",
    description: "Analyze SQL schema: tables, views, columns, foreign keys, relationships. Output as JSON or Mermaid ERD.",
    schema: {
      repo: z.string().optional(),
      file_pattern: z.string().optional(),
      output_format: z.enum(["json", "mermaid"]).optional(),
      include_columns: z.boolean().optional(),
    },
    handler: async (args) => analyzeSchema(args.repo as string, { ... }),
  },
  {
    name: "trace_query",
    category: "analysis",
    searchHint: "SQL table query trace references cross-language ORM Prisma Drizzle",
    description: "Trace SQL table references across the codebase: DDL, DML, FK, ORM models.",
    schema: {
      repo: z.string().optional(),
      table: z.string().describe("Table name to trace (required)"),
      include_orm: z.boolean().optional(),
      file_pattern: z.string().optional(),
      max_references: z.number().optional(),
    },
    handler: async (args) => traceQuery(args.repo as string, { ... }),
  },
  ```
  Do NOT add to `CORE_TOOL_NAMES` — these are hidden/discoverable.
- [ ] Verify: `npx vitest run tests/integration/tools.test.ts`
  Expected: new discover_tools assertions pass.
- [ ] Acceptance: Both tools registered, discoverable, not in core set. Tool count goes 72 → 74.
- [ ] Commit: `feat(sql): register analyze_schema and trace_query as hidden tools`

---

### Task 15: Search quality validation test
**Files:**
- `tests/tools/sql-search.test.ts` (new)

**Complexity:** standard
**Dependencies:** Task 10, Task 14

- [ ] RED: Write `tests/tools/sql-search.test.ts`: index a temp repo containing `tests/fixtures/sql/reference-schema.sql`, call `searchSymbols({ repo, query: "orders", kind: "table" })`. Assert: the first result has `name === "orders"` and `kind === "table"`. Also run `searchSymbols({ repo, query: "users", kind: "table" })` and assert the first result is the `users` table. Tests fail because the test file does not exist yet.
- [ ] GREEN: Implement the test. No production code changes needed -- this validates the search pipeline works end-to-end on SQL symbols. If the test reveals a bug (e.g., SQL symbols not being tokenized correctly for BM25), fix it as a sub-task.
- [ ] Verify: `npx vitest run tests/tools/sql-search.test.ts`
  Expected: both queries return the correct table as the first result.
- [ ] Acceptance: Success criterion #3 (search quality: first-result match).
- [ ] Commit: `test(sql): search quality validation on reference schema`

---

### Task 16: Multi-framework integration test
**Files:**
- `tests/integration/sql-multi-framework.test.ts` (new)

**Complexity:** standard
**Dependencies:** Task 13

- [ ] RED: Write `tests/integration/sql-multi-framework.test.ts` exercising all v1 SQL capabilities in a single end-to-end test on `tests/fixtures/sql/mixed-project/` (the fixture created in Task 13):
  1. Index the fixture directory.
  2. Assert plain SQL DDL extraction: `schema.sql` has `orders` table symbol.
  3. Assert Jinja preprocessing: create an additional `dbt-model.sql` in the test via temp file with `{{ ref('x') }} CREATE TABLE derived (id INT);`, re-index, assert the `derived` table is extracted.
  4. Call `analyzeSchema(repo, { output_format: "mermaid" })`, assert output contains `erDiagram` and at least 2 entities.
  5. Call `traceQuery(repo, { table: "orders", include_orm: true })`, assert `sql_references.length >= 2`, `orm_references.length >= 1`, ORM label is `"prisma"`.
- [ ] GREEN: Implement the test. Reuses existing fixtures from Task 13.
- [ ] Verify: `npx vitest run tests/integration/sql-multi-framework.test.ts`
  Expected: all 5 assertions pass in a single test run.
- [ ] Acceptance: Success criterion #6 (multi-framework corpus coverage in one integration test).
- [ ] Commit: `test(sql): multi-framework integration test (DDL + Jinja + analyze + trace)`

---

### Task 17: Performance benchmark (CI-gated)
**Files:**
- `tests/perf/sql-index.bench.ts` (new)
- `tests/perf/generate-sql-corpus.ts` (new — deterministic fixture generator)

**Complexity:** standard
**Dependencies:** Task 14

- [ ] RED: Write `tests/perf/sql-index.bench.ts` using vitest bench mode (or regular `test` with `performance.now()` if bench mode unavailable):
  1. Call `generateSqlCorpus(100, seed=42)` to produce 100 SQL files (~200 lines each) in a temp directory.
  2. Start timer, call `indexFolder(tmpDir)`, stop timer.
  3. Assert `elapsed_ms < 8000` (CI threshold from spec).
  Test fails because benchmark file does not exist.
- [ ] GREEN:
  - Create `tests/perf/generate-sql-corpus.ts` with a deterministic (seeded) generator function producing 100 realistic SQL files. Each file has ~5 tables, ~2 views, ~3 indexes using generated names (`table_0001` through `table_0500`) -- total ~500 tables across the corpus. Use a simple linear-congruential seeded PRNG to ensure reproducibility.
  - Create `tests/perf/sql-index.bench.ts` as described in RED.
  - Note: if this test is flaky in local CI due to machine variance, it will be enforced only in GitHub Actions on `ubuntu-latest`. Document this in a comment at the top of the bench file.
- [ ] Verify: `npx vitest run tests/perf/sql-index.bench.ts`
  Expected: indexFolder completes in under 8000ms locally (should be ~3-5s on M2, ~6-7s on ubuntu-latest).
- [ ] Acceptance: Success criterion #5 (performance: 100 SQL files < 8s CI).
- [ ] Commit: `test(sql): performance benchmark for 100-file corpus (CI gate < 8s)`

---

## Out-of-scope tasks (not in v1)

- `lint_schema` tool → deferred to v2
- `diff_migrations` tool → deferred to v2
- tree-sitter-sql WASM upgrade → deferred to v2
- `search_columns` dedicated tool → deferred (use `search_symbols(kind="field")`)
- ORM support for TypeORM and Knex → deferred to v2 (Prisma + Drizzle only in v1)

## Verification of complete plan

Running the full test suite after Task 17 should show:
- All 17 tasks' test artifacts present and passing
- No regressions in existing 944+ tests
- `npx tsc --noEmit` clean
- Manual smoke test: `index_folder` on a repo with `.sql` files, then `search_symbols(query="orders", kind="table")` returns expected results
- CI performance benchmark < 8s on ubuntu-latest
