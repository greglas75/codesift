import { describe, it, expect, vi, beforeEach } from "vitest";
import { findExtensionFunctions, analyzeSealedHierarchy, traceSuspendChain, analyzeKmpDeclarations } from "../../src/tools/kotlin-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// Mock getCodeIndex
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

const { getCodeIndex } = await import("../../src/tools/index-tools.js");

function makeSymbol(overrides: Partial<CodeSymbol>): CodeSymbol {
  return {
    id: `test:${overrides.file ?? "test.kt"}:${overrides.name ?? "sym"}:${overrides.start_line ?? 1}`,
    repo: "test",
    name: overrides.name ?? "sym",
    kind: overrides.kind ?? "function",
    file: overrides.file ?? "test.kt",
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 10,
    tokens: [],
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[], files?: Array<{ path: string }>): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    files: files ?? symbols
      .map((s) => s.file)
      .filter((f, i, a) => a.indexOf(f) === i)
      .map((path) => ({ path, language: "kotlin", symbol_count: 0, last_modified: 0, mtime_ms: 0 })),
    symbols,
  };
}

// ---------------------------------------------------------------------------
// find_extension_functions
// ---------------------------------------------------------------------------

describe("findExtensionFunctions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds extension functions matching receiver type", async () => {
    const index = makeIndex([
      makeSymbol({ name: "toSlug", kind: "function", signature: "String.()", file: "utils.kt", start_line: 1 }),
      makeSymbol({ name: "capitalize", kind: "function", signature: "String.(): String", file: "utils.kt", start_line: 5 }),
      makeSymbol({ name: "first", kind: "function", signature: "List<T>.(): T", file: "collections.kt", start_line: 1 }),
      makeSymbol({ name: "greet", kind: "function", signature: "(name: String): String", file: "service.kt", start_line: 1 }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String");
    expect(result.receiver_type).toBe("String");
    expect(result.total).toBe(2);
    expect(result.extensions.map((e) => e.name).sort()).toEqual(["capitalize", "toSlug"]);
  });

  it("does not match non-extension functions", async () => {
    const index = makeIndex([
      makeSymbol({ name: "greet", kind: "function", signature: "(name: String): String" }),
      makeSymbol({ name: "process", kind: "method", signature: "(data: List<String>): Unit" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String");
    expect(result.total).toBe(0);
  });

  it("matches generic receiver types", async () => {
    const index = makeIndex([
      makeSymbol({ name: "firstOrNull", kind: "function", signature: "List<T>.(): T?" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "List");
    expect(result.total).toBe(1);
    expect(result.extensions[0]!.name).toBe("firstOrNull");
  });

  it("handles suspend extension functions", async () => {
    const index = makeIndex([
      makeSymbol({ name: "fetchAsync", kind: "function", signature: "suspend String.(): Data" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String");
    expect(result.total).toBe(1);
  });

  it("filters by file_pattern", async () => {
    const index = makeIndex([
      makeSymbol({ name: "ext1", kind: "function", signature: "String.()", file: "src/utils.kt" }),
      makeSymbol({ name: "ext2", kind: "function", signature: "String.()", file: "test/utils.kt" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String", { file_pattern: "src/" });
    expect(result.total).toBe(1);
    expect(result.extensions[0]!.name).toBe("ext1");
  });

  it("returns empty for unknown type", async () => {
    const index = makeIndex([
      makeSymbol({ name: "ext", kind: "function", signature: "String.()" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "UnknownType");
    expect(result.total).toBe(0);
    expect(result.extensions).toEqual([]);
  });

  it("throws for unknown repo", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);
    await expect(findExtensionFunctions("missing", "String")).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// analyze_sealed_hierarchy
// ---------------------------------------------------------------------------

describe("analyzeSealedHierarchy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds subtypes of a sealed class", async () => {
    const index = makeIndex(
      [
        makeSymbol({
          name: "Result",
          kind: "class",
          file: "result.kt",
          source: "sealed class Result",
        }),
        makeSymbol({
          name: "Success",
          kind: "class",
          file: "result.kt",
          start_line: 3,
          source: "data class Success(val data: String) : Result()",
        }),
        makeSymbol({
          name: "Error",
          kind: "class",
          file: "result.kt",
          start_line: 5,
          source: "data class Error(val message: String) : Result()",
        }),
        makeSymbol({
          name: "Unrelated",
          kind: "class",
          file: "other.kt",
          source: "class Unrelated",
        }),
      ],
      // No .kt files in file list → when block scan is skipped (no files to read)
      [],
    );
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeSealedHierarchy("test", "Result");
    expect(result.sealed_class.name).toBe("Result");
    expect(result.total_subtypes).toBe(2);
    expect(result.subtypes.map((s) => s.name).sort()).toEqual(["Error", "Success"]);
    expect(result.when_blocks).toHaveLength(0);
  });

  it("throws for non-sealed class", async () => {
    const index = makeIndex([
      makeSymbol({ name: "Foo", kind: "class", source: "class Foo" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    await expect(analyzeSealedHierarchy("test", "NotFound")).rejects.toThrow("not found");
  });

  it("throws for unknown repo", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);
    await expect(analyzeSealedHierarchy("missing", "Result")).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// traceSuspendChain
// ---------------------------------------------------------------------------

describe("traceSuspendChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the root function in the chain", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "fetchUser",
        kind: "function",
        signature: "suspend (id: Int): User",
        file: "UserRepo.kt",
        start_line: 10,
        source: `suspend fun fetchUser(id: Int): User {
    return withContext(Dispatchers.IO) {
        api.getUser(id)
    }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "fetchUser");
    expect(result.root).toBe("fetchUser");
    expect(result.chain).toContain("fetchUser");
  });

  it("detects Dispatchers.IO transition inside the chain", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "fetchUser",
        kind: "function",
        signature: "suspend (id: Int): User",
        source: `suspend fun fetchUser(id: Int): User {
    return withContext(Dispatchers.IO) { api.getUser(id) }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "fetchUser");
    expect(result.dispatcher_transitions).toHaveLength(1);
    expect(result.dispatcher_transitions[0]!.dispatcher).toBe("IO");
    expect(result.dispatcher_transitions[0]!.function).toBe("fetchUser");
  });

  it("detects injected DispatcherProvider field (dispatchers.io lowercase)", async () => {
    // Real-world Android pattern — CoroutineDispatchers provider is injected
    // and the suspend function uses `dispatchers.io` (lowercase). This is the
    // Google-recommended testable pattern and appears in tgmdev-tgm-panel-mobilapp.
    const index = makeIndex([
      makeSymbol({
        name: "saveToken",
        kind: "method",
        signature: "suspend (token: String): Unit",
        source: `suspend fun saveToken(token: String) {
    withContext(dispatchers.io) {
        prefs.edit { putString("token", token) }
    }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "saveToken");
    expect(result.dispatcher_transitions).toHaveLength(1);
    expect(result.dispatcher_transitions[0]!.dispatcher).toBe("IO");
  });

  it("detects ioDispatcher parameter convention", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "loadList",
        kind: "method",
        signature: "suspend (): List<Item>",
        source: `suspend fun loadList(): List<Item> = withContext(ioDispatcher) {
    api.fetchAll()
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "loadList");
    expect(result.dispatcher_transitions).toHaveLength(1);
    expect(result.dispatcher_transitions[0]!.dispatcher).toBe("IO");
  });

  it("detects mainDispatcher / defaultDispatcher conventions", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "postResult",
        kind: "method",
        signature: "suspend (r: Result): Unit",
        source: `suspend fun postResult(r: Result) {
    withContext(mainDispatcher) { view.render(r) }
    withContext(defaultDispatcher) { compute(r) }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "postResult");
    expect(result.dispatcher_transitions).toHaveLength(2);
    const kinds = result.dispatcher_transitions.map((t) => t.dispatcher).sort();
    expect(kinds).toEqual(["Default", "Main"]);
  });

  it("warns about runBlocking inside a suspend function", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "doWork",
        kind: "function",
        signature: "suspend (): Unit",
        source: `suspend fun doWork() {
    runBlocking {
        delay(1000)
    }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "doWork");
    const runBlockingWarning = result.warnings.find((w) =>
      w.message.toLowerCase().includes("runblocking"),
    );
    expect(runBlockingWarning).toBeDefined();
    expect(runBlockingWarning!.function).toBe("doWork");
  });

  it("warns about Thread.sleep inside a suspend function", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "slowOp",
        kind: "function",
        signature: "suspend (): Unit",
        source: `suspend fun slowOp() {
    Thread.sleep(500)
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "slowOp");
    const threadSleepWarning = result.warnings.find((w) =>
      w.message.toLowerCase().includes("thread.sleep"),
    );
    expect(threadSleepWarning).toBeDefined();
  });

  it("warns about while(true) loops without ensureActive/isActive", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "pollUpdates",
        kind: "function",
        signature: "suspend (): Unit",
        source: `suspend fun pollUpdates() {
    while (true) {
        val update = api.poll()
        process(update)
    }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "pollUpdates");
    const loopWarning = result.warnings.find((w) =>
      w.message.toLowerCase().includes("ensureactive") ||
      w.message.toLowerCase().includes("cancellable"),
    );
    expect(loopWarning).toBeDefined();
  });

  it("does NOT warn about while(true) when ensureActive is present", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "pollUpdates",
        kind: "function",
        signature: "suspend (): Unit",
        source: `suspend fun pollUpdates() {
    while (true) {
        ensureActive()
        val update = api.poll()
    }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "pollUpdates");
    const loopWarning = result.warnings.find((w) =>
      w.message.toLowerCase().includes("ensureactive"),
    );
    expect(loopWarning).toBeUndefined();
  });

  it("excludes non-suspend functions from the chain", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "fetchUser",
        kind: "function",
        signature: "(id: Int): User", // non-suspend
        source: `fun fetchUser(id: Int): User = api.getUser(id)`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    await expect(traceSuspendChain("test", "fetchUser")).rejects.toThrow(/not a suspend/i);
  });

  it("throws when function is not found", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(makeIndex([]));
    await expect(traceSuspendChain("test", "nonExistent")).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// analyzeKmpDeclarations
// ---------------------------------------------------------------------------

describe("analyzeKmpDeclarations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches a commonMain expect with an androidMain actual", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "Platform",
        kind: "class",
        file: "shared/src/commonMain/kotlin/Platform.kt",
        meta: { kmp_modifier: "expect" },
      }),
      makeSymbol({
        name: "Platform",
        kind: "class",
        file: "shared/src/androidMain/kotlin/Platform.kt",
        meta: { kmp_modifier: "actual" },
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeKmpDeclarations("test");
    expect(result.total_expects).toBe(1);
    expect(result.fully_matched).toBe(1);
    expect(result.missing_actuals).toHaveLength(0);
    expect(result.orphan_actuals).toHaveLength(0);
  });

  it("reports missing actuals when iosMain has no implementation", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "Platform",
        kind: "class",
        file: "shared/src/commonMain/kotlin/Platform.kt",
        meta: { kmp_modifier: "expect" },
      }),
      makeSymbol({
        name: "Platform",
        kind: "class",
        file: "shared/src/androidMain/kotlin/Platform.kt",
        meta: { kmp_modifier: "actual" },
      }),
    ], [
      { path: "shared/src/commonMain/kotlin/Platform.kt", language: "kotlin", symbol_count: 1, last_modified: 0 },
      { path: "shared/src/androidMain/kotlin/Platform.kt", language: "kotlin", symbol_count: 1, last_modified: 0 },
      { path: "shared/src/iosMain/kotlin/Other.kt", language: "kotlin", symbol_count: 0, last_modified: 0 },
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeKmpDeclarations("test");
    expect(result.missing_actuals).toHaveLength(1);
    expect(result.missing_actuals[0]!.name).toBe("Platform");
    expect(result.missing_actuals[0]!.missing_from).toContain("iosMain");
  });

  it("reports orphan actuals without a matching expect", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "Logger",
        kind: "class",
        file: "shared/src/androidMain/kotlin/Logger.kt",
        meta: { kmp_modifier: "actual" },
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeKmpDeclarations("test");
    expect(result.orphan_actuals).toHaveLength(1);
    expect(result.orphan_actuals[0]!.name).toBe("Logger");
    expect(result.orphan_actuals[0]!.source_set).toBe("androidMain");
  });

  it("parses source set from androidMain/iosMain/jvmMain/jsMain paths", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "Fetcher",
        kind: "function",
        file: "shared/src/commonMain/kotlin/net/Fetcher.kt",
        meta: { kmp_modifier: "expect" },
        signature: "suspend (): String",
      }),
      makeSymbol({
        name: "Fetcher",
        kind: "function",
        file: "shared/src/jvmMain/kotlin/net/Fetcher.kt",
        meta: { kmp_modifier: "actual" },
        signature: "suspend (): String",
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeKmpDeclarations("test");
    expect(result.fully_matched).toBe(1);
  });

  it("returns zeroes on a non-KMP project (no expect/actual symbols)", async () => {
    const index = makeIndex([
      makeSymbol({ name: "Plain", kind: "class", file: "src/main/kotlin/Plain.kt" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeKmpDeclarations("test");
    expect(result.total_expects).toBe(0);
    expect(result.fully_matched).toBe(0);
    expect(result.missing_actuals).toHaveLength(0);
    expect(result.orphan_actuals).toHaveLength(0);
  });
});
