import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { findFrameworkWiring } from "../../src/tools/wiring-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function makeSym(overrides: Partial<CodeSymbol> & { name: string; file: string }): CodeSymbol {
  return {
    id: `test:${overrides.file}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: "function",
    start_line: 1,
    end_line: 10,
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  const files = [...new Set(symbols.map((s) => s.file))].map((f) => ({
    path: f, language: "python", symbol_count: 1, last_modified: Date.now(),
  }));
  return {
    repo: "test", root: "/tmp/test", symbols, files,
    created_at: Date.now(), updated_at: Date.now(),
    symbol_count: symbols.length, file_count: files.length,
  };
}

describe("findFrameworkWiring", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("discovers Django signal receivers", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "update_cache",
        file: "signals.py",
        decorators: ["@receiver(post_save, sender=User)"],
        source: "@receiver(post_save, sender=User)\ndef update_cache(sender, instance, **kwargs):\n    pass",
      }),
    ]));

    const result = await findFrameworkWiring("test");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "signal",
      name: "update_cache",
      detail: "@receiver(post_save, sender=User)",
    });
  });

  it("discovers Celery tasks", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "send_email",
        file: "tasks.py",
        decorators: ["@shared_task"],
        source: "@shared_task\ndef send_email(to, subject):\n    pass",
      }),
    ]));

    const result = await findFrameworkWiring("test");
    expect(result.entries.find((e) => e.type === "task")).toMatchObject({
      name: "send_email",
    });
  });

  it("discovers Celery task calls (.delay)", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "create_user",
        file: "views.py",
        source: "def create_user(request):\n    send_email.delay(email, 'Welcome')",
      }),
    ]));

    const result = await findFrameworkWiring("test");
    expect(result.entries.find((e) => e.type === "task_call")).toMatchObject({
      name: "send_email",
      detail: "send_email.delay()",
    });
  });

  it("discovers Django management commands", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "Command",
        file: "myapp/management/commands/sync_data.py",
        kind: "class",
        source: "class Command(BaseCommand):\n    def handle(self, *args, **options):\n        pass",
      }),
    ]));

    const result = await findFrameworkWiring("test");
    expect(result.entries.find((e) => e.type === "command")).toMatchObject({
      name: "sync_data",
      detail: "manage.py sync_data",
    });
  });

  it("discovers FastAPI event handlers", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "startup",
        file: "main.py",
        decorators: ['@app.on_event("startup")'],
        source: '@app.on_event("startup")\nasync def startup():\n    pass',
      }),
    ]));

    const result = await findFrameworkWiring("test");
    expect(result.entries.find((e) => e.type === "event_handler")).toMatchObject({
      name: "startup",
      detail: 'on_event("startup")',
    });
  });

  it("returns counts by type", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "a", file: "a.py", decorators: ["@shared_task"], source: "@shared_task\ndef a(): pass" }),
      makeSym({ name: "b", file: "b.py", decorators: ["@shared_task"], source: "@shared_task\ndef b(): pass" }),
      makeSym({ name: "c", file: "c.py", decorators: ["@receiver(post_save)"], source: "@receiver(post_save)\ndef c(): pass" }),
    ]));

    const result = await findFrameworkWiring("test");
    expect(result.by_type.task).toBe(2);
    expect(result.by_type.signal).toBe(1);
    expect(result.total).toBe(3);
  });
});
