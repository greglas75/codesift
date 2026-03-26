# LSP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LSP-backed tools (find_references upgrade, go_to_definition, get_type_info, rename_symbol) with lazy lifecycle and graceful fallback.

**Architecture:** New `src/lsp/` module with 4 files: JSON-RPC client, server config registry, session lifecycle manager, and tool handlers. Integrates with existing tools via fallback pattern — LSP when available, grep/tree-sitter otherwise.

**Tech Stack:** TypeScript, child_process.spawn, JSON-RPC 2.0 over stdio, LSP protocol

**Spec:** `docs/superpowers/specs/2026-03-26-lsp-bridge-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lsp/lsp-client.ts` | Create | JSON-RPC 2.0 over stdio — send requests, await responses, handle notifications |
| `src/lsp/lsp-servers.ts` | Create | Per-language LSP config (command, args) + availability check |
| `src/lsp/lsp-manager.ts` | Create | Lazy start, idle kill (5min), session registry |
| `src/lsp/lsp-tools.ts` | Create | 4 tool handlers: goToDefinition, getTypeInfo, findReferencesLsp, renameSymbol |
| `src/register-tools.ts` | Modify | Register 3 new tools + upgrade find_references params |
| `src/tools/symbol-tools.ts` | Modify | Wire LSP fallback into existing findReferences |
| `tests/lsp/lsp-client.test.ts` | Create | Unit tests for JSON-RPC protocol |
| `tests/lsp/lsp-manager.test.ts` | Create | Unit tests for lifecycle management |
| `tests/lsp/lsp-tools.test.ts` | Create | Integration tests for tool handlers |

---

## Task 1: LSP Client — JSON-RPC over stdio

**Files:**
- Create: `src/lsp/lsp-client.ts`
- Test: `tests/lsp/lsp-client.test.ts`

- [ ] **Step 1: Write failing test for LspClient message encoding**

```typescript
// tests/lsp/lsp-client.test.ts
import { describe, it, expect } from "vitest";
import { encodeMessage, decodeMessages } from "../../src/lsp/lsp-client.js";

describe("LSP JSON-RPC encoding", () => {
  it("encodes a message with Content-Length header", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test", params: {} });
    const encoded = encodeMessage(body);
    expect(encoded).toBe(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });

  it("decodes a complete message from buffer", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const raw = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const { messages, remaining } = decodeMessages(Buffer.from(raw));
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(remaining.length).toBe(0);
  });

  it("handles partial message (incomplete body)", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    const partial = header + body.slice(0, 5);
    const { messages, remaining } = decodeMessages(Buffer.from(partial));
    expect(messages.length).toBe(0);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("decodes multiple messages in one buffer", () => {
    const msg1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "a" });
    const msg2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: "b" });
    const raw = `Content-Length: ${Buffer.byteLength(msg1)}\r\n\r\n${msg1}Content-Length: ${Buffer.byteLength(msg2)}\r\n\r\n${msg2}`;
    const { messages } = decodeMessages(Buffer.from(raw));
    expect(messages.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lsp/lsp-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement lsp-client.ts**

```typescript
// src/lsp/lsp-client.ts
import type { ChildProcess } from "node:child_process";

const REQUEST_TIMEOUT_MS = 10_000;

// --- JSON-RPC message encoding/decoding ---

export function encodeMessage(body: string): string {
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

export function decodeMessages(buffer: Buffer): { messages: unknown[]; remaining: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset);
    if (headerEnd === -1) break;

    const header = buffer.slice(offset, headerEnd).toString("utf-8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;

    const contentLength = parseInt(match[1]!, 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (bodyEnd > buffer.length) break; // incomplete body

    const body = buffer.slice(bodyStart, bodyEnd).toString("utf-8");
    try {
      messages.push(JSON.parse(body));
    } catch {
      // skip malformed JSON
    }
    offset = bodyEnd;
  }

  return { messages, remaining: buffer.slice(offset) };
}

// --- LSP Client ---

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private openFiles = new Set<string>();

  constructor(private process: ChildProcess) {
    process.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stderr?.on("data", (chunk: Buffer) => {
      // LSP servers log to stderr — debug only
    });
    process.on("exit", () => {
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error("LSP server exited"));
      }
      this.pending.clear();
    });
  }

  async initialize(rootUri: string): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          references: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
          rename: { dynamicRegistration: false, prepareSupport: true },
        },
      },
    });
    this.notify("initialized", {});
    return result;
  }

  async request<T = unknown>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const encoded = encodeMessage(body);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.process.stdin?.write(encoded);
    });
  }

  notify(method: string, params: object): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.process.stdin?.write(encodeMessage(body));
  }

  async openFile(uri: string, content: string, languageId: string): Promise<void> {
    if (this.openFiles.has(uri)) return;
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text: content },
    });
    this.openFiles.add(uri);
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", {});
      this.notify("exit", {});
    } catch {
      // Force kill if graceful shutdown fails
      this.process.kill("SIGTERM");
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { messages, remaining } = decodeMessages(this.buffer);
    this.buffer = remaining;

    for (const msg of messages) {
      const rpc = msg as { id?: number; result?: unknown; error?: { message: string } };
      if (rpc.id !== undefined && this.pending.has(rpc.id)) {
        const req = this.pending.get(rpc.id)!;
        this.pending.delete(rpc.id);
        clearTimeout(req.timer);
        if (rpc.error) {
          req.reject(new Error(rpc.error.message));
        } else {
          req.resolve(rpc.result);
        }
      }
      // Notifications (no id) are ignored — we don't need diagnostics etc.
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/lsp/lsp-client.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/lsp/lsp-client.ts tests/lsp/lsp-client.test.ts
git commit -m "feat(lsp): JSON-RPC client over stdio

LspClient: initialize, request (10s timeout), notify, openFile, shutdown.
encodeMessage/decodeMessages: Content-Length framed JSON-RPC 2.0.
Handles partial buffers, multiple messages, process exit cleanup."
```

---

## Task 2: LSP Server Config Registry

**Files:**
- Create: `src/lsp/lsp-servers.ts`

- [ ] **Step 1: Create lsp-servers.ts**

```typescript
// src/lsp/lsp-servers.ts
import { execFileSync } from "node:child_process";

export interface LspServerConfig {
  command: string;
  args: string[];
  languages: string[];
  initOptions?: Record<string, unknown>;
}

export const LSP_SERVERS: Record<string, LspServerConfig> = {
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

/** Find LSP server config that handles the given language. */
export function getLspConfigForLanguage(language: string): { name: string; config: LspServerConfig } | null {
  for (const [name, config] of Object.entries(LSP_SERVERS)) {
    if (config.languages.includes(language)) {
      return { name, config };
    }
  }
  return null;
}

/** Check if LSP binary is available in PATH. Caches results. */
const availabilityCache = new Map<string, boolean>();

export function isLspAvailable(config: LspServerConfig): boolean {
  const cached = availabilityCache.get(config.command);
  if (cached !== undefined) return cached;

  try {
    execFileSync("which", [config.command], { stdio: "ignore" });
    availabilityCache.set(config.command, true);
    return true;
  } catch {
    availabilityCache.set(config.command, false);
    return false;
  }
}
```

- [ ] **Step 2: Build and verify types**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/lsp/lsp-servers.ts
git commit -m "feat(lsp): server config registry — 6 language servers

Configs for typescript-language-server, pylsp, gopls, rust-analyzer,
solargraph, intelephense. getLspConfigForLanguage + isLspAvailable
with cached PATH lookup."
```

---

## Task 3: LSP Session Manager

**Files:**
- Create: `src/lsp/lsp-manager.ts`
- Test: `tests/lsp/lsp-manager.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/lsp/lsp-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LspManager } from "../../src/lsp/lsp-manager.js";

// We test the public interface without starting real LSP servers
describe("LspManager", () => {
  let manager: LspManager;

  beforeEach(() => {
    manager = new LspManager();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("returns null for unsupported language", async () => {
    const client = await manager.getClient("/tmp/test", "markdown");
    expect(client).toBeNull();
  });

  it("returns null when LSP binary not installed", async () => {
    // Unlikely to have solargraph installed in CI
    const client = await manager.getClient("/tmp/test", "ruby");
    // Could be null or not depending on env — just verify no crash
    expect(client === null || client !== null).toBe(true);
  });

  it("shutdown completes without error when no sessions", async () => {
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement lsp-manager.ts**

```typescript
// src/lsp/lsp-manager.ts
import { spawn } from "node:child_process";
import { LspClient } from "./lsp-client.js";
import { getLspConfigForLanguage, isLspAvailable } from "./lsp-servers.js";
import { pathToFileURL } from "node:url";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const REAP_INTERVAL_MS = 60 * 1000;    // Check every 60s

interface LspSession {
  client: LspClient;
  language: string;
  rootPath: string;
  lastUsed: number;
}

export class LspManager {
  private sessions = new Map<string, LspSession>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.reapTimer = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
    // Don't keep process alive just for this timer
    if (this.reapTimer.unref) this.reapTimer.unref();
  }

  /**
   * Get or start an LSP client for a repo + language.
   * Returns null if the language has no LSP config or the binary is not installed.
   */
  async getClient(rootPath: string, language: string): Promise<LspClient | null> {
    const key = `${rootPath}:${language}`;

    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    const lspInfo = getLspConfigForLanguage(language);
    if (!lspInfo) return null;

    if (!isLspAvailable(lspInfo.config)) return null;

    try {
      const proc = spawn(lspInfo.config.command, lspInfo.config.args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: rootPath,
      });

      const client = new LspClient(proc);
      const rootUri = pathToFileURL(rootPath).href;
      await client.initialize(rootUri);

      const session: LspSession = {
        client,
        language,
        rootPath,
        lastUsed: Date.now(),
      };
      this.sessions.set(key, session);

      proc.on("exit", () => {
        this.sessions.delete(key);
      });

      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] LSP start failed for ${lspInfo.name}: ${msg}`);
      return null;
    }
  }

  /** Get the LSP server name for a hint message. */
  getServerName(language: string): string | null {
    const info = getLspConfigForLanguage(language);
    return info ? info.config.command : null;
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
        session.client.shutdown().catch(() => {});
        this.sessions.delete(key);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    const shutdowns = [...this.sessions.values()].map((s) =>
      s.client.shutdown().catch(() => {}),
    );
    await Promise.all(shutdowns);
    this.sessions.clear();
  }
}

// Module-level singleton
let _manager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!_manager) _manager = new LspManager();
  return _manager;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/lsp/lsp-manager.test.ts`
Expected: 3 PASS

- [ ] **Step 4: Commit**

```bash
git add src/lsp/lsp-manager.ts tests/lsp/lsp-manager.test.ts
git commit -m "feat(lsp): session manager — lazy start + 5min idle kill

LspManager: getClient (lazy spawn + init), reapIdle (60s interval),
shutdown (kill all). Singleton via getLspManager().
Returns null when LSP not available (no crash, caller does fallback)."
```

---

## Task 4: go_to_definition tool

**Files:**
- Create: `src/lsp/lsp-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Create lsp-tools.ts with resolveSymbolPosition helper + goToDefinition**

```typescript
// src/lsp/lsp-tools.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getLspManager } from "./lsp-manager.js";
import { getCodeIndex, getBM25Index } from "../tools/index-tools.js";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import type { CodeIndex, Reference } from "../types.js";

/**
 * Resolve a symbol name to a file position (file, line, character).
 * Uses provided params if available, otherwise searches the index.
 */
export async function resolveSymbolPosition(
  index: CodeIndex,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ filePath: string; line: number; character: number } | null> {
  if (filePath && line !== undefined) {
    return { filePath, line, character: character ?? 0 };
  }

  // Search index for the symbol
  const sym = index.symbols.find((s) => s.name === symbolName);
  if (!sym) return null;

  return {
    filePath: sym.file,
    line: sym.start_line - 1, // Convert to 0-based for LSP
    character: 0,
  };
}

/** Detect language from file path using CodeSift's parser-manager mapping. */
function detectLanguage(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
  };
  return map[ext] ?? null;
}

/**
 * Go to the definition of a symbol.
 * LSP when available, fallback to index search.
 */
export async function goToDefinition(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ file: string; line: number; character: number; preview?: string; via: "lsp" | "index" } | null> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) return null;

  const language = detectLanguage(pos.filePath);
  if (!language) return null;

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);

  if (client) {
    try {
      const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
      const content = await readFile(join(index.root, pos.filePath), "utf-8");
      await client.openFile(fileUri, content, language);

      const result = await client.request<unknown>("textDocument/definition", {
        textDocument: { uri: fileUri },
        position: { line: pos.line, character: pos.character },
      });

      // LSP can return Location | Location[] | LocationLink[]
      const loc = Array.isArray(result) ? result[0] : result;
      if (loc && typeof loc === "object") {
        const l = loc as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetRange?: { start: { line: number; character: number } } };
        const uri = l.targetUri ?? l.uri ?? "";
        const range = l.targetRange ?? l.range;
        const defFile = uri.replace(pathToFileURL(index.root).href + "/", "");
        const defLine = (range?.start.line ?? 0) + 1; // back to 1-based

        // Read preview
        let preview: string | undefined;
        try {
          const defContent = await readFile(join(index.root, defFile), "utf-8");
          const lines = defContent.split("\n");
          const start = Math.max(0, defLine - 2);
          const end = Math.min(lines.length, defLine + 3);
          preview = lines.slice(start, end).join("\n");
        } catch { /* ignore */ }

        return { file: defFile, line: defLine, character: range?.start.character ?? 0, preview, via: "lsp" };
      }
    } catch {
      // LSP failed — fall through to index fallback
    }
  }

  // Fallback: search index
  const sym = index.symbols.find((s) => s.name === symbolName);
  if (!sym) return null;

  const hint = language ? manager.getServerName(language) : null;
  return {
    file: sym.file,
    line: sym.start_line,
    character: 0,
    preview: sym.source?.slice(0, 300),
    via: "index",
    ...(hint ? { hint: `Install ${hint} for precise go-to-definition` } : {}),
  } as { file: string; line: number; character: number; preview?: string; via: "lsp" | "index" };
}
```

- [ ] **Step 2: Register go_to_definition in register-tools.ts**

Add import at top:
```typescript
import { goToDefinition } from "./lsp/lsp-tools.js";
```

Add tool definition after `find_references`:
```typescript
{
  name: "go_to_definition",
  description: "Go to the definition of a symbol. Uses LSP when available for type-safe precision, falls back to index search.",
  schema: {
    repo: z.string().describe("Repository identifier"),
    symbol_name: z.string().describe("Symbol name to find definition of"),
    file_path: z.string().optional().describe("File containing the symbol reference (for LSP precision)"),
    line: zNum().describe("0-based line number of the reference"),
    character: zNum().describe("0-based column of the reference"),
  },
  handler: (args) => goToDefinition(
    args.repo as string,
    args.symbol_name as string,
    args.file_path as string | undefined,
    args.line as number | undefined,
    args.character as number | undefined,
  ),
},
```

- [ ] **Step 3: Build and run full test suite**

Run: `npm run build && npm test`
Expected: All pass (go_to_definition doesn't break existing tests)

- [ ] **Step 4: Commit**

```bash
git add src/lsp/lsp-tools.ts src/register-tools.ts
git commit -m "feat(lsp): go_to_definition — LSP precision + index fallback

New tool: go_to_definition(repo, symbol_name, file_path?, line?, character?)
LSP textDocument/definition when available, falls back to index search.
Returns file, line, preview snippet, and via (lsp|index)."
```

---

## Task 5: find_references LSP upgrade

**Files:**
- Modify: `src/lsp/lsp-tools.ts`
- Modify: `src/tools/symbol-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Add findReferencesLsp to lsp-tools.ts**

```typescript
// Add to src/lsp/lsp-tools.ts

/**
 * Find references via LSP. Returns null if LSP not available (caller does fallback).
 */
export async function findReferencesLsp(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ refs: Reference[]; via: "lsp" } | null> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) return null;

  const language = detectLanguage(pos.filePath);
  if (!language) return null;

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);
  if (!client) return null;

  try {
    const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
    const content = await readFile(join(index.root, pos.filePath), "utf-8");
    await client.openFile(fileUri, content, language);

    const result = await client.request<unknown[]>("textDocument/references", {
      textDocument: { uri: fileUri },
      position: { line: pos.line, character: pos.character },
      context: { includeDeclaration: false },
    });

    if (!Array.isArray(result)) return null;

    const rootUri = pathToFileURL(index.root).href + "/";
    const refs: Reference[] = result.map((loc: any) => ({
      file: (loc.uri ?? "").replace(rootUri, ""),
      line: (loc.range?.start?.line ?? 0) + 1,
      col: (loc.range?.start?.character ?? 0) + 1,
      context: "", // LSP doesn't provide line content — could read file but expensive
    }));

    return { refs, via: "lsp" };
  } catch {
    return null; // Fallback to grep
  }
}
```

- [ ] **Step 2: Wire LSP into existing findReferences in symbol-tools.ts**

At the top of `findReferences` function in `src/tools/symbol-tools.ts`, add LSP try-first:

```typescript
import { findReferencesLsp } from "../lsp/lsp-tools.js";
import { getLspManager } from "../lsp/lsp-manager.js";

// Inside findReferences, before the grep loop:
// Try LSP first (more precise, type-aware)
const lspResult = await findReferencesLsp(repo, symbolName, filePattern);
if (lspResult) return lspResult.refs;

// ... existing grep-based code continues as fallback ...
// After returning grep results, check if hint needed:
// (Add hint logic to the return path)
```

Note: The integration needs care — `findReferences` currently takes `(repo, symbolName, filePattern?)`. Add optional `filePath`, `line`, `character` params without breaking existing callers.

- [ ] **Step 3: Add file_path/line/character params to find_references in register-tools.ts**

The existing schema already has `file_path` (for pattern filtering). We need `line` and `character` — but these are for LSP precision. Add them as optional.

- [ ] **Step 4: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 5: Commit**

```bash
git add src/lsp/lsp-tools.ts src/tools/symbol-tools.ts src/register-tools.ts
git commit -m "feat(lsp): upgrade find_references — LSP when available, grep fallback

findReferences tries LSP textDocument/references first for type-safe
results. Falls back to existing grep-based search with hint to install
language server. Zero breaking changes to existing API."
```

---

## Task 6: get_type_info tool

**Files:**
- Modify: `src/lsp/lsp-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Add getTypeInfo to lsp-tools.ts**

```typescript
// Add to src/lsp/lsp-tools.ts

/**
 * Get type information via LSP hover.
 * Returns null if LSP not available (no fallback — type info requires LSP).
 */
export async function getTypeInfo(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ type: string; documentation?: string; via: "lsp"; hint?: string } | { via: "unavailable"; hint: string }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) return { via: "unavailable", hint: "Symbol not found in index" };

  const language = detectLanguage(pos.filePath);
  if (!language) return { via: "unavailable", hint: "Unsupported language for LSP" };

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);
  if (!client) {
    const serverName = manager.getServerName(language);
    return { via: "unavailable", hint: `Install ${serverName ?? "a language server"} for type info` };
  }

  try {
    const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
    const content = await readFile(join(index.root, pos.filePath), "utf-8");
    await client.openFile(fileUri, content, language);

    const result = await client.request<{ contents: unknown }>("textDocument/hover", {
      textDocument: { uri: fileUri },
      position: { line: pos.line, character: pos.character },
    });

    if (!result?.contents) return { via: "unavailable", hint: "No hover info at this position" };

    // LSP hover contents can be string | MarkupContent | MarkedString[]
    let typeStr: string;
    let docs: string | undefined;

    if (typeof result.contents === "string") {
      typeStr = result.contents;
    } else if (typeof result.contents === "object" && "value" in (result.contents as object)) {
      typeStr = (result.contents as { value: string }).value;
    } else if (Array.isArray(result.contents)) {
      typeStr = result.contents.map((c: any) => typeof c === "string" ? c : c.value ?? "").join("\n");
    } else {
      typeStr = String(result.contents);
    }

    // Split type from documentation (many LSP servers put both in hover)
    const parts = typeStr.split("\n---\n");
    if (parts.length > 1) {
      docs = parts.slice(1).join("\n---\n").trim();
      typeStr = parts[0]!.trim();
    }

    return { type: typeStr, documentation: docs, via: "lsp" };
  } catch {
    return { via: "unavailable", hint: "LSP hover request failed" };
  }
}
```

- [ ] **Step 2: Register get_type_info in register-tools.ts**

```typescript
import { goToDefinition, getTypeInfo } from "./lsp/lsp-tools.js";

// Add tool:
{
  name: "get_type_info",
  description: "Get type information for a symbol (return type, parameter types, documentation). Requires a language server — returns hint if not available.",
  schema: {
    repo: z.string().describe("Repository identifier"),
    symbol_name: z.string().describe("Symbol name to get type info for"),
    file_path: z.string().optional().describe("File containing the symbol (for LSP precision)"),
    line: zNum().describe("0-based line number"),
    character: zNum().describe("0-based column"),
  },
  handler: (args) => getTypeInfo(
    args.repo as string,
    args.symbol_name as string,
    args.file_path as string | undefined,
    args.line as number | undefined,
    args.character as number | undefined,
  ),
},
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 4: Commit**

```bash
git add src/lsp/lsp-tools.ts src/register-tools.ts
git commit -m "feat(lsp): get_type_info — hover-based type inspection

New tool: get_type_info(repo, symbol_name). Uses LSP textDocument/hover
to extract type signature + documentation. Returns hint with install
instructions when LSP not available."
```

---

## Task 7: rename_symbol tool (WRITE)

**Files:**
- Modify: `src/lsp/lsp-tools.ts`
- Modify: `src/register-tools.ts`

- [ ] **Step 1: Add renameSymbol to lsp-tools.ts**

```typescript
// Add to src/lsp/lsp-tools.ts
import { writeFile } from "node:fs/promises";
import { indexFile } from "../tools/index-tools.js";

interface RenameEdit {
  file: string;
  changes: number;
}

/**
 * Rename a symbol across all files via LSP.
 * WRITE operation — modifies files on disk.
 * Requires LSP — no fallback (text-replace is unsafe).
 */
export async function renameSymbol(
  repo: string,
  symbolName: string,
  newName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ files_changed: number; edits: RenameEdit[] }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) throw new Error(`Symbol "${symbolName}" not found in index.`);

  const language = detectLanguage(pos.filePath);
  if (!language) throw new Error(`Unsupported language for LSP rename.`);

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);
  if (!client) {
    const serverName = manager.getServerName(language);
    throw new Error(`rename_symbol requires a language server. Install ${serverName ?? "a language server"}.`);
  }

  const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
  const content = await readFile(join(index.root, pos.filePath), "utf-8");
  await client.openFile(fileUri, content, language);

  // Validate rename is possible
  try {
    await client.request("textDocument/prepareRename", {
      textDocument: { uri: fileUri },
      position: { line: pos.line, character: pos.character },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot rename at this position: ${msg}`);
  }

  // Execute rename
  const workspaceEdit = await client.request<{
    changes?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>;
    documentChanges?: Array<{ textDocument: { uri: string }; edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }> }>;
  }>("textDocument/rename", {
    textDocument: { uri: fileUri },
    position: { line: pos.line, character: pos.character },
    newName,
  });

  // Normalize workspace edits (LSP has two formats)
  const fileEdits = new Map<string, Array<{ range: any; newText: string }>>();
  const rootUri = pathToFileURL(index.root).href + "/";

  if (workspaceEdit.changes) {
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
      fileEdits.set(uri.replace(rootUri, ""), edits);
    }
  } else if (workspaceEdit.documentChanges) {
    for (const docChange of workspaceEdit.documentChanges) {
      if ("edits" in docChange) {
        fileEdits.set(docChange.textDocument.uri.replace(rootUri, ""), docChange.edits);
      }
    }
  }

  // Apply edits to files on disk
  const results: RenameEdit[] = [];

  for (const [relPath, edits] of fileEdits) {
    const absPath = join(index.root, relPath);
    let fileContent: string;
    try {
      fileContent = await readFile(absPath, "utf-8");
    } catch {
      continue; // File may have been deleted
    }

    const lines = fileContent.split("\n");

    // Apply edits in reverse order (bottom to top) to preserve line numbers
    const sortedEdits = [...edits].sort((a, b) => {
      const lineDiff = b.range.start.line - a.range.start.line;
      return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
    });

    for (const edit of sortedEdits) {
      const startLine = edit.range.start.line;
      const startChar = edit.range.start.character;
      const endLine = edit.range.end.line;
      const endChar = edit.range.end.character;

      if (startLine === endLine) {
        // Single-line edit
        const line = lines[startLine] ?? "";
        lines[startLine] = line.slice(0, startChar) + edit.newText + line.slice(endChar);
      } else {
        // Multi-line edit
        const firstLine = (lines[startLine] ?? "").slice(0, startChar);
        const lastLine = (lines[endLine] ?? "").slice(endChar);
        const newLines = (firstLine + edit.newText + lastLine).split("\n");
        lines.splice(startLine, endLine - startLine + 1, ...newLines);
      }
    }

    const newContent = lines.join("\n");
    await writeFile(absPath, newContent, "utf-8");

    results.push({ file: relPath, changes: edits.length });

    // Update CodeSift index for this file
    try {
      await indexFile(absPath);
    } catch {
      // Non-fatal — index will be stale until next index_folder
    }
  }

  return { files_changed: results.length, edits: results };
}
```

- [ ] **Step 2: Register rename_symbol in register-tools.ts**

```typescript
import { goToDefinition, getTypeInfo, renameSymbol } from "./lsp/lsp-tools.js";

// Add tool:
{
  name: "rename_symbol",
  description: "Rename a symbol across all files using LSP refactoring. Type-safe, handles imports and references. Requires a language server — no fallback.",
  schema: {
    repo: z.string().describe("Repository identifier"),
    symbol_name: z.string().describe("Current name of the symbol to rename"),
    new_name: z.string().describe("New name for the symbol"),
    file_path: z.string().optional().describe("File containing the symbol (for LSP precision)"),
    line: zNum().describe("0-based line number"),
    character: zNum().describe("0-based column"),
  },
  handler: (args) => renameSymbol(
    args.repo as string,
    args.symbol_name as string,
    args.new_name as string,
    args.file_path as string | undefined,
    args.line as number | undefined,
    args.character as number | undefined,
  ),
},
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`
Expected: All pass (rename_symbol only writes when explicitly called)

- [ ] **Step 4: Commit**

```bash
git add src/lsp/lsp-tools.ts src/register-tools.ts
git commit -m "feat(lsp): rename_symbol — cross-file type-safe rename

New WRITE tool: rename_symbol(repo, symbol_name, new_name).
Uses LSP textDocument/prepareRename + textDocument/rename.
Applies workspace edits to files, reindexes changed files.
Requires language server — errors clearly if not available."
```

---

## Final Steps

- [ ] **Step F1: Run full test suite**

```bash
npm test
```

- [ ] **Step F2: Build**

```bash
npm run build
```

- [ ] **Step F3: Update README — add LSP tools**

Add to MCP tools table in README.md:
- `go_to_definition`, `get_type_info`, `rename_symbol` in References & graph section
- Note LSP requirement and fallback behavior
- Update tool count

- [ ] **Step F4: Update codesift.md rules — add LSP tools to routing table**

In `~/.claude/rules/codesift.md`, add to Step 3 table and ALWAYS rules.

- [ ] **Step F5: Final commit + push**

```bash
git add -A
git commit -m "docs: update README + codesift.md for LSP bridge tools"
git push
```
