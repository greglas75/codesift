import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("../../src/tools/python-circular-imports.js", () => ({
  findPythonCircularImports: vi.fn(),
}));

vi.mock("../../src/tools/django-settings.js", () => ({
  analyzeDjangoSettings: vi.fn(),
}));

vi.mock("../../src/tools/pattern-tools.js", () => ({
  searchPatterns: vi.fn(),
}));

vi.mock("../../src/tools/wiring-tools.js", () => ({
  findFrameworkWiring: vi.fn(),
}));

vi.mock("../../src/tools/celery-tools.js", () => ({
  traceCeleryChain: vi.fn(),
}));

vi.mock("../../src/tools/pytest-tools.js", () => ({
  getTestFixtures: vi.fn(),
}));

vi.mock("../../src/tools/pyproject-tools.js", () => ({
  parsePyproject: vi.fn(),
}));

vi.mock("../../src/tools/symbol-tools.js", () => ({
  findDeadCode: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { findPythonCircularImports } from "../../src/tools/python-circular-imports.js";
import { analyzeDjangoSettings } from "../../src/tools/django-settings.js";
import { searchPatterns } from "../../src/tools/pattern-tools.js";
import { findFrameworkWiring } from "../../src/tools/wiring-tools.js";
import { traceCeleryChain } from "../../src/tools/celery-tools.js";
import { getTestFixtures } from "../../src/tools/pytest-tools.js";
import { parsePyproject } from "../../src/tools/pyproject-tools.js";
import { findDeadCode } from "../../src/tools/symbol-tools.js";
import { pythonAudit } from "../../src/tools/python-audit.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);
const mockedCircular = vi.mocked(findPythonCircularImports);
const mockedDjango = vi.mocked(analyzeDjangoSettings);
const mockedPatterns = vi.mocked(searchPatterns);
const mockedWiring = vi.mocked(findFrameworkWiring);
const mockedCelery = vi.mocked(traceCeleryChain);
const mockedFixtures = vi.mocked(getTestFixtures);
const mockedPyproject = vi.mocked(parsePyproject);
const mockedDeadCode = vi.mocked(findDeadCode);

function makeIndex(pyFiles: string[]): CodeIndex {
  return {
    repo: "test", root: "/tmp/test",
    symbols: [],
    files: pyFiles.map((p) => ({ path: p, language: "python", symbol_count: 0, last_modified: Date.now() })),
    created_at: Date.now(), updated_at: Date.now(),
    symbol_count: 0, file_count: pyFiles.length,
  };
}

function defaultMocks(): void {
  mockedCircular.mockResolvedValue({ cycles: [], total: 0, files_scanned: 0 });
  mockedDjango.mockResolvedValue({ files_scanned: [], findings: [], total: 0, by_severity: {} });
  mockedPatterns.mockResolvedValue({ matches: [], pattern: "test", scanned_symbols: 0 });
  mockedWiring.mockResolvedValue({ entries: [], total: 0, by_type: {} });
  mockedCelery.mockResolvedValue({ tasks: [], canvas_usages: [], total_tasks: 0, total_call_sites: 0, orphan_tasks: [] });
  mockedFixtures.mockResolvedValue({ fixtures: [], conftest_files: [], fixture_count: 0 });
  mockedPyproject.mockResolvedValue(null);
  mockedDeadCode.mockResolvedValue({ candidates: [], total: 0 } as never);
}

describe("pythonAudit", () => {
  beforeEach(() => { vi.clearAllMocks(); defaultMocks(); });

  it("runs all 8 checks on a clean project", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex(["myapp/main.py"]));

    const result = await pythonAudit("test");
    expect(result.summary.health_score).toBe(100);
    expect(result.summary.total_findings).toBe(0);
    expect(result.summary.top_risks).toHaveLength(0);
    expect(result.gates.length).toBeGreaterThanOrEqual(7);
  });

  it("skips Django check when no settings.py present", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex(["myapp/main.py"]));

    const result = await pythonAudit("test");
    const djangoGate = result.gates.find((g) => g.name === "django_settings");
    expect(djangoGate!.status).toBe("skipped");
  });

  it("runs Django check when settings.py present", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex(["myapp/settings.py"]));
    mockedDjango.mockResolvedValue({
      files_scanned: ["myapp/settings.py"],
      findings: [
        { rule: "debug-enabled", severity: "critical", message: "", file: "", line: 1, match: "", fix: "" },
      ],
      total: 1,
      by_severity: { critical: 1 },
    });

    const result = await pythonAudit("test");
    const djangoGate = result.gates.find((g) => g.name === "django_settings");
    expect(djangoGate!.status).toBe("ok");
    expect(result.summary.critical).toBe(1);
    expect(result.summary.top_risks[0]).toContain("Django");
  });

  it("penalizes health score for findings", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex(["myapp/settings.py"]));
    // 2 critical django + 3 circular import errors
    mockedDjango.mockResolvedValue({
      files_scanned: ["myapp/settings.py"],
      findings: [],
      total: 2,
      by_severity: { critical: 2 },
    });
    mockedCircular.mockResolvedValue({
      cycles: [
        { cycle: ["a.py", "b.py", "a.py"], length: 2, severity: "error", note: "" },
        { cycle: ["c.py", "d.py", "c.py"], length: 2, severity: "error", note: "" },
        { cycle: ["e.py", "f.py", "e.py"], length: 2, severity: "error", note: "" },
      ],
      total: 3,
      files_scanned: 6,
    });

    const result = await pythonAudit("test");
    // 2 critical (-30) + 3 high (-24) = -54 → 46
    expect(result.summary.health_score).toBe(46);
    expect(result.summary.critical).toBe(2);
    expect(result.summary.high).toBe(3);
  });

  it("identifies top risks", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex(["tasks.py"]));
    mockedCelery.mockResolvedValue({
      tasks: [],
      canvas_usages: [],
      total_tasks: 5,
      total_call_sites: 3,
      orphan_tasks: ["unused1", "unused2"],
    });

    const result = await pythonAudit("test");
    expect(result.summary.top_risks.some((r) => r.includes("orphan Celery"))).toBe(true);
  });

  it("respects checks option", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex(["app.py"]));

    const result = await pythonAudit("test", { checks: ["circular_imports", "anti_patterns"] });
    const gateNames = result.gates.map((g) => g.name);
    expect(gateNames).toContain("circular_imports");
    expect(gateNames).toContain("anti_patterns");
    expect(gateNames).not.toContain("django_settings");
    expect(gateNames).not.toContain("celery");
  });

  it("handles failing checks gracefully", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex(["app.py"]));
    mockedCircular.mockRejectedValue(new Error("parser crash"));

    const result = await pythonAudit("test");
    const circGate = result.gates.find((g) => g.name === "circular_imports");
    expect(circGate!.status).toBe("error");
    // Other gates should still run
    const otherGates = result.gates.filter((g) => g.name !== "circular_imports" && g.status === "ok");
    expect(otherGates.length).toBeGreaterThan(0);
  });
});
