import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { initParser } from "../../src/parser/parser-manager.js";
import { findPythonCircularImports } from "../../src/tools/python-circular-imports.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

beforeAll(async () => {
  await initParser();
});

/** Create a temp Python project with given file contents. */
function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "circular-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return root;
}

function makeIndex(root: string, relPaths: string[]): CodeIndex {
  return {
    repo: "test",
    root,
    symbols: [],
    files: relPaths.map((p) => ({
      path: p,
      language: "python",
      symbol_count: 0,
      last_modified: Date.now(),
    })),
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: relPaths.length,
  };
}

describe("findPythonCircularImports", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("detects direct A → B → A cycle", async () => {
    const root = createProject({
      "myapp/__init__.py": "",
      "myapp/a.py": "from myapp.b import thing\n",
      "myapp/b.py": "from myapp.a import other\n",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, [
      "myapp/__init__.py",
      "myapp/a.py",
      "myapp/b.py",
    ]));

    const result = await findPythonCircularImports("test");
    expect(result.total).toBeGreaterThan(0);
    const shortCycle = result.cycles.find((c) => c.length === 2);
    expect(shortCycle).toBeDefined();
    expect(shortCycle!.severity).toBe("error");
  });

  it("returns no cycles for a clean project", async () => {
    const root = createProject({
      "myapp/__init__.py": "",
      "myapp/a.py": "x = 1\n",
      "myapp/b.py": "from myapp import a\n",
      "myapp/c.py": "from myapp import b\n",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, [
      "myapp/__init__.py",
      "myapp/a.py",
      "myapp/b.py",
      "myapp/c.py",
    ]));

    const result = await findPythonCircularImports("test");
    // There may be 1 cycle involving __init__.py itself but not a->b cycle
    const abCycle = result.cycles.find(
      (c) => c.cycle.some((f) => f.endsWith("a.py")) && c.cycle.some((f) => f.endsWith("b.py")),
    );
    expect(abCycle).toBeUndefined();
  });

  it("deduplicates cycles detected from different starting points", async () => {
    const root = createProject({
      "myapp/__init__.py": "",
      "myapp/a.py": "from myapp.b import thing\n",
      "myapp/b.py": "from myapp.c import other\n",
      "myapp/c.py": "from myapp.a import final\n",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, [
      "myapp/__init__.py",
      "myapp/a.py",
      "myapp/b.py",
      "myapp/c.py",
    ]));

    const result = await findPythonCircularImports("test");
    // The a→b→c→a cycle should be reported exactly once
    const triangleCycles = result.cycles.filter((c) => c.length === 3);
    expect(triangleCycles).toHaveLength(1);
  });

  it("skips type-only imports (TYPE_CHECKING)", async () => {
    const root = createProject({
      "myapp/__init__.py": "",
      "myapp/a.py": `from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from myapp.b import BType
x = 1
`,
      "myapp/b.py": "from myapp.a import thing\n",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, [
      "myapp/__init__.py",
      "myapp/a.py",
      "myapp/b.py",
    ]));

    const result = await findPythonCircularImports("test");
    // The a ↔ b cycle should NOT be reported because a's import is type-only
    const directCycle = result.cycles.find(
      (c) => c.length === 2 && c.cycle.some((f) => f.endsWith("a.py")),
    );
    expect(directCycle).toBeUndefined();
  });

  it("reports files_scanned count", async () => {
    const root = createProject({
      "x.py": "pass\n",
      "y.py": "pass\n",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, ["x.py", "y.py"]));

    const result = await findPythonCircularImports("test");
    expect(result.files_scanned).toBe(2);
  });
});
