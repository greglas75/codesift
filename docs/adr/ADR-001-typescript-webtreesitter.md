# ADR-001: TypeScript + web-tree-sitter (WASM) as Core Stack

**Status:** Accepted
**Date:** 2026-03-13 | **Deciders:** Greg Laskowski | **Area:** Infra/Language

---

## Context

CodeSift is a full rewrite of jcodemunch-mcp — an MCP (Model Context Protocol) server that provides
21 code-intelligence tools to Claude. The original implementation was Python (forked from
jgravelle/jcodemunch-mcp, restrictive commercial license). We need a clean rewrite from scratch
with MIT license.

**Forces at play:**
- MCP SDK ecosystem has both Python and TypeScript options
- tree-sitter has bindings in Python (`tree-sitter` pip) and Node.js (native `tree-sitter` npm OR WASM `web-tree-sitter`)
- Original Python implementation had two critical bugs rooted in asyncio and threading:
  - `index_folder` blocking asyncio event loop → MCP connection timeout (-32000)
  - Background watchdog threads sharing same tmp filename → JSON corruption
- PromptVault (the primary consumer) is a TypeScript/Next.js project — same-language toolchain preferred
- The team knows TypeScript; Python is secondary

---

## Decision

We will implement CodeSift in **TypeScript** using **`web-tree-sitter`** (WASM-based tree-sitter bindings)
rather than Python with `py-tree-sitter` or Node.js native `tree-sitter` npm bindings.

---

## Options Considered

### Option A: TypeScript + web-tree-sitter (WASM) ← **CHOSEN**

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — WASM init is async, but no native build |
| Cost | Zero — all open-source, no infra |
| Scalability | Node.js single-threaded event loop + Worker threads for CPU-bound parsing |
| Team familiarity | HIGH — team writes TypeScript daily |
| Maintenance | LOW — no node-gyp, no platform-specific compilation, one language for all tooling |
| Lock-in | LOW — MCP protocol is language-agnostic; could port if needed |

**Pros:**
- `@modelcontextprotocol/sdk` TypeScript SDK is Anthropic's primary SDK — best maintained
- `web-tree-sitter` uses WASM: zero native compilation, works on macOS/Linux/Windows/CI without issues
- No asyncio: Node.js event loop + `worker_threads` for CPU-bound parsing = no blocking problem
- chokidar (file watcher) is rock-solid Node.js — no watchdog macOS issues
- Same language as PromptVault — can share types if needed
- Vitest for testing — same test runner as PromptVault

**Cons:**
- `web-tree-sitter` WASM files add ~2-5MB per language to distribution
- WASM initialization is async (must `await Parser.init()` before use)
- Slightly more complex language loading than Python's synchronous bindings

### Option B: Python + py-tree-sitter (from-scratch rewrite)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — py-tree-sitter is simpler, synchronous API |
| Cost | Zero |
| Scalability | asyncio has fundamental blocking issues for CPU-bound work (same root cause as jcodemunch crashes) |
| Team familiarity | MEDIUM — team knows Python but uses TypeScript daily |
| Maintenance | Medium — two languages in the ecosystem |
| Lock-in | LOW |

**Pros:** Better py-tree-sitter ecosystem, simpler synchronous parsing API

**Cons:**
- Would re-introduce the asyncio blocking bug we just fixed in jcodemunch
- MCP Python SDK is less mature and less actively maintained than TS SDK
- Two languages in the development ecosystem — friction for PromptVault developers
- `run_in_executor` workarounds needed for CPU-bound operations (we've been there)

### Option C: TypeScript + native tree-sitter npm bindings

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — requires node-gyp, native compilation per platform |
| Cost | Zero |
| Scalability | Same as Option A |
| Team familiarity | MEDIUM — node-gyp is painful to configure |
| Maintenance | HIGH — native builds break on Node.js version upgrades, CI/CD complexity |
| Lock-in | LOW |

**Pros:** Synchronous API, slightly faster than WASM

**Cons:**
- node-gyp compilation is notoriously fragile (Xcode versions, Python 2/3 path issues on macOS)
- Each supported language requires native compilation
- CI/CD requires build environment with native toolchain
- Breaks on Node.js major version upgrades

### Option D: Status Quo (fix jcodemunch Python in place)

We have already fixed the critical bugs in jcodemunch (thread-safe tmp filenames, run_in_executor).
However, the license issue (jgravelle restrictive commercial license) means we cannot legally use
jcodemunch for commercial purposes. A full rewrite is required regardless.

---

## Trade-off Analysis

Option A (TypeScript + web-tree-sitter) wins on team familiarity, MCP SDK quality, and operational
simplicity (no native builds). The asyncio root-cause of jcodemunch's crashes is eliminated entirely.
WASM overhead is acceptable for a developer tool (not hot path).

Option B (Python rewrite) would be better if: (a) the team were Python-primary, or (b) the MCP
Python SDK were more mature. Neither applies here.

Option C (native tree-sitter npm) provides minimal speed benefit at high maintenance cost — WASM
performance is adequate for code indexing workloads.

---

## Decision Rationale

TypeScript + web-tree-sitter is the correct choice because:

1. **Root cause elimination**: Node.js event loop + worker_threads eliminates the asyncio blocking
   bug category entirely. No `run_in_executor` workarounds needed.
2. **SDK quality**: `@modelcontextprotocol/sdk` TypeScript is Anthropic's primary, most-maintained SDK.
3. **Zero build friction**: web-tree-sitter WASM requires no native compilation — installs with `npm install`.
4. **Team alignment**: TypeScript is the team's primary language. Single-language ecosystem.
5. **Proven patterns**: Most production MCP servers (including Anthropic's own examples) are TypeScript.

---

## Consequences

- **Easier:**
  - CI/CD: `npm install && npm test` — no build environment needed
  - Onboarding: TypeScript developers can contribute without Python context
  - Type safety: full TypeScript strict mode from day 1
  - Testing: Vitest (same runner as PromptVault)
  - File watching: chokidar — battle-tested, no OS-specific quirks

- **Harder:**
  - Language loading: must `await Parser.init()` before first parse call (async WASM init)
  - Distribution size: ~2-5MB WASM per language (TypeScript, JavaScript, Python, Go, etc.)
  - Adding a new language: download `.wasm` file + write extractor (not just `pip install tree-sitter-{lang}`)

- **Revisit when:**
  - If WASM performance proves inadequate for large repos (>100k files) — evaluate native bindings
  - If MCP Python SDK matures significantly (>12 months) — evaluate Python for simpler deployment
  - If Anthropic releases an official TypeScript MCP SDK v2 with breaking changes

---

## Action Items

- [ ] Install `web-tree-sitter` + download WASM grammars for: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Ruby, PHP, Markdown
- [ ] Implement async WASM initialization in `parser/parser-manager.ts`
- [ ] Benchmark WASM parse speed on 1000-file TypeScript repo vs jcodemunch Python baseline
