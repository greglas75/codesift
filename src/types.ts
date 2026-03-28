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

export interface TextMatch {
  file: string;
  line: number;
  content: string;
  context_before?: string[];
  context_after?: string[];
}

export interface TextMatchGroup {
  file: string;
  count: number;
  lines: number[];        // line numbers of all matches
  first_match: string;    // content of first matching line
}

export type Direction = "callers" | "callees";

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
  provider: "voyage" | "openai" | "ollama";
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
