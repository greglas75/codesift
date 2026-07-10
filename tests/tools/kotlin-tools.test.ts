import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExtensionFunctions, analyzeSealedHierarchy, traceSuspendChain, analyzeKmpDeclarations, traceFlowChain } from "../../src/tools/kotlin-tools.js";
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

function makeIndex(
  symbols: CodeSymbol[],
  files?: Array<{ path: string }>,
  root = "/tmp/test",
): CodeIndex {
  return {
    repo: "test",
    root,
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
      makeSymbol({ name: "toSlug", kind: "function", signature: "String.()", docstring: "Slug docs", file: "utils.kt", start_line: 1 }),
      makeSymbol({ name: "capitalize", kind: "function", signature: "String.(): String", file: "utils.kt", start_line: 5 }),
      makeSymbol({ name: "first", kind: "function", signature: "List<T>.(): T", file: "collections.kt", start_line: 1 }),
      makeSymbol({ name: "greet", kind: "function", signature: "(name: String): String", file: "service.kt", start_line: 1 }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String");
    expect(result.receiver_type).toBe("String");
    expect(result.total).toBe(2);
    expect(result.extensions.map((e) => e.name).sort()).toEqual(["capitalize", "toSlug"]);
    expect(result.extensions[0]).toMatchObject({ name: "toSlug", signature: "String.()", docstring: "Slug docs" });
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

  it("reports an exhaustive when block from a Kotlin file", async () => {
    const root = mkdtempSync(join(tmpdir(), "kotlin-sealed-"));
    try {
      writeFileSync(join(root, "usage.kt"), `fun render(value: Result) = when (value) {
  is Success -> "ok"
  is Error -> "error"
}`);
      const index = makeIndex([
        makeSymbol({ name: "Result", kind: "class", source: "sealed class Result" }),
        makeSymbol({ name: "Success", kind: "class", source: "class Success : Result()" }),
        makeSymbol({ name: "Error", kind: "class", source: "class Error : Result()" }),
      ], [{ path: "usage.kt" }], root);
      vi.mocked(getCodeIndex).mockResolvedValue(index);

      const result = await analyzeSealedHierarchy("test", "Result");

      expect(result.when_blocks).toEqual([{
        file: "usage.kt",
        line: 1,
        branches_found: ["Error", "Success"],
        branches_missing: [],
        is_exhaustive: true,
      }]);
      expect(result.all_exhaustive).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing branches in an incomplete when block", async () => {
    const root = mkdtempSync(join(tmpdir(), "kotlin-sealed-"));
    try {
      writeFileSync(join(root, "usage.kt"), `fun render(value: Result) = when (value) {
  is Success -> "ok"
}`);
      const index = makeIndex([
        makeSymbol({ name: "Result", kind: "class", source: "sealed class Result" }),
        makeSymbol({ name: "Success", kind: "class", source: "class Success : Result()" }),
        makeSymbol({ name: "Error", kind: "class", source: "class Error : Result()" }),
      ], [{ path: "usage.kt" }], root);
      vi.mocked(getCodeIndex).mockResolvedValue(index);

      const result = await analyzeSealedHierarchy("test", "Result");

      expect(result.when_blocks[0]).toMatchObject({
        branches_found: ["Success"],
        branches_missing: ["Error"],
        is_exhaustive: false,
      });
      expect(result.all_exhaustive).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a Kotlin file that cannot be read", async () => {
    const index = makeIndex([
      makeSymbol({ name: "Result", kind: "class", source: "sealed class Result" }),
    ], [{ path: "missing.kt" }], "/definitely/missing");
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeSealedHierarchy("test", "Result");

    expect(result.when_blocks).toEqual([]);
    expect(result.all_exhaustive).toBe(false);
  });

  it("propagates analysis errors after a Kotlin file is read", async () => {
    const root = mkdtempSync(join(tmpdir(), "kotlin-sealed-"));
    try {
      writeFileSync(join(root, "usage.kt"), "fun render(value: Result) = when (value) { is Success -> \"ok\" }");
      const index = makeIndex([
        makeSymbol({ name: "Result", kind: "class", source: "sealed class Result" }),
        makeSymbol({ name: "(", kind: "class", source: "class Invalid : Result()" }),
      ], [{ path: "usage.kt" }], root);
      vi.mocked(getCodeIndex).mockResolvedValue(index);

      await expect(analyzeSealedHierarchy("test", "Result")).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("classifies unconfined and custom static dispatchers while ignoring non-dispatchers", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "switchContexts",
        signature: "suspend (): Unit",
        source: `suspend fun switchContexts() {
    withContext(Dispatchers.Unconfined) { yield() }
    withContext(Dispatchers.Custom) { work() }
    withContext(coroutineContext) { finish() }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "switchContexts");

    expect(result.dispatcher_transitions.map((transition) => transition.dispatcher)).toEqual([
      "Unconfined",
      "Custom",
    ]);
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
    expect(runBlockingWarning).toMatchObject({
      function: "doWork",
      severity: "critical",
      message: "runBlocking inside a suspend function — deadlock risk on caller's dispatcher",
    });
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
    expect(threadSleepWarning).toMatchObject({
      function: "slowOp",
      severity: "critical",
      message: "Thread.sleep() in suspend function — blocks dispatcher thread, use delay() instead",
    });
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
    expect(loopWarning).toMatchObject({
      function: "pollUpdates",
      severity: "warning",
    });
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

  it("follows suspend callees only up to the requested depth", async () => {
    const index = makeIndex([
      makeSymbol({ name: "rootCall", signature: "suspend (): Unit", source: "suspend fun rootCall() { childCall() }" }),
      makeSymbol({ name: "childCall", signature: "suspend (): Unit", source: "suspend fun childCall() { leafCall() }" }),
      makeSymbol({ name: "leafCall", signature: "suspend (): Unit", source: "suspend fun leafCall() {}" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceSuspendChain("test", "rootCall", { depth: 1 });

    expect(result.chain).toEqual(["rootCall", "childCall"]);
    expect(result.depth).toBe(1);
  });

  it("throws for an unknown repository", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);

    await expect(traceSuspendChain("missing", "rootCall")).rejects.toThrow(
      'Repository "missing" not found',
    );
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

  it("throws for an unknown repository", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);

    await expect(analyzeKmpDeclarations("missing")).rejects.toThrow(
      'Repository "missing" not found',
    );
  });
});

// ---------------------------------------------------------------------------
// traceFlowChain
// ---------------------------------------------------------------------------

describe("traceFlowChain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detects a Flow operator chain (map/filter/collect)", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "loadUsers",
        kind: "function",
        signature: "(): Flow<List<User>>",
        source: `fun loadUsers(): Flow<List<User>> = userDao.getAll()
    .map { it.toDomain() }
    .filter { it.isActive }`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceFlowChain("test", "loadUsers");
    expect(result.root).toBe("loadUsers");
    expect(result.operators).toContain("map");
    expect(result.operators).toContain("filter");
    expect(result.operator_count).toBe(2);
  });

  it("warns about Flow.collect without catch", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "observeUsers",
        kind: "function",
        signature: "suspend (): Unit",
        source: `suspend fun observeUsers() {
    userDao.getAll()
        .map { it.toDomain() }
        .collect { users -> updateUi(users) }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceFlowChain("test", "observeUsers");
    expect(result.warnings).toEqual([
      ".collect without .catch — exceptions in the upstream flow propagate to the collector and crash the coroutine",
    ]);
  });

  it("does NOT warn when .catch is present", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "safeObserve",
        kind: "function",
        signature: "suspend (): Unit",
        source: `suspend fun safeObserve() {
    userDao.getAll()
        .catch { emit(emptyList()) }
        .collect { updateUi(it) }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceFlowChain("test", "safeObserve");
    const catchWarning = result.warnings.find((w) => w.includes("catch"));
    expect(catchWarning).toBeUndefined();
  });

  it("detects stateIn without scope parameter", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "usersFlow",
        kind: "variable",
        source: `val usersFlow = userDao.getAll()
    .map { it.toDomain() }
    .stateIn(initialValue = emptyList())`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceFlowChain("test", "usersFlow");
    expect(result.warnings).toEqual([
      ".stateIn without a lifecycle scope parameter — the StateFlow will never complete, causing a memory leak unless bound to viewModelScope/lifecycleScope",
    ]);
  });

  it("does not warn when stateIn is bound to viewModelScope", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "usersFlow",
        kind: "variable",
        source: `val usersFlow = userDao.getAll()
    .map { it.toDomain() }
    .stateIn(viewModelScope, SharingStarted.Lazily, emptyList())`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceFlowChain("test", "usersFlow");

    expect(result.warnings).toEqual([]);
    expect(result.has_terminal).toBe(false);
  });

  it("throws for symbol without Flow usage", async () => {
    const index = makeIndex([
      makeSymbol({
        name: "plainFun",
        kind: "function",
        source: `fun plainFun() = 42`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    await expect(traceFlowChain("test", "plainFun")).rejects.toThrow(/no flow/i);
  });

  it("throws when the symbol is missing", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(makeIndex([]));

    await expect(traceFlowChain("test", "missingFlow")).rejects.toThrow(
      'Symbol "missingFlow" not found',
    );
  });

  it("throws for an unknown repository", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);

    await expect(traceFlowChain("missing", "usersFlow")).rejects.toThrow(
      'Repository "missing" not found',
    );
  });
});
