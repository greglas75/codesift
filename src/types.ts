// Core domain types for CodeSift

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "constant"      // SCREAMING_CASE const
  | "field"
  | "enum"
  | "namespace"
  | "module"
  | "section"       // markdown heading
  | "metadata"      // frontmatter
  | "test_suite"    // describe()
  | "test_case"     // it() / test()
  | "test_hook"     // beforeEach() etc.
  | "component"     // React component (returns JSX)
  | "hook"          // React custom hook (useXxx)
  | "table"         // SQL CREATE TABLE
  | "view"          // SQL CREATE VIEW / MATERIALIZED VIEW
  | "index"         // SQL CREATE INDEX
  | "trigger"       // SQL CREATE TRIGGER
  | "procedure"     // SQL CREATE PROCEDURE
  | "default_export"
  | "conversation_turn"   // user+assistant exchange pair
  | "conversation_summary" // compaction summary
  | "unknown";

export interface FileLocation {
  file: string;         // relative to repo root
  start_line: number;   // 1-based
  end_line: number;     // 1-based
  start_col?: number;
  end_col?: number;
  start_byte?: number;  // byte offset in file — enables precise disk reads
  end_byte?: number;    // byte offset in file
}

export interface CodeSymbol extends FileLocation {
  id: string;           // "{repo}:{file}:{name}:{start_line}"
  repo: string;
  name: string;
  kind: SymbolKind;
  signature?: string;   // function param list + return type
  docstring?: string;   // first JSDoc / comment above symbol
  source?: string;      // full source text of symbol
  parent?: string;      // parent symbol id (for methods inside classes)
  tokens?: string[];    // pre-computed BM25 tokens (name + signature split)
  decorators?: string[];                // e.g. ["@pytest.fixture", "@classmethod"]
  extends?: string[];                   // superclass / base types
  implements?: string[];                // TypeScript: implemented interface names
  is_async?: boolean;                   // async def, async fn, etc.
  is_exported?: boolean;                // symbol is exported from its module
  meta?: Record<string, unknown>;       // language-specific metadata
}

export interface FileEntry {
  path: string;         // relative to repo root
  language: string;
  symbol_count: number;
  last_modified: number; // unix ms
  mtime_ms?: number;    // filesystem mtime (ms) — for incremental skip
  stale?: boolean;      // dirty propagation: callee signature changed, re-parse needed
}

export interface CodeIndex {
  repo: string;
  root: string;           // absolute path to repo root
  symbols: CodeSymbol[];
  files: FileEntry[];
  created_at: number;     // unix ms
  updated_at: number;
  symbol_count: number;
  file_count: number;
  /** Snapshot of EXTRACTOR_VERSIONS at index creation time — used to detect
   *  schema changes and trigger full reindex when any language version bumps. */
  extractor_version?: Record<string, string>;
  /** Present iff a JS/TS monorepo was detected at index time. Populated by
   *  the workspace resolver in `src/storage/workspace-resolver.ts`. */
  workspaces?: Workspace[];
}

// ---------------------------------------------------------------------------
// Monorepo workspace model — populated when a JS/TS monorepo is detected.
// ---------------------------------------------------------------------------

export interface WorkspaceTsconfigPath {
  /** Pattern as written in tsconfig `paths`, e.g. "@org/*" or "@/*". */
  from_pattern: string;
  /** Resolved targets relative to the workspace root, e.g. ["packages/*"]. */
  to_paths: string[];
}

export interface WorkspaceDependencies {
  /** Names of internal workspace packages this workspace depends on. */
  workspace: string[];
  /** Names of npm-registry deps (versions live in the workspace package.json). */
  external: string[];
}

export interface Workspace {
  /** Stable id: package name when present, otherwise relative path. */
  id: string;
  /** package.json#name; null when the package has no name field. */
  name: string | null;
  /** Absolute path to the workspace root. */
  root: string;
  package_manager_role: "root" | "package";
  /** Build-orchestrator / package-manager signal. */
  manifest_tool: "turbo" | "pnpm" | "yarn" | "npm" | "bun" | "nx" | "lerna";
  dependencies: WorkspaceDependencies;
  tsconfig_paths: WorkspaceTsconfigPath[];
  /** e.g. ["nextjs", "hono"]; populated from the workspace package.json deps. */
  detected_frameworks: string[];
  file_count?: number;
  symbol_count?: number;
}

/** Boundary rule consumed by the new `workspace_boundaries` tool.
 *  Existing path-based `BoundaryRule` (used by `check_boundaries`) is unchanged. */
export interface WorkspaceBoundaryRule {
  /** Workspace name OR glob (e.g. "apps/*"). */
  from_workspace: string;
  /** Names, globs, or negation entries (e.g. ["packages/*", "!packages/shared"]). */
  cannot_import_workspaces: string[];
}

export interface AffectedWorkspaceEntry {
  workspace_id: string;
  workspace_name: string | null;
  reason: "direct" | "transitive";
  changed_files: string[];
  /** Chain of workspace ids for transitive entries; populated from BFS path. */
  via?: string[];
}

export interface AffectedResult {
  since_ref: string;
  changed_files: string[];
  affected: AffectedWorkspaceEntry[];
  /** Lockfile changes are surfaced separately and never fan out (per spec D5). */
  excluded_lockfile_changes: string[];
  /** Files changed at or above the workspace boundary that don't belong to any
   *  workspace (root configs like turbo.json, tsconfig.base.json, root
   *  package.json, CI workflows). Callers should treat this as "everything
   *  potentially affected" and fan out to all workspaces or trigger a full
   *  rebuild. Empty when only workspace-scoped files changed. */
  root_changed_files: string[];
  /** Diagnostic field surfaced when called outside a git work tree, etc. */
  error?: "not_a_git_repository" | "bad_ref";
}

export interface RepoMeta {
  name: string;           // "local/promptvault"
  root: string;           // absolute path
  index_path: string;     // absolute path to .codesift/{hash}.index.json
  symbol_count: number;
  file_count: number;
  updated_at: number;
  last_git_commit?: string; // HEAD SHA at last index time — for auto-refresh
}

export interface Registry {
  repos: Record<string, RepoMeta>;
  updated_at: number;
}

export interface SearchResult {
  symbol: CodeSymbol;
  score: number;
  matches?: string[];     // matched token excerpts for highlight
}

export interface Reference {
  file: string;
  line: number;
  col?: number;
  context: string;        // surrounding line text
}

export interface ContainingSymbol {
  name: string;
  kind: SymbolKind;
  start_line: number;
  end_line: number;
  in_degree: number;
}

export interface TextMatch {
  file: string;
  line: number;
  content: string;
  context_before?: string[];
  context_after?: string[];
  containing_symbol?: ContainingSymbol;
  /** Set when the search aborted on a wall-clock cap. The single returned match
   * carries the hint so agents see actionable guidance instead of a hang. */
  truncated?: boolean;
  hint?: string;
}

export interface TextMatchGroup {
  file: string;
  count: number;
  lines: number[];        // line numbers of all matches
  first_match: string;    // content of first matching line
}

export type Direction = "callers" | "callees";

export type RouteFramework =
  | "nestjs"
  | "nextjs"
  | "express"
  | "hono"
  | "yii2"
  | "laravel"
  | "ktor"
  | "spring-kotlin"
  | "astro"
  | "flask"
  | "fastapi"
  | "django"
  | "unknown";

export interface CallNode {
  symbol: CodeSymbol;
  children: CallNode[];
}

export interface AffectedTest {
  test_file: string;
  reason: string;            // e.g. "imports OrderService (changed)"
}

export interface RiskScore {
  file: string;
  risk: "low" | "medium" | "high" | "critical";
  score: number;              // 0-100
  callers: number;            // how many symbols depend on this file
  test_coverage: number;      // how many test files cover this file
  symbols_changed: number;    // how many symbols were changed in this file
}

export interface ImpactResult {
  changed_files: string[];
  affected_symbols: CodeSymbol[];
  affected_tests: AffectedTest[];
  risk_scores: RiskScore[];
  dependency_graph: Record<string, string[]>; // file → files that import it
}

export interface EmbeddingMeta {
  model: string;
  provider: "voyage" | "openai" | "ollama" | "local";
  dimensions: number;
  symbol_count: number;
  updated_at: number;
}

export interface CodeChunk {
  id: string;          // "{repo}:{file}:{startLine}"
  file: string;        // relative path
  startLine: number;
  endLine: number;
  text: string;        // the actual chunk text
  tokenCount: number;  // estimated token count
}

// ---------------------------------------------------------------------------
// Repo group types — used by group-registry and cross-repo tools
// ---------------------------------------------------------------------------

export interface RepoGroup {
  name: string;
  repos: string[];
  description?: string;
  created_at: number;
  updated_at: number;
}

export interface GroupRegistry {
  groups: Record<string, RepoGroup>;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Cross-repo contract matching types
// ---------------------------------------------------------------------------

export interface RepoEndpoint {
  repo: string;
  method: string;
  path: string;
  normalized_path: string;
  file: string;
}

export interface ContractMatch {
  producer_repo: string;
  consumer_repo: string;
  method: string;
  path: string;
  consumer_file: string;
  consumer_line: number;
  confidence: "exact" | "partial";
}
