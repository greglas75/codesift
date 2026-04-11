import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractPythonSymbols } from "../../src/parser/extractors/python.js";
import { collectImportEdges } from "../../src/utils/import-graph.js";
import type { CodeIndex, FileEntry, CodeSymbol } from "../../src/types.js";

const FIXTURE_ROOT = join(__dirname, "..", "fixtures", "python-sample");

const FIXTURE_FILES = [
  "myapp/__init__.py",
  "myapp/models.py",
  "myapp/views.py",
  "myapp/utils/__init__.py",
  "myapp/utils/helpers.py",
  "myapp/tests/conftest.py",
];

beforeAll(async () => {
  await initParser();
});

async function buildFixtureIndex(): Promise<CodeIndex> {
  const parser = await getParser("python");
  expect(parser).not.toBeNull();

  const symbols: CodeSymbol[] = [];
  const files: FileEntry[] = [];

  for (const relPath of FIXTURE_FILES) {
    const source = await readFile(join(FIXTURE_ROOT, relPath), "utf-8");
    const tree = parser!.parse(source);
    const fileSymbols = extractPythonSymbols(
      tree,
      relPath,
      source,
      "python-sample",
    );
    symbols.push(...fileSymbols);
    files.push({
      path: relPath,
      language: "python",
      symbol_count: fileSymbols.length,
      last_modified: Date.now(),
    });
  }

  return {
    repo: "python-sample",
    root: FIXTURE_ROOT,
    symbols,
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

describe("Python Foundation — integration", () => {
  it("extracts symbols from all fixture files", async () => {
    const index = await buildFixtureIndex();
    expect(index.symbols.length).toBeGreaterThan(10);
  });

  it("extracts User dataclass with fields", async () => {
    const index = await buildFixtureIndex();
    const user = index.symbols.find((s) => s.name === "User");
    expect(user).toBeDefined();
    expect(user!.kind).toBe("class");
    expect(user!.decorators).toEqual(["@dataclass"]);

    const fields = index.symbols.filter(
      (s) => s.parent === user!.id && s.kind === "field",
    );
    expect(fields.map((f) => f.name).sort()).toEqual(["email", "id", "name"]);
  });

  it("extracts Post as frozen dataclass", async () => {
    const index = await buildFixtureIndex();
    const post = index.symbols.find((s) => s.name === "Post");
    expect(post).toBeDefined();
    expect(post!.meta?.dataclass_frozen).toBe(true);
  });

  it("extracts async get_user function", async () => {
    const index = await buildFixtureIndex();
    const fn = index.symbols.find((s) => s.name === "get_user");
    expect(fn).toBeDefined();
    expect(fn!.is_async).toBe(true);
  });

  it("extracts API_URL as constant", async () => {
    const index = await buildFixtureIndex();
    const c = index.symbols.find((s) => s.name === "API_URL");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("constant");
  });

  it("extracts ASYNC_DEFAULT as constant in helpers module", async () => {
    const index = await buildFixtureIndex();
    const c = index.symbols.find(
      (s) => s.name === "ASYNC_DEFAULT" && s.file === "myapp/utils/helpers.py",
    );
    expect(c).toBeDefined();
    expect(c!.kind).toBe("constant");
  });

  it("extracts __all__ with literal members", async () => {
    const index = await buildFixtureIndex();
    const all = index.symbols.find(
      (s) => s.name === "__all__" && s.file === "myapp/__init__.py",
    );
    expect(all).toBeDefined();
    expect(all!.meta?.all_members).toEqual(["User", "Post"]);
  });

  it("extracts pytest fixture from conftest", async () => {
    const index = await buildFixtureIndex();
    const db = index.symbols.find((s) => s.name === "db");
    expect(db).toBeDefined();
    expect(db!.kind).toBe("test_hook");
  });

  it("builds import edges for relative and absolute imports", async () => {
    const index = await buildFixtureIndex();
    const edges = await collectImportEdges(index);

    // views.py should import from models.py (relative `from .models import`)
    const viewsToModels = edges.find(
      (e) => e.from === "myapp/views.py" && e.to === "myapp/models.py",
    );
    expect(viewsToModels).toBeDefined();

    // views.py should import from utils.helpers (relative `from .utils.helpers`)
    const viewsToHelpers = edges.find(
      (e) => e.from === "myapp/views.py" && e.to === "myapp/utils/helpers.py",
    );
    expect(viewsToHelpers).toBeDefined();

    // views.py does NOT import `os` (stdlib)
    const viewsToOs = edges.find(
      (e) => e.from === "myapp/views.py" && e.to.includes("os"),
    );
    expect(viewsToOs).toBeUndefined();

    // utils/__init__.py imports from helpers (relative `from .helpers`)
    const utilsInitToHelpers = edges.find(
      (e) => e.from === "myapp/utils/__init__.py" && e.to === "myapp/utils/helpers.py",
    );
    expect(utilsInitToHelpers).toBeDefined();

    // myapp/__init__.py imports from models (relative `from .models`)
    const initToModels = edges.find(
      (e) => e.from === "myapp/__init__.py" && e.to === "myapp/models.py",
    );
    expect(initToModels).toBeDefined();
  });

  it("honors CODESIFT_DISABLE_PYTHON_IMPORTS kill switch", async () => {
    const index = await buildFixtureIndex();
    const originalValue = process.env.CODESIFT_DISABLE_PYTHON_IMPORTS;
    process.env.CODESIFT_DISABLE_PYTHON_IMPORTS = "1";
    try {
      const edges = await collectImportEdges(index);
      // No Python edges should be produced
      const pyEdges = edges.filter(
        (e) => e.from.endsWith(".py") || e.to.endsWith(".py"),
      );
      expect(pyEdges).toHaveLength(0);
    } finally {
      if (originalValue === undefined) {
        delete process.env.CODESIFT_DISABLE_PYTHON_IMPORTS;
      } else {
        process.env.CODESIFT_DISABLE_PYTHON_IMPORTS = originalValue;
      }
    }
  });
});
