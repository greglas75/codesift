import { describe, it, expect, vi, beforeEach } from "vitest";
import { findPerfHotspots, listPerfPatterns } from "../../src/tools/perf-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock getCodeIndex — I/O boundary (reads from storage)
// ---------------------------------------------------------------------------

const mockGetCodeIndex = vi.fn<(repo: string) => Promise<CodeIndex | null>>();

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: (...args: unknown[]) => mockGetCodeIndex(args[0] as string),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSymbol(
  name: string,
  file: string,
  source: string,
  overrides: Partial<CodeSymbol> = {},
): CodeSymbol {
  return {
    id: `test:${file}:${name}:1`,
    repo: "test",
    name,
    kind: "function",
    file,
    start_line: 1,
    end_line: source.split("\n").length + 5,
    source,
    signature: `function ${name}()`,
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Sample source snippets
// ---------------------------------------------------------------------------

const UNBOUNDED_SOURCE = `async function getUsers() {
  return prisma.user.findMany({
    where: { active: true },
  });
}`;

const BOUNDED_SOURCE = `async function getUsers() {
  return prisma.user.findMany({
    where: { active: true },
    take: 100,
  });
}`;

const SYNC_HANDLER_SOURCE = `function handleRequest(req, res) {
  const data = readFileSync("config.json");
  res.json(data);
}`;

const N_PLUS_ONE_SOURCE = `async function loadUsers(ids) {
  const users = [];
  for (const id of ids) {
    const u = await prisma.user.findUnique({ where: { id } });
    users.push(u);
  }
  return users;
}`;

const SAFE_SOURCE = `function add(a, b) {
  return a + b;
}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findPerfHotspots", () => {
  beforeEach(() => {
    mockGetCodeIndex.mockReset();
  });

  it("throws when repo not found", async () => {
    mockGetCodeIndex.mockResolvedValue(null);

    await expect(findPerfHotspots("missing")).rejects.toThrow(/not found/);
  });

  it("returns empty findings when no patterns match", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        makeSymbol("add", "src/util/math.ts", SAFE_SOURCE),
        makeSymbol("sub", "src/util/math.ts", SAFE_SOURCE),
      ]),
    );

    const result = await findPerfHotspots("test");

    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({ high: 0, medium: 0, low: 0 });
    expect(result.symbols_scanned).toBe(2);
    expect(result.patterns_checked).toBeGreaterThan(0);
  });

  it("detects unbounded-query pattern (findMany without take)", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeSymbol("getUsers", "src/services/user-service.ts", UNBOUNDED_SOURCE)]),
    );

    const result = await findPerfHotspots("test", { patterns: ["unbounded-query"] });

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.pattern).toBe("unbounded-query");
    expect(finding.severity).toBe("high");
    expect(finding.name).toBe("getUsers");
    expect(finding.file).toBe("src/services/user-service.ts");
    expect(finding.fix_hint).toMatch(/take|limit|pagination/i);
    expect(result.summary.high).toBe(1);
  });

  it("does NOT flag findMany when take is present", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeSymbol("getUsers", "src/services/user-service.ts", BOUNDED_SOURCE)]),
    );

    const result = await findPerfHotspots("test", { patterns: ["unbounded-query"] });

    expect(result.findings).toHaveLength(0);
  });

  it("detects sync-in-handler only in route/handler/controller files", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        // Should match — file path contains "route"
        makeSymbol("handleRequest", "src/routes/api.ts", SYNC_HANDLER_SOURCE),
        // Should NOT match — "util" is not in file_scope
        makeSymbol("loadConfig", "src/util/config.ts", SYNC_HANDLER_SOURCE),
      ]),
    );

    const result = await findPerfHotspots("test", { patterns: ["sync-in-handler"] });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.name).toBe("handleRequest");
    expect(result.findings[0]!.file).toBe("src/routes/api.ts");
    expect(result.findings[0]!.pattern).toBe("sync-in-handler");
  });

  it("sync-in-handler matches controller/handler/middleware/api paths", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        makeSymbol("a", "src/controller/user.ts", SYNC_HANDLER_SOURCE),
        makeSymbol("b", "src/handler/webhook.ts", SYNC_HANDLER_SOURCE),
        makeSymbol("c", "src/middleware/auth.ts", SYNC_HANDLER_SOURCE),
        makeSymbol("d", "src/api/users.ts", SYNC_HANDLER_SOURCE),
      ]),
    );

    const result = await findPerfHotspots("test", { patterns: ["sync-in-handler"] });

    expect(result.findings).toHaveLength(4);
    expect(result.findings.every((f) => f.pattern === "sync-in-handler")).toBe(true);
  });

  it("detects n-plus-one pattern (DB call inside for loop)", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeSymbol("loadUsers", "src/services/users.ts", N_PLUS_ONE_SOURCE)]),
    );

    const result = await findPerfHotspots("test", { patterns: ["n-plus-one"] });

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.pattern).toBe("n-plus-one");
    expect(finding.severity).toBe("high");
    expect(finding.name).toBe("loadUsers");
    expect(finding.fix_hint).toMatch(/batch|Promise\.all|IN clause/i);
  });

  it("respects patterns option to limit which patterns are checked", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        makeSymbol("getUsers", "src/services/user-service.ts", UNBOUNDED_SOURCE),
        makeSymbol("loadUsers", "src/services/users.ts", N_PLUS_ONE_SOURCE),
      ]),
    );

    // Only enable n-plus-one — unbounded-query should be ignored
    const result = await findPerfHotspots("test", { patterns: ["n-plus-one"] });

    expect(result.patterns_checked).toBe(1);
    expect(result.findings.every((f) => f.pattern === "n-plus-one")).toBe(true);
    expect(result.findings.some((f) => f.pattern === "unbounded-query")).toBe(false);
  });

  it("respects max_results cap", async () => {
    // Create 5 unbounded-query symbols
    const symbols = Array.from({ length: 5 }, (_, i) =>
      makeSymbol(`fn${i}`, `src/services/s${i}.ts`, UNBOUNDED_SOURCE),
    );
    mockGetCodeIndex.mockResolvedValue(makeIndex(symbols));

    const result = await findPerfHotspots("test", {
      patterns: ["unbounded-query"],
      max_results: 2,
    });

    expect(result.findings.length).toBeLessThanOrEqual(2);
    expect(result.findings).toHaveLength(2);
  });

  it("sorts findings by severity (high → medium → low)", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        // high severity
        makeSymbol("getUsers", "src/services/user-service.ts", UNBOUNDED_SOURCE),
        // medium severity (unbounded-parallel)
        makeSymbol(
          "parallel",
          "src/services/parallel.ts",
          `async function parallel() {
            return Promise.all(items.map(async (x) => fetchOne(x)));
          }`,
        ),
      ]),
    );

    const result = await findPerfHotspots("test", {
      patterns: ["unbounded-query", "unbounded-parallel"],
    });

    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    // high severity should appear before medium
    const severities = result.findings.map((f) => f.severity);
    const highIdx = severities.indexOf("high");
    const medIdx = severities.indexOf("medium");
    expect(highIdx).toBeLessThan(medIdx);
  });

  it("skips symbols without source", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        { ...makeSymbol("x", "src/a.ts", ""), source: undefined },
      ]),
    );

    const result = await findPerfHotspots("test");

    expect(result.symbols_scanned).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

describe("listPerfPatterns", () => {
  it("returns all registered patterns with description and severity", () => {
    const patterns = listPerfPatterns();

    expect(patterns["unbounded-query"]).toBeDefined();
    expect(patterns["unbounded-query"]!.severity).toBe("high");
    expect(patterns["sync-in-handler"]).toBeDefined();
    expect(patterns["n-plus-one"]).toBeDefined();

    for (const [, info] of Object.entries(patterns)) {
      expect(typeof info.description).toBe("string");
      expect(["high", "medium", "low"]).toContain(info.severity);
    }
  });
});
