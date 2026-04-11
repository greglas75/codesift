import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { findPythonCallers } from "../../src/tools/python-callers.js";

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
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [...new Set(symbols.map((s) => s.file))].map((f) => ({
      path: f, language: "python", symbol_count: 1, last_modified: Date.now(),
    })),
    created_at: Date.now(), updated_at: Date.now(),
    symbol_count: symbols.length, file_count: 1,
  };
}

describe("findPythonCallers", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("finds direct function calls", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "send_email",
        file: "tasks.py",
        source: "def send_email(to, body):\n    pass",
      }),
      makeSym({
        name: "register_user",
        file: "views.py",
        source: "def register_user(request):\n    send_email('x@y.z', 'Welcome')",
      }),
    ]));

    const result = await findPythonCallers("test", "send_email");
    expect(result.target.name).toBe("send_email");
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0]).toMatchObject({
      caller_symbol: "register_user",
      call_kind: "direct",
    });
  });

  it("detects Celery .delay() calls", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "process_payment",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef process_payment(order_id):\n    pass",
      }),
      makeSym({
        name: "checkout",
        file: "views.py",
        source: "def checkout(request):\n    process_payment.delay(order.id)",
      }),
    ]));

    const result = await findPythonCallers("test", "process_payment");
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0]!.call_kind).toBe("delay");
  });

  it("detects method-style calls", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "save",
        file: "models.py",
        kind: "method",
        source: "def save(self):\n    pass",
      }),
      makeSym({
        name: "update_user",
        file: "services.py",
        source: "def update_user(u):\n    u.save()",
      }),
    ]));

    const result = await findPythonCallers("test", "save");
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0]!.call_kind).toBe("method");
  });

  it("returns called_from_files sorted", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "util", file: "utils.py", source: "def util(): pass" }),
      makeSym({ name: "a", file: "zzz.py", source: "def a(): util()" }),
      makeSym({ name: "b", file: "aaa.py", source: "def b(): util()" }),
    ]));

    const result = await findPythonCallers("test", "util");
    expect(result.called_from_files).toEqual(["aaa.py", "zzz.py"]);
  });

  it("throws when target not found", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([]));
    await expect(findPythonCallers("test", "nonexistent")).rejects.toThrow(
      /not found/,
    );
  });

  it("disambiguates with target_file option", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "foo", file: "a/mod.py", source: "def foo(): pass" }),
      makeSym({ name: "foo", file: "b/mod.py", source: "def foo(): pass" }),
      makeSym({ name: "caller", file: "uses.py", source: "def caller(): foo()" }),
    ]));

    const result = await findPythonCallers("test", "foo", { target_file: "a/" });
    expect(result.target.file).toBe("a/mod.py");
  });
});
