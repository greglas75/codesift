import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("../../src/tools/route-tools.js", () => ({
  traceRoute: vi.fn(),
}));

const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(args[0] as string, args[1] as string),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { traceRoute } from "../../src/tools/route-tools.js";
import { effectiveDjangoViewSecurity } from "../../src/tools/django-view-security-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);
const mockedTraceRoute = vi.mocked(traceRoute);

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
  const files = [
    ...new Set([...symbols.map((symbol) => symbol.file), "proj/settings.py"]),
  ].map((path) => ({
    path,
    language: "python",
    symbol_count: symbols.filter((symbol) => symbol.file === path).length,
    last_modified: Date.now(),
  }));

  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

const DEFAULT_SETTINGS = `
MIDDLEWARE = [
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.security.SecurityMiddleware",
]
`;

describe("effectiveDjangoViewSecurity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(DEFAULT_SETTINGS);
  });

  it("detects auth requirements on function views", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "dashboard",
        file: "proj/views.py",
        decorators: ["@login_required"],
        source: "@login_required\ndef dashboard(request): pass",
      }),
    ]));

    const result = await effectiveDjangoViewSecurity("test", { symbol_name: "dashboard" });

    expect(result.assessments).toHaveLength(1);
    expect(result.assessments[0]).toMatchObject({
      symbol_name: "dashboard",
      effective_auth_required: true,
      csrf_protected: true,
      authentication_middleware: true,
      session_middleware: true,
      security_middleware: true,
    });
    expect(result.assessments[0]!.auth_guards).toContain("login_required");
  });

  it("flags csrf_exempt views as not CSRF-protected", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "webhook",
        file: "proj/views.py",
        decorators: ["@csrf_exempt"],
        source: "@csrf_exempt\ndef webhook(request): pass",
      }),
    ]));

    const result = await effectiveDjangoViewSecurity("test", { symbol_name: "webhook" });

    expect(result.assessments[0]).toMatchObject({
      symbol_name: "webhook",
      effective_auth_required: false,
      csrf_exempt: true,
      csrf_protected: false,
    });
    expect(result.assessments[0]!.notes.join(" ")).toContain("csrf_exempt");
  });

  it("inherits auth posture from class-based view mixins", async () => {
    const parent = makeSym({
      name: "AccountView",
      file: "proj/views.py",
      kind: "class",
      extends: ["LoginRequiredMixin", "View"],
      source: "class AccountView(LoginRequiredMixin, View):\n    pass",
    });
    const method = makeSym({
      name: "get",
      file: "proj/views.py",
      kind: "method",
      parent: parent.id,
      source: "def get(self, request):\n    pass",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex([parent, method]));

    const result = await effectiveDjangoViewSecurity("test", { symbol_name: "get", file_pattern: "proj/views.py" });

    expect(result.assessments[0]).toMatchObject({
      symbol_name: "get",
      effective_auth_required: true,
    });
    expect(result.assessments[0]!.mixins).toContain("LoginRequiredMixin");
  });

  it("resolves Django handlers from a route path", async () => {
    const view = makeSym({
      name: "dashboard",
      file: "proj/views.py",
      decorators: ["@login_required"],
      source: "@login_required\ndef dashboard(request): pass",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex([view]));
    mockedTraceRoute.mockResolvedValue({
      path: "/dashboard/",
      handlers: [{
        framework: "django",
        file: "proj/views.py",
        symbol: {
          file: "proj/views.py",
          name: "dashboard",
          start_line: 1,
        },
      }],
      call_chain: [],
      db_calls: [],
    } as never);

    const result = await effectiveDjangoViewSecurity("test", { path: "/dashboard/" });

    expect(result.assessments).toHaveLength(1);
    expect(result.assessments[0]!.route_path).toBe("/dashboard/");
    expect(result.assessments[0]!.symbol_name).toBe("dashboard");
  });

  it("reports likely public views when no auth decorators or mixins are found", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "public_feed",
        file: "proj/views.py",
        source: "def public_feed(request): pass",
      }),
    ]));

    const result = await effectiveDjangoViewSecurity("test", { symbol_name: "public_feed" });

    expect(result.assessments[0]).toMatchObject({
      effective_auth_required: false,
      csrf_protected: true,
    });
    expect(result.assessments[0]!.notes[0]).toContain("No auth decorator or mixin detected");
  });
});
