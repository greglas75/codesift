# LSP Bridge — Design Spec

**Date:** 2026-03-26
**Scope:** Add LSP-backed tools alongside existing tree-sitter/BM25 layer
**Estimated effort:** ~20h

---

## Goal

Add 4 LSP-powered tools to CodeSift: type-safe `find_references`, `go_to_definition`, `get_type_info`, and `rename_symbol`. LSP runs as optional layer — when language server is available, results are precise. When not, fallback to existing grep/tree-sitter behavior with hint to install LSP.

## Decisions

- **Naming:** No `lsp_` prefix — transparent to agent. `find_references` upgrades silently.
- **Lifecycle:** Lazy start + 5 min idle kill. Zero overhead when LSP not used.
- **Fallback:** Silent fallback + hint when LSP unavailable.
- **Write scope:** Only `rename_symbol` writes files. No edit_symbol/insert — agent has Edit tool.
- **Languages:** TS/JS, Python, Go, Rust, Ruby, PHP (matching current parser support).

## Architecture

```
src/lsp/
  ├── lsp-manager.ts      — lifecycle: lazy start, idle kill, process registry
  ├── lsp-client.ts       — JSON-RPC stdio communication with LSP server
  ├── lsp-servers.ts      — per-language config: command, args, capabilities
  └── lsp-tools.ts        — 4 tool handlers
```

### lsp-manager.ts

Singleton managing LSP server processes.

```typescript
interface LspSession {
  client: LspClient;
  process: ChildProcess;
  language: string;
  rootPath: string;
  lastUsed: number;
}

class LspManager {
  private sessions = new Map<string, LspSession>();  // key: `${repo}:${language}`
  private idleTimer: NodeJS.Timeout;

  /** Get or start LSP for a repo+language. Returns null if LSP not available. */
  async getClient(repo: string, language: string): Promise<LspClient | null>;

  /** Kill idle sessions (>5 min since lastUsed). Runs every 60s. */
  private reapIdle(): void;

  /** Kill all sessions. Called on MCP shutdown. */
  async shutdown(): Promise<void>;
}
```

Key behaviors:
- `getClient` checks if LSP binary exists in PATH (`which typescript-language-server`)
- If not found → return null (caller does fallback)
- If found → spawn process, run LSP initialize handshake, cache session
- Update `lastUsed` on every call
- `reapIdle` kills processes with `lastUsed > 5 min ago`

### lsp-client.ts

JSON-RPC over stdio to LSP server.

```typescript
class LspClient {
  constructor(process: ChildProcess);

  /** LSP initialize + initialized handshake */
  async initialize(rootUri: string, capabilities: object): Promise<void>;

  /** Send request, await response with 10s timeout */
  async request<T>(method: string, params: object): Promise<T>;

  /** Send notification (no response expected) */
  notify(method: string, params: object): void;

  /** Open a file (textDocument/didOpen) — required before LSP queries */
  async openFile(uri: string, content: string, language: string): Promise<void>;

  /** Shutdown + exit gracefully */
  async shutdown(): Promise<void>;
}
```

Protocol:
- Stdin/stdout JSON-RPC 2.0 with Content-Length headers
- Request IDs: incrementing counter
- Pending requests map with timeout reject
- Stderr → console.error (debug logging)
- Process crash → remove from manager, next call will restart

### lsp-servers.ts

Known LSP server configurations.

```typescript
interface LspServerConfig {
  command: string;           // binary name (resolved via PATH)
  args: string[];            // CLI arguments
  languages: string[];       // file extensions this server handles
  initOptions?: object;      // LSP initialize options
}

const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["typescript", "javascript", "tsx", "jsx"],
  },
  python: {
    command: "pylsp",
    args: [],
    languages: ["python"],
  },
  go: {
    command: "gopls",
    args: ["serve"],
    languages: ["go"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
  },
  ruby: {
    command: "solargraph",
    args: ["stdio"],
    languages: ["ruby"],
  },
  php: {
    command: "intelephense",
    args: ["--stdio"],
    languages: ["php"],
  },
};

/** Find LSP config for a file extension. Returns null if unsupported. */
function getLspConfig(language: string): LspServerConfig | null;

/** Check if LSP binary is installed. */
async function isLspAvailable(config: LspServerConfig): Promise<boolean>;
```

### lsp-tools.ts — Tool Handlers

#### 1. find_references (upgrade existing)

```typescript
async function findReferencesLsp(
  repo: string,
  symbolName: string,
  filePath: string,     // file containing the symbol
  line: number,         // 0-based line
  character: number,    // 0-based column
): Promise<Reference[]>;
```

Flow:
1. Detect language from file extension
2. Try `lspManager.getClient(repo, language)`
3. If client available:
   - `textDocument/didOpen` (if not already)
   - `textDocument/references` at position
   - Map LSP locations to CodeSift `Reference[]`
4. If client null → fallback to existing grep-based `findReferences`
5. If fallback used → append hint: "Install {lsp-server} for type-safe results"

Integration: modify `findReferences` in `symbol-tools.ts` to try LSP first. Existing signature stays compatible — add optional `filePath`/`line`/`character` params. When not provided, resolve from index (search symbol by name → get file + start_line).

#### 2. go_to_definition (new)

```typescript
async function goToDefinition(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ file: string; line: number; character: number; source?: string } | null>;
```

Flow:
1. If filePath/line/character provided → use directly
2. If only symbolName → search index for symbol, use its file + start_line
3. LSP `textDocument/definition` at position
4. If no LSP → fallback: search_symbols with detail_level=compact, return first match
5. Read source snippet around definition (±5 lines)

#### 3. get_type_info (new)

```typescript
async function getTypeInfo(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ type: string; documentation?: string } | null>;
```

Flow:
1. Resolve position (same as go_to_definition)
2. LSP `textDocument/hover` at position
3. Parse hover result → extract type signature + documentation
4. If no LSP → return null with hint

No fallback for hover — tree-sitter doesn't have type info. This tool simply doesn't work without LSP (returns null + hint).

#### 4. rename_symbol (new, WRITE)

```typescript
async function renameSymbol(
  repo: string,
  symbolName: string,
  newName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ files_changed: number; edits: Array<{ file: string; changes: number }> }>;
```

Flow:
1. Resolve position
2. LSP `textDocument/prepareRename` → verify rename is valid
3. LSP `textDocument/rename` with newName → get workspace edits
4. Apply edits to files on disk (write)
5. `index_file` on each changed file (update CodeSift index)
6. Return summary of changes

**Safety:**
- `prepareRename` first — LSP validates before executing
- If LSP not available → error (no fallback — text-replace rename is unsafe)
- Return dry_run preview in response before applying? → No, LSP prepareRename IS the validation

## Registration (register-tools.ts)

```typescript
// New tools
{
  name: "go_to_definition",
  description: "Go to the definition of a symbol. Uses LSP when available for precision, falls back to index search.",
  schema: {
    repo: z.string(),
    symbol_name: z.string(),
    file_path: z.string().optional(),
    line: zNum(),
    character: zNum(),
  },
},
{
  name: "get_type_info",
  description: "Get type information for a symbol (return type, parameter types, documentation). Requires LSP — returns null if language server not available.",
  schema: {
    repo: z.string(),
    symbol_name: z.string(),
    file_path: z.string().optional(),
    line: zNum(),
    character: zNum(),
  },
},
{
  name: "rename_symbol",
  description: "Rename a symbol across all files using LSP refactoring. Type-safe, handles imports and references. Requires LSP.",
  schema: {
    repo: z.string(),
    symbol_name: z.string(),
    new_name: z.string(),
    file_path: z.string().optional(),
    line: zNum(),
    character: zNum(),
  },
},

// Existing upgrade
// find_references — add file_path, line, character optional params
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| LSP binary not in PATH | Return null + hint "Install X for type-safe results" |
| LSP crashes after start | Remove session, next call restarts |
| LSP request timeout (10s) | Reject promise, log warning |
| LSP returns empty results | Return empty (same as "not found") |
| rename on read-only file | LSP error → propagate to agent |
| rename without LSP | Error "rename_symbol requires a language server" |
| File not indexed | Resolve from filesystem directly |

## Dependencies

- Zero new npm dependencies — JSON-RPC is simple enough to implement inline (Content-Length header + JSON parse)
- `child_process.spawn` for LSP process management
- `which` check via `execFileSync("which", [cmd])` or `fs.access`

## Testing Strategy

- Unit tests for lsp-client.ts: mock stdin/stdout, verify JSON-RPC protocol
- Unit tests for lsp-manager.ts: mock process spawn, verify lazy start + idle kill
- Integration test: start real `typescript-language-server` on a fixture project, run find_references + go_to_definition
- Skip integration tests when LSP not installed (CI-friendly)

## Implementation Order

| Task | Files | Effort |
|------|-------|--------|
| 1. lsp-client.ts (JSON-RPC) | `src/lsp/lsp-client.ts` | 4h |
| 2. lsp-servers.ts (config) | `src/lsp/lsp-servers.ts` | 1h |
| 3. lsp-manager.ts (lifecycle) | `src/lsp/lsp-manager.ts` | 3h |
| 4. go_to_definition tool | `src/lsp/lsp-tools.ts`, `register-tools.ts` | 3h |
| 5. find_references LSP upgrade | `src/tools/symbol-tools.ts`, `src/lsp/lsp-tools.ts` | 3h |
| 6. get_type_info tool | `src/lsp/lsp-tools.ts`, `register-tools.ts` | 2h |
| 7. rename_symbol tool | `src/lsp/lsp-tools.ts`, `register-tools.ts` | 4h |

**Total: ~20h**

## Success Metrics

| Metric | Target |
|--------|--------|
| find_references false positive rate (with LSP) | <2% (vs current ~20%) |
| go_to_definition accuracy | 100% for indexed languages |
| rename_symbol cross-file correctness | 100% (LSP guarantees) |
| LSP cold start time | <3s for tsserver |
| LSP warm query time | <200ms |
| Fallback when no LSP | Seamless, with install hint |
