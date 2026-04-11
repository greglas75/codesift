import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { traceCeleryChain } from "../../src/tools/celery-tools.js";

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
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: 1,
  };
}

describe("traceCeleryChain", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("discovers @shared_task decorators", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "send_email",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef send_email(to, body):\n    pass",
      }),
    ]));

    const result = await traceCeleryChain("test");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.name).toBe("send_email");
  });

  it("extracts max_retries from decorator", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "retryable_task",
        file: "tasks.py",
        decorators: ["@shared_task(max_retries=3, retry_backoff=True)"],
        source: "@shared_task(max_retries=3)\ndef retryable_task():\n    pass",
      }),
    ]));

    const result = await traceCeleryChain("test");
    expect(result.tasks[0]!.max_retries).toBe(3);
    expect(result.tasks[0]!.retry_backoff).toBe(true);
  });

  it("extracts queue from decorator", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "priority_task",
        file: "tasks.py",
        decorators: ['@shared_task(queue="high_priority")'],
        source: '@shared_task(queue="high_priority")\ndef priority_task():\n    pass',
      }),
    ]));

    const result = await traceCeleryChain("test");
    expect(result.tasks[0]!.queue).toBe("high_priority");
  });

  it("detects bind=True", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "bound_task",
        file: "tasks.py",
        decorators: ["@shared_task(bind=True)"],
        source: "@shared_task(bind=True)\ndef bound_task(self):\n    pass",
      }),
    ]));

    const result = await traceCeleryChain("test");
    expect(result.tasks[0]!.bind).toBe(true);
  });

  it("finds .delay() call sites", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "send_email",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef send_email(to):\n    pass",
      }),
      makeSym({
        name: "register",
        file: "views.py",
        source: "def register(request):\n    send_email.delay(request.user.email)",
      }),
    ]));

    const result = await traceCeleryChain("test");
    const task = result.tasks[0]!;
    expect(task.callers).toHaveLength(1);
    expect(task.callers[0]!.kind).toBe("delay");
    expect(task.callers[0]!.file).toBe("views.py");
  });

  it("finds .apply_async() call sites", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "slow_task",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef slow_task(x):\n    pass",
      }),
      makeSym({
        name: "worker",
        file: "worker.py",
        source: "def worker():\n    slow_task.apply_async(args=[42], countdown=60)",
      }),
    ]));

    const result = await traceCeleryChain("test");
    expect(result.tasks[0]!.callers[0]!.kind).toBe("apply_async");
  });

  it("identifies orphan tasks (defined but never called)", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "unused_task",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef unused_task():\n    pass",
      }),
      makeSym({
        name: "used_task",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef used_task():\n    pass",
      }),
      makeSym({
        name: "caller",
        file: "views.py",
        source: "def caller():\n    used_task.delay()",
      }),
    ]));

    const result = await traceCeleryChain("test");
    expect(result.orphan_tasks).toEqual(["unused_task"]);
  });

  it("detects canvas operators (chain, group, chord)", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "run_workflow",
        file: "workflows.py",
        source: "def run_workflow():\n    chain(task_a.s(), task_b.s())()",
      }),
    ]));

    const result = await traceCeleryChain("test");
    const chainUsage = result.canvas_usages.find((u) => u.operator === "chain");
    expect(chainUsage).toBeDefined();
  });

  it("task_name option filters to one task", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "task_a",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef task_a(): pass",
      }),
      makeSym({
        name: "task_b",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef task_b(): pass",
      }),
    ]));

    const result = await traceCeleryChain("test", { task_name: "task_a" });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.name).toBe("task_a");
  });
});
