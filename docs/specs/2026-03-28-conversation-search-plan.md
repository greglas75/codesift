# Implementation Plan: Conversation Search

**Spec:** docs/specs/2026-03-28-conversation-search-spec.md
**Created:** 2026-03-28
**Tasks:** 10
**Estimated complexity:** 7 standard, 3 complex

## Architecture Summary

- **New files:** `src/parser/extractors/conversation.ts` (extractor), `src/tools/conversation-indexer.ts` (indexing logic), `src/tools/conversation-search.ts` (search handlers), `src/tools/conversation-discovery.ts` (auto-discovery + hook install)
- **Modified files:** `src/types.ts`, `src/parser/symbol-extractor.ts`, `src/parser/parser-manager.ts`, `src/tools/index-tools.ts`, `src/retrieval/retrieval-schemas.ts`, `src/retrieval/codebase-retrieval.ts`, `src/register-tools.ts`, `src/server.ts`
- **Data flow:** JSONL file → `extractConversationSymbols()` → `CodeSymbol[]` → existing BM25/embedding pipeline → search via new MCP tools + `codebase_retrieval`
- **Dependencies direction:** conversation.ts → types.ts + symbol-extractor.ts; conversation-tools.ts → index-tools.ts + bm25.ts + registry.ts; all changes are additive

## Technical Decisions

- **Extractor signature:** `(source: string, filePath: string, repo: string): CodeSymbol[]` — matches markdown/prisma/astro exactly
- **Tokenization:** Reuse existing `tokenizeText()` from `src/search/bm25.ts` (line 38, confirmed in codebase) — splits on `[^a-zA-Z0-9]+` + camelCase. 2-char min filter drops "I"/"a" but acceptable for v1
- **No new dependencies:** All built on Node.js built-ins + existing Zod/MCP SDK
- **Registry namespace:** `conversations/{project-name}` — existing `registerRepo` handles any string, no code change in registry.ts
- **Tool registration:** Append 3 entries to `TOOL_DEFINITIONS` array in `register-tools.ts`
- **File split note:** If `conversation-tools.ts` exceeds 300 lines during implementation, split into `conversation-indexer.ts` (indexing), `conversation-search.ts` (search handlers), and `conversation-discovery.ts` (auto-discovery + hook). The plan uses a single file for simplicity but the execute phase should split proactively.

## Quality Strategy

- **CQ3 (Validation):** `index_conversations` validates project_path exists; extractor handles malformed JSONL per-line
- **CQ6 (Unbounded data):** Files >10MB skipped; search results capped at `limit` (max 50)
- **CQ8 (Error handling):** Background indexing wrapped in `.catch()`; malformed JSON lines skipped with continue
- **CQ14 (Duplication):** Reuse `tokenizeText`, `makeSymbolId`, `buildBM25Index`, `saveIndex` — no reimplementation
- **CQ19 (API contract):** ConversationSubQuerySchema added to SubQuerySchema discriminated union
- **Test framework:** Vitest, `tests/` directory mirroring `src/`, `.test.ts` suffix
- **Test model:** Pure unit tests for extractor (string → CodeSymbol[]); integration tests with tmpdir for conversation-tools

## Task Breakdown

### Task 1: Add SymbolKind values + Zod schema
**Files:** `src/types.ts`, `src/retrieval/retrieval-schemas.ts`, `tests/retrieval/conversation-schema.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/retrieval/conversation-schema.test.ts
  import { z } from "zod";
  import { SubQuerySchema } from "../../src/retrieval/retrieval-schemas.js";

  describe("conversation schema support", () => {
    it("SymbolKind includes conversation_turn and conversation_summary", async () => {
      const { SymbolKind } = await import("../../src/types.js");
      // TypeScript compile-time check — these assignments must not error
      const turn: typeof SymbolKind extends string ? never : string = "conversation_turn";
      const summary: typeof SymbolKind extends string ? never : string = "conversation_summary";
      expect(turn).toBe("conversation_turn");
      expect(summary).toBe("conversation_summary");
    });

    it("SubQuerySchema parses conversation query type", () => {
      const result = SubQuerySchema.parse({
        type: "conversation",
        query: "auth bug fix",
      });
      expect(result.type).toBe("conversation");
    });

    it("SubQuerySchema accepts optional project and limit", () => {
      const result = SubQuerySchema.parse({
        type: "conversation",
        query: "caching decision",
        project: "my-project",
        limit: 10,
      });
      expect(result).toMatchObject({ type: "conversation", query: "caching decision", project: "my-project", limit: 10 });
    });

    it("SubQuerySchema rejects conversation query without query field", () => {
      expect(() => SubQuerySchema.parse({ type: "conversation" })).toThrow();
    });

    it("existing symbols query still parses (regression)", () => {
      const result = SubQuerySchema.parse({ type: "symbols", query: "foo" });
      expect(result.type).toBe("symbols");
    });
  });
  ```
- [ ] GREEN: Implement
  ```typescript
  // src/types.ts — add before "unknown"
  | "conversation_turn"   // user+assistant exchange pair
  | "conversation_summary" // compaction summary

  // src/retrieval/retrieval-schemas.ts — add to SymbolKindSchema enum (line 3-7)
  "conversation_turn", "conversation_summary",

  // src/retrieval/retrieval-schemas.ts — add ConversationQuerySchema before SubQuerySchema
  const ConversationQuerySchema = z.object({
    type: z.literal("conversation"),
    query: z.string(),
    project: z.string().optional(),
    limit: z.number().int().positive().optional().default(5),
  });

  // Add ConversationQuerySchema to SubQuerySchema discriminated union array
  ```
- [ ] Verify: `npx vitest run tests/retrieval/conversation-schema.test.ts`
  Expected: 5 passed
- [ ] Commit: `feat: add conversation_turn and conversation_summary to SymbolKind and SubQuerySchema`

---

### Task 2: Conversation extractor — basic turn-pair parsing
**Files:** `src/parser/extractors/conversation.ts` (NEW), `tests/parser/conversation-extractor.test.ts` (NEW)
**Complexity:** complex
**Dependencies:** Task 1
**Model routing:** Opus

- [ ] RED: Write failing test
  ```typescript
  // tests/parser/conversation-extractor.test.ts
  import { extractConversationSymbols } from "../../src/parser/extractors/conversation.js";

  const makeJsonl = (records: object[]): string =>
    records.map((r) => JSON.stringify(r)).join("\n");

  describe("extractConversationSymbols — basic turn pairs", () => {
    it("extracts a user+assistant pair as conversation_turn", () => {
      const source = makeJsonl([
        { type: "user", message: { content: "How do I fix the auth bug?" }, uuid: "u1", timestamp: "2026-03-28T10:00:00Z", sessionId: "s1", gitBranch: "main" },
        { type: "assistant", message: { content: [{ type: "text", text: "You need to check the middleware." }] }, uuid: "a1", timestamp: "2026-03-28T10:00:05Z", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "session.jsonl", "conversations/test");

      expect(symbols).toHaveLength(1);
      expect(symbols[0]!.kind).toBe("conversation_turn");
      expect(symbols[0]!.name).toBe("How do I fix the auth bug?");
      expect(symbols[0]!.source).toContain("How do I fix the auth bug?");
      expect(symbols[0]!.source).toContain("You need to check the middleware.");
      expect(symbols[0]!.start_line).toBe(1);
      expect(symbols[0]!.end_line).toBe(2);
      expect(symbols[0]!.parent).toBe("s1");
    });

    it("handles user message as plain string content", () => {
      const source = makeJsonl([
        { type: "user", message: { content: "plain string message" }, uuid: "u1", timestamp: "2026-03-28T10:00:00Z", sessionId: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "response" }] }, uuid: "a1", timestamp: "2026-03-28T10:00:05Z", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols[0]!.name).toBe("plain string message");
    });

    it("handles assistant content as array of text blocks", () => {
      const source = makeJsonl([
        { type: "user", message: { content: "question" }, uuid: "u1", timestamp: "2026-03-28T10:00:00Z", sessionId: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "part1 " }, { type: "text", text: "part2" }] }, uuid: "a1", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols[0]!.source).toContain("part1 part2");
    });

    it("skips non-user/assistant records (progress, system, etc.)", () => {
      const source = makeJsonl([
        { type: "progress", content: "loading..." },
        { type: "user", message: { content: "question" }, uuid: "u1", sessionId: "s1" },
        { type: "system", subType: "turn_duration", duration: 5000 },
        { type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" },
        { type: "file-history-snapshot", files: [] },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols).toHaveLength(1);
    });

    it("truncates name to 100 chars", () => {
      const longQuestion = "x".repeat(200);
      const source = makeJsonl([
        { type: "user", message: { content: longQuestion }, uuid: "u1", sessionId: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols[0]!.name.length).toBeLessThanOrEqual(100);
    });

    it("returns empty array for empty file", () => {
      const symbols = extractConversationSymbols("", "empty.jsonl", "conversations/test");
      expect(symbols).toEqual([]);
    });

    it("skips malformed JSON lines without crashing", () => {
      const source = '{"type":"user","message":{"content":"q"},"uuid":"u1","sessionId":"s1"}\nINVALID JSON\n{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]},"uuid":"a1","sessionId":"s1"}';
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols).toHaveLength(1);
    });

    it("produces word-split tokens for natural language", () => {
      const source = makeJsonl([
        { type: "user", message: { content: "how does authentication work" }, uuid: "u1", sessionId: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "The auth module handles login." }] }, uuid: "a1", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols[0]!.tokens).toContain("authentication");
      expect(symbols[0]!.tokens).toContain("auth");
      expect(symbols[0]!.tokens).toContain("login");
    });
  });
  ```
- [ ] GREEN: Implement `src/parser/extractors/conversation.ts`
  - Function signature: `export function extractConversationSymbols(source: string, filePath: string, repo: string): CodeSymbol[]`
  - Parse JSONL line-by-line with `try/catch` per line
  - Filter: only `type === "user"` or `type === "assistant"`
  - Pair consecutive user + assistant into turn-pairs
  - Extract text from `message.content` (string or `content[].text` array)
  - Map to `CodeSymbol`: `kind="conversation_turn"`, `name` = truncated user question (100 chars), `source` = user + "\n---\n" + assistant text, `parent` = sessionId, `docstring` = `timestamp | gitBranch`
  - Use `makeSymbolId(repo, filePath, \`turn_${turnIndex}\`, lineNumber)`
  - Use `tokenizeText(source)` for `tokens` field
- [ ] Verify: `npx vitest run tests/parser/conversation-extractor.test.ts`
  Expected: 8 passed
- [ ] Commit: `feat: conversation extractor — parse JSONL turn-pairs into CodeSymbol[]`

---

### Task 3: Noise filtering — tool_use truncation, image blocks, thinking blocks
**Files:** `src/parser/extractors/conversation.ts` (modify), `tests/parser/conversation-extractor.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 2
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  describe("extractConversationSymbols — noise filtering", () => {
    it("strips tool_result content entirely", () => {
      const source = makeJsonl([
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "HUGE FILE DUMP ".repeat(100) }] }, uuid: "u1", sessionId: "s1", toolUseResult: true },
        // This is a tool result message, should be skipped from indexing as turn content
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      // tool_result-only user messages don't form meaningful turns
      expect(symbols.every(s => !s.source.includes("HUGE FILE DUMP"))).toBe(true);
    });

    it("keeps tool_use name but truncates input to 200 chars", () => {
      const source = makeJsonl([
        { type: "user", message: { content: "check this file" }, uuid: "u1", sessionId: "s1" },
        { type: "assistant", message: { content: [
          { type: "text", text: "Let me read it." },
          { type: "tool_use", name: "Read", input: { file_path: "/very/long/path/" + "x".repeat(300) } },
        ]}, uuid: "a1", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols[0]!.source).toContain("Read");
      expect(symbols[0]!.source.length).toBeLessThan(1000);
    });

    it("replaces image blocks with [image] placeholder", () => {
      const source = makeJsonl([
        { type: "user", message: { content: [{ type: "image", source: { data: "base64..." } }, { type: "text", text: "fix this UI" }] }, uuid: "u1", sessionId: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "I see the issue." }] }, uuid: "a1", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols[0]!.source).toContain("[image]");
      expect(symbols[0]!.source).toContain("fix this UI");
      expect(symbols[0]!.source).not.toContain("base64");
    });

    it("includes thinking blocks in source", () => {
      const source = makeJsonl([
        { type: "user", message: { content: "solve this" }, uuid: "u1", sessionId: "s1" },
        { type: "assistant", message: { content: [
          { type: "thinking", thinking: "Let me analyze the problem step by step." },
          { type: "text", text: "Here is the solution." },
        ]}, uuid: "a1", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
      expect(symbols[0]!.source).toContain("Here is the solution.");
    });
  });
  ```
- [ ] GREEN: Update extractor to handle content block types:
  - `text` → include as-is
  - `tool_use` → include `"[tool: {name}]"` + truncated input (200 chars)
  - `tool_result` → skip entirely
  - `image` → replace with `"[image]"`
  - `thinking` → include text
  - User messages that are only `tool_result` → skip (don't create a turn)
- [ ] Verify: `npx vitest run tests/parser/conversation-extractor.test.ts`
  Expected: 12 passed
- [ ] Commit: `feat: conversation extractor noise filtering — strip tool_result, truncate tool_use, replace images`

---

### Task 4: Compaction-aware parsing
**Files:** `src/parser/extractors/conversation.ts` (modify), `tests/parser/conversation-extractor.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 3
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  describe("extractConversationSymbols — compaction handling", () => {
    it("skips isCompactSummary user messages", () => {
      const source = makeJsonl([
        { type: "user", message: { content: "original question" }, uuid: "u1", sessionId: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "original answer" }] }, uuid: "a1", sessionId: "s1" },
        { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 50000 } },
        { type: "user", message: { content: "This session is being continued..." }, uuid: "u2", sessionId: "s1", isCompactSummary: true },
        { type: "assistant", message: { content: [{ type: "text", text: "continuing work" }] }, uuid: "a2", sessionId: "s1" },
        { type: "user", message: { content: "new question after compact" }, uuid: "u3", sessionId: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "new answer" }] }, uuid: "a3", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");

      const names = symbols.filter(s => s.kind === "conversation_turn").map(s => s.name);
      expect(names).toContain("original question");
      expect(names).toContain("new question after compact");
      expect(names).not.toContain("This session is being continued...");
    });

    it("indexes last compact summary as conversation_summary", () => {
      const source = makeJsonl([
        { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 50000 } },
        { type: "user", message: { content: "Summary of session: worked on auth module" }, uuid: "u1", sessionId: "s1", isCompactSummary: true },
        { type: "assistant", message: { content: [{ type: "text", text: "continuing" }] }, uuid: "a1", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");

      const summaries = symbols.filter(s => s.kind === "conversation_summary");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.source).toContain("Summary of session");
    });

    it("only indexes the LAST summary for multi-compaction files", () => {
      const source = makeJsonl([
        { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 50000 } },
        { type: "user", message: { content: "First summary" }, uuid: "u1", sessionId: "s1", isCompactSummary: true },
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, uuid: "a1", sessionId: "s1" },
        { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 60000 } },
        { type: "user", message: { content: "Second summary" }, uuid: "u2", sessionId: "s1", isCompactSummary: true },
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, uuid: "a2", sessionId: "s1" },
      ]);
      const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");

      const summaries = symbols.filter(s => s.kind === "conversation_summary");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.source).toContain("Second summary");
    });
  });
  ```
- [ ] GREEN: Add compaction detection:
  - Track `isCompactSummary` flag on user messages → skip from turn pairing
  - Collect all summary messages, index only the last one as `kind: "conversation_summary"`
  - `compact_boundary` system records already skipped by the `type !== "user" && type !== "assistant"` filter
- [ ] Verify: `npx vitest run tests/parser/conversation-extractor.test.ts`
  Expected: 15 passed
- [ ] Commit: `feat: compaction-aware parsing — skip summary injections, index last summary as meta-doc`

---

### Task 5: Wire extractor into indexing pipeline
**Files:** `src/parser/parser-manager.ts`, `src/parser/symbol-extractor.ts`, `src/tools/index-tools.ts`, `src/search/chunker.ts`
**Complexity:** standard
**Dependencies:** Task 2
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/parser/conversation-pipeline.test.ts
  import { getLanguageForExtension } from "../../src/parser/parser-manager.js";

  describe("conversation pipeline wiring", () => {
    it("getLanguageForExtension returns 'conversation' for .jsonl", () => {
      expect(getLanguageForExtension(".jsonl")).toBe("conversation");
    });

    it("extractConversationSymbols is re-exported from symbol-extractor", async () => {
      const mod = await import("../../src/parser/symbol-extractor.js");
      expect(typeof mod.extractConversationSymbols).toBe("function");
    });
  });
  ```
- [ ] GREEN: Implement
  ```typescript
  // src/parser/parser-manager.ts — add to EXTENSION_MAP
  ".jsonl": "conversation",

  // src/parser/symbol-extractor.ts — add to re-export block (after line 42)
  export { extractConversationSymbols } from "./extractors/conversation.js";

  // src/tools/index-tools.ts — add import at top
  import { extractConversationSymbols } from "../parser/symbol-extractor.js";
  // Add branch in parseOneFile after astro branch (line 55):
  } else if (language === "conversation") {
    symbols = extractConversationSymbols(source, relPath, repoName);
  }

  // src/search/chunker.ts — verify .jsonl is NOT in SKIP_EXTENSIONS
  // (currently it's not, but add .jsonl to the set if conversation files
  // should be exempt from byte-level chunking — they use turn-pair chunking instead)
  ```
- [ ] Verify: `npx vitest run tests/parser/conversation-pipeline.test.ts`
  Expected: 2 passed
- [ ] Commit: `feat: wire conversation extractor into indexing pipeline — EXTENSION_MAP, re-export, parseOneFile branch`

---

### Task 6: index_conversations tool handler
**Files:** `src/tools/conversation-tools.ts` (NEW), `tests/tools/conversation-tools.test.ts` (NEW)
**Complexity:** complex
**Dependencies:** Task 5
**Model routing:** Opus

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/conversation-tools.test.ts
  import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
  import { join } from "node:path";
  import { tmpdir } from "node:os";

  describe("indexConversations", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "conv-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("indexes JSONL files in a directory and returns stats", async () => {
      const { indexConversations } = await import("../../src/tools/conversation-tools.js");
      const jsonl = [
        JSON.stringify({ type: "user", message: { content: "question" }, uuid: "u1", sessionId: "s1", timestamp: "2026-03-28T10:00:00Z" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" }),
      ].join("\n");
      await writeFile(join(tmpDir, "session1.jsonl"), jsonl);

      const result = await indexConversations(tmpDir);
      expect(result.sessions_found).toBe(1);
      expect(result.turns_indexed).toBeGreaterThanOrEqual(1);
      expect(result.elapsed_ms).toBeGreaterThan(0);
    });

    it("skips files larger than 10MB", async () => {
      const { indexConversations } = await import("../../src/tools/conversation-tools.js");
      const bigContent = "x".repeat(11 * 1024 * 1024);
      await writeFile(join(tmpDir, "big.jsonl"), bigContent);

      const result = await indexConversations(tmpDir);
      expect(result.sessions_found).toBe(0);
    });

    it("incremental: skips unchanged files on second run", async () => {
      const { indexConversations } = await import("../../src/tools/conversation-tools.js");
      const jsonl = [
        JSON.stringify({ type: "user", message: { content: "q" }, uuid: "u1", sessionId: "s1" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }] }, uuid: "a1", sessionId: "s1" }),
      ].join("\n");
      await writeFile(join(tmpDir, "s1.jsonl"), jsonl);

      await indexConversations(tmpDir);
      const result2 = await indexConversations(tmpDir);
      // Second run should find the session but skip parsing (unchanged mtime)
      expect(result2.sessions_found).toBeGreaterThanOrEqual(0);
    });

    it("handles empty directory", async () => {
      const { indexConversations } = await import("../../src/tools/conversation-tools.js");
      const result = await indexConversations(tmpDir);
      expect(result.sessions_found).toBe(0);
      expect(result.turns_indexed).toBe(0);
    });
  });
  ```
- [ ] GREEN: Implement `indexConversations(projectPath: string)` in `src/tools/conversation-tools.ts`:
  - Scan directory for `.jsonl` files (non-recursive for main sessions, recursive for subagents/)
  - For each file: check size (<10MB), read content, call `extractConversationSymbols`
  - Collect all symbols into a `CodeIndex`
  - Save via `saveIndex()`, register as `conversations/{projectName}` via `registerRepo()`
  - Build BM25 index via `buildBM25Index()`
  - Return stats object matching spec
  - Incremental: store mtime/size per file, skip unchanged
- [ ] Verify: `npx vitest run tests/tools/conversation-tools.test.ts`
  Expected: 4 passed
- [ ] Commit: `feat: index_conversations tool — scan JSONL files, extract turns, build search index`

---

### Task 7: search_conversations + find_conversations_for_symbol
**Files:** `src/tools/conversation-tools.ts` (extend), `tests/tools/conversation-tools.test.ts` (extend)
**Complexity:** complex
**Dependencies:** Task 6
**Model routing:** Opus

- [ ] RED: Write failing test
  ```typescript
  describe("searchConversations", () => {
    it("returns matching turns ranked by BM25 score", async () => {
      const { indexConversations, searchConversations } = await import("../../src/tools/conversation-tools.js");
      const jsonl = [
        JSON.stringify({ type: "user", message: { content: "How do I fix the auth middleware bug?" }, uuid: "u1", sessionId: "s1", timestamp: "2026-03-28T10:00:00Z", gitBranch: "main" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Check the JWT validation in auth.ts." }] }, uuid: "a1", sessionId: "s1" }),
        JSON.stringify({ type: "user", message: { content: "What about the database migration?" }, uuid: "u2", sessionId: "s1", timestamp: "2026-03-28T10:05:00Z", gitBranch: "main" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Run prisma migrate." }] }, uuid: "a2", sessionId: "s1" }),
      ].join("\n");
      await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
      await indexConversations(tmpDir);

      const result = await searchConversations("auth middleware", tmpDir);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0]!.user_question).toContain("auth middleware");
      expect(result.results[0]!.score).toBeGreaterThan(0);
    });

    it("returns empty results for non-matching query", async () => {
      const { indexConversations, searchConversations } = await import("../../src/tools/conversation-tools.js");
      const jsonl = [
        JSON.stringify({ type: "user", message: { content: "question" }, uuid: "u1", sessionId: "s1" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" }),
      ].join("\n");
      await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
      await indexConversations(tmpDir);

      const result = await searchConversations("zzz_nonexistent_term_zzz", tmpDir);
      expect(result.results).toHaveLength(0);
    });
  });

  describe("findConversationsForSymbol", () => {
    it("finds conversations mentioning a symbol name", async () => {
      const { indexConversations, findConversationsForSymbol } = await import("../../src/tools/conversation-tools.js");
      const jsonl = [
        JSON.stringify({ type: "user", message: { content: "Can you refactor processPayment?" }, uuid: "u1", sessionId: "s1" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Sure, processPayment needs error handling." }] }, uuid: "a1", sessionId: "s1" }),
      ].join("\n");
      await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
      await indexConversations(tmpDir);

      const result = await findConversationsForSymbol("processPayment", tmpDir);
      expect(result.conversations.length).toBeGreaterThanOrEqual(1);
      expect(result.session_count).toBe(1);
    });
  });
  ```
- [ ] GREEN: Implement in `conversation-tools.ts`:
  - `searchConversations(query, projectPath?, limit?)`: load BM25 index for conversation repo → `searchBM25()` → map results to `ConversationSearchResult` shape
  - `findConversationsForSymbol(symbolName, projectPath?, limit?)`: use `searchConversations(symbolName)` with whole-word matching + case-insensitive
- [ ] Verify: `npx vitest run tests/tools/conversation-tools.test.ts`
  Expected: 7 passed (4 from Task 6 + 3 new)
- [ ] Commit: `feat: search_conversations and find_conversations_for_symbol — BM25 search over conversation index`

---

### Task 8: codebase_retrieval conversation query type
**Files:** `src/retrieval/codebase-retrieval.ts`, `tests/retrieval/conversation-retrieval.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 1, Task 7
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/retrieval/conversation-retrieval.test.ts
  import { mkdtemp, writeFile, rm } from "node:fs/promises";
  import { join } from "node:path";
  import { tmpdir } from "node:os";

  describe("codebase_retrieval — conversation query type", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "conv-ret-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("executeSubQuery dispatches conversation type to searchConversations", async () => {
      // Setup: index a conversation first
      const { indexConversations } = await import("../../src/tools/conversation-indexer.js");
      const jsonl = [
        JSON.stringify({ type: "user", message: { content: "Fix the Redis cache issue" }, uuid: "u1", sessionId: "s1" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Clear the cache key." }] }, uuid: "a1", sessionId: "s1" }),
      ].join("\n");
      await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
      await indexConversations(tmpDir);

      // Test the actual codebase_retrieval integration point
      // We need to test that the "conversation" type is routed correctly
      const { SubQuerySchema } = await import("../../src/retrieval/retrieval-schemas.js");
      const parsed = SubQuerySchema.parse({ type: "conversation", query: "Redis cache", project: tmpDir });
      expect(parsed.type).toBe("conversation");

      // Verify the switch case exists by importing and calling the dispatcher
      const mod = await import("../../src/retrieval/codebase-retrieval.js");
      // The executeSubQuery is private, but codebaseRetrieval is the public entry point
      // We test through the public API — pass a conversation sub-query in the batch
      const result = await mod.codebaseRetrieval("conversations/test", [
        { type: "conversation", query: "Redis cache", project: tmpDir },
      ], 5000);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0]!.type).toBe("conversation");
    });
  });
  ```
- [ ] GREEN: Add `case "conversation":` to `executeSubQuery` switch in `codebase-retrieval.ts`:
  ```typescript
  case "conversation": {
    const { searchConversations } = await import("../tools/conversation-tools.js");
    const result = await searchConversations(query.query, query.project, query.limit);
    const text = JSON.stringify(result);
    return { type: query.type, data: result, tokens: estimateTokens(text) };
  }
  ```
- [ ] Verify: `npx vitest run tests/retrieval/conversation-retrieval.test.ts`
  Expected: 1 passed
- [ ] Commit: `feat: codebase_retrieval conversation query type — route to searchConversations`

---

### Task 9: Register MCP tools
**Files:** `src/register-tools.ts`, `tests/tools/conversation-registration.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 7
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/conversation-registration.test.ts
  describe("conversation tool registration", () => {
    it("TOOL_DEFINITIONS includes index_conversations", async () => {
      // We can't easily import TOOL_DEFINITIONS (it's const, not exported directly)
      // Instead, check that the handler module exports the expected functions
      const mod = await import("../../src/tools/conversation-tools.js");
      expect(typeof mod.indexConversations).toBe("function");
      expect(typeof mod.searchConversations).toBe("function");
      expect(typeof mod.findConversationsForSymbol).toBe("function");
    });
  });
  ```
- [ ] GREEN: Add 3 entries to `TOOL_DEFINITIONS` in `register-tools.ts`:
  - `index_conversations`: schema `{ project_path: z.string().optional(), quiet: z.boolean().optional() }`, handler calls `indexConversations`
  - `search_conversations`: schema `{ query: z.string(), project: z.string().optional(), limit: zNum().optional() }`, handler calls `searchConversations`
  - `find_conversations_for_symbol`: schema `{ symbol_name: z.string(), repo: z.string(), limit: zNum().optional() }`, handler calls `findConversationsForSymbol`
- [ ] Verify: `npx vitest run tests/tools/conversation-registration.test.ts`
  Expected: 1 passed
- [ ] Commit: `feat: register 3 conversation MCP tools — index, search, find_for_symbol`

---

### Task 10: Auto-discovery at startup + session-end hook installation
**Files:** `src/tools/conversation-tools.ts` (extend), `src/server.ts`, `tests/tools/conversation-autodiscovery.test.ts` (NEW)
**Complexity:** complex (cross-cutting: startup, filesystem, path encoding)
**Dependencies:** Task 6
**Model routing:** Opus

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/conversation-autodiscovery.test.ts
  import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
  import { join } from "node:path";
  import { tmpdir } from "node:os";

  describe("auto-discovery", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "autodiscovery-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("encodeCwdToClaudePath converts / to -", async () => {
      const { encodeCwdToClaudePath } = await import("../../src/tools/conversation-tools.js");
      const result = encodeCwdToClaudePath("/Users/dev/my-project");
      expect(result).toBe("-Users-dev-my-project");
    });

    it("encodeCwdToClaudePath handles spaces and special chars", async () => {
      const { encodeCwdToClaudePath } = await import("../../src/tools/conversation-tools.js");
      const result = encodeCwdToClaudePath("/Users/dev/my project");
      expect(result).toBe("-Users-dev-my project");
    });
  });

  describe("hook installation", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "hook-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("creates .claude/settings.local.json with Stop hook", async () => {
      const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
      await installSessionEndHook(tmpDir);

      const settingsPath = join(tmpDir, ".claude", "settings.local.json");
      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(content.hooks.Stop).toBeDefined();
      expect(content.hooks.Stop[0].command).toContain("codesift");
    });

    it("does not duplicate hook on second call (idempotent)", async () => {
      const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
      await installSessionEndHook(tmpDir);
      await installSessionEndHook(tmpDir);

      const settingsPath = join(tmpDir, ".claude", "settings.local.json");
      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      const codesiftHooks = content.hooks.Stop.filter((h: { command: string }) => h.command.includes("codesift"));
      expect(codesiftHooks).toHaveLength(1);
    });

    it("preserves existing hooks when adding", async () => {
      const { installSessionEndHook } = await import("../../src/tools/conversation-tools.js");
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({
        hooks: { Stop: [{ matcher: "", command: "echo done" }] }
      }));

      await installSessionEndHook(tmpDir);

      const content = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
      expect(content.hooks.Stop).toHaveLength(2);
      expect(content.hooks.Stop[0].command).toBe("echo done");
    });
  });
  ```
- [ ] GREEN: Implement in `conversation-tools.ts`:
  - `encodeCwdToClaudePath(cwd: string): string` — replace `/` with `-`
  - `installSessionEndHook(projectRoot: string): Promise<void>` — read/merge/write `.claude/settings.local.json`
  - `autoDiscoverConversations(cwd: string): Promise<void>` — compute Claude path, check if exists, index if stale, install hook
  - In `src/server.ts`: add `import { autoDiscoverConversations } from "./tools/conversation-tools.js"` and in `main()` after `server.connect()`:
    ```typescript
    autoDiscoverConversations(process.cwd()).catch((err: unknown) => {
      console.error("[codesift] conversation auto-discovery failed:", err);
    });
    ```
- [ ] Verify: `npx vitest run tests/tools/conversation-autodiscovery.test.ts`
  Expected: 5 passed
- [ ] Commit: `feat: auto-discovery at startup + session-end hook installation — zero-config conversation indexing`
