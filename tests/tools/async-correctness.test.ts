import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { analyzeAsyncCorrectness } from "../../src/tools/async-correctness.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function makeSym(o: Partial<CodeSymbol> & { name: string; file: string }): CodeSymbol {
  return {
    id: `test:${o.file}:${o.name}:${o.start_line ?? 1}`,
    repo: "test",
    kind: "function",
    start_line: 1,
    end_line: 10,
    ...o,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test", root: "/tmp/test",
    symbols,
    files: [...new Set(symbols.map((s) => s.file))].map((f) => ({
      path: f, language: "python", symbol_count: 1, last_modified: Date.now(),
    })),
    created_at: Date.now(), updated_at: Date.now(),
    symbol_count: symbols.length, file_count: 1,
  };
}

describe("analyzeAsyncCorrectness", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("detects blocking requests in async def", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "fetch_user",
        file: "api.py",
        is_async: true,
        source: "async def fetch_user(user_id):\n    response = requests.get(f'/users/{user_id}')\n    return response.json()",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.findings.find((f) => f.rule === "blocking-requests")).toBeDefined();
    expect(result.by_rule["blocking-requests"]).toBe(1);
  });

  it("detects time.sleep in async def", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "wait_then_fetch",
        file: "api.py",
        is_async: true,
        source: "async def wait_then_fetch():\n    time.sleep(5)\n    return await fetch()",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    const finding = result.findings.find((f) => f.rule === "blocking-sleep");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.fix).toContain("asyncio.sleep");
  });

  it("detects sync SQLAlchemy in async", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "get_users",
        file: "api.py",
        is_async: true,
        source: "async def get_users(session):\n    return session.query(User).all()",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.findings.find((f) => f.rule === "sync-db-in-async")).toBeDefined();
  });

  it("detects sync Django ORM in async", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "get_user",
        file: "views.py",
        is_async: true,
        source: "async def get_user(request):\n    return User.objects.get(id=1)",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    const finding = result.findings.find((f) => f.rule === "sync-orm-django");
    expect(finding).toBeDefined();
    expect(finding!.fix).toContain(".aget()");
  });

  it("detects blocking subprocess", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "run_cmd",
        file: "worker.py",
        is_async: true,
        source: "async def run_cmd():\n    subprocess.run(['ls', '-la'])",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.findings.find((f) => f.rule === "blocking-subprocess")).toBeDefined();
  });

  it("flags async def with no await", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "pointless_async",
        file: "api.py",
        is_async: true,
        source: "async def pointless_async():\n    x = 1\n    return x",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    const finding = result.findings.find((f) => f.rule === "async-without-await");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });

  it("ignores async def with await", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "proper_async",
        file: "api.py",
        is_async: true,
        source: "async def proper_async():\n    return await fetch_data()",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.findings.find((f) => f.rule === "async-without-await")).toBeUndefined();
  });

  it("ignores async generators (yield is fine)", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "event_stream",
        file: "api.py",
        is_async: true,
        source: "async def event_stream():\n    yield {'event': 'start'}",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.findings.find((f) => f.rule === "async-without-await")).toBeUndefined();
  });

  it("ignores non-async functions", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "sync_fetch",
        file: "api.py",
        is_async: false,
        source: "def sync_fetch():\n    time.sleep(5)\n    return requests.get('/')",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.findings).toHaveLength(0);
    expect(result.async_functions_scanned).toBe(0);
  });

  it("respects rules filter option", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "bad_fn",
        file: "api.py",
        is_async: true,
        source: "async def bad_fn():\n    time.sleep(1)\n    return requests.get('/')",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test", { rules: ["blocking-sleep"] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule).toBe("blocking-sleep");
  });

  it("detects asyncio.create_task without ref", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "fire_and_forget",
        file: "worker.py",
        is_async: true,
        source: "async def fire_and_forget():\n    asyncio.create_task(background_job())\n    return await main()",
      }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.findings.find((f) => f.rule === "globalscope-task")).toBeDefined();
  });

  it("counts async functions scanned", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "a", file: "a.py", is_async: true, source: "async def a(): await x()" }),
      makeSym({ name: "b", file: "b.py", is_async: true, source: "async def b(): await y()" }),
      makeSym({ name: "c", file: "c.py", is_async: false, source: "def c(): return 1" }),
    ]));

    const result = await analyzeAsyncCorrectness("test");
    expect(result.async_functions_scanned).toBe(2);
  });
});
