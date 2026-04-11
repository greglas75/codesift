import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { getTestFixtures } from "../../src/tools/pytest-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function makeSym(overrides: Partial<CodeSymbol> & { name: string; file: string }): CodeSymbol {
  return {
    id: `test:${overrides.file}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: "test_hook",
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

describe("getTestFixtures", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("discovers fixtures from conftest.py", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "db",
        file: "conftest.py",
        decorators: ["@pytest.fixture(scope=\"session\")"],
        source: "@pytest.fixture(scope=\"session\")\ndef db():\n    return create_db()",
        signature: "()",
      }),
    ]));

    const result = await getTestFixtures("test");
    expect(result.fixtures).toHaveLength(1);
    expect(result.fixtures[0]).toMatchObject({
      name: "db",
      scope: "session",
      autouse: false,
    });
    expect(result.conftest_files).toContain("conftest.py");
  });

  it("detects autouse=True", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "setup_logging",
        file: "conftest.py",
        decorators: ["@pytest.fixture(autouse=True)"],
        source: "@pytest.fixture(autouse=True)\ndef setup_logging():\n    pass",
        signature: "()",
      }),
    ]));

    const result = await getTestFixtures("test");
    expect(result.fixtures[0]!.autouse).toBe(true);
  });

  it("extracts fixture dependencies from parameters", async () => {
    const db = makeSym({
      name: "db",
      file: "conftest.py",
      decorators: ["@pytest.fixture"],
      source: "@pytest.fixture\ndef db():\n    return DB()",
      signature: "()",
    });
    const client = makeSym({
      name: "client",
      file: "conftest.py",
      decorators: ["@pytest.fixture"],
      source: "@pytest.fixture\ndef client(db):\n    return Client(db)",
      signature: "(db)",
    });
    mockedGetCodeIndex.mockResolvedValue(makeIndex([db, client]));

    const result = await getTestFixtures("test");
    const clientFixture = result.fixtures.find((f) => f.name === "client");
    expect(clientFixture!.depends_on).toEqual(["db"]);
  });

  it("includes built-in fixtures in dependencies", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "app",
        file: "conftest.py",
        decorators: ["@pytest.fixture"],
        source: "@pytest.fixture\ndef app(tmp_path, monkeypatch):\n    pass",
        signature: "(tmp_path, monkeypatch)",
      }),
    ]));

    const result = await getTestFixtures("test");
    expect(result.fixtures[0]!.depends_on).toContain("tmp_path");
    expect(result.fixtures[0]!.depends_on).toContain("monkeypatch");
  });

  it("defaults scope to function when not specified", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "simple",
        file: "conftest.py",
        decorators: ["@pytest.fixture"],
        source: "@pytest.fixture\ndef simple():\n    pass",
        signature: "()",
      }),
    ]));

    const result = await getTestFixtures("test");
    expect(result.fixtures[0]!.scope).toBe("function");
  });

  it("finds conftest hierarchy", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "root_fix", file: "conftest.py", decorators: ["@pytest.fixture"], signature: "()" }),
      makeSym({ name: "sub_fix", file: "tests/conftest.py", decorators: ["@pytest.fixture"], signature: "()" }),
      makeSym({ name: "deep_fix", file: "tests/unit/conftest.py", decorators: ["@pytest.fixture"], signature: "()" }),
    ]));

    const result = await getTestFixtures("test");
    expect(result.conftest_files).toEqual([
      "conftest.py",
      "tests/conftest.py",
      "tests/unit/conftest.py",
    ]);
    expect(result.fixture_count).toBe(3);
  });
});
