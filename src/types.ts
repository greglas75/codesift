// Core domain types for CodeSift

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
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

export type Direction = "callers" | "callees";

export interface CallNode {
  symbol: CodeSymbol;
  children: CallNode[];
}

export interface ImpactResult {
  changed_files: string[];
  affected_symbols: CodeSymbol[];
  dependency_graph: Record<string, string[]>; // file → files that import it
}

export interface EmbeddingMeta {
  model: string;
  provider: "voyage" | "openai" | "ollama";
  dimensions: number;
  symbol_count: number;
  updated_at: number;
}
