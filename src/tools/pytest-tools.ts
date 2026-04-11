/**
 * pytest fixture dependency graph extraction.
 * Scans conftest.py hierarchy, extracts fixtures with scope, autouse,
 * and dependencies (fixture parameters that reference other fixtures).
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

export interface FixtureInfo {
  name: string;
  file: string;
  line: number;
  scope: "function" | "class" | "module" | "session" | "package";
  autouse: boolean;
  depends_on: string[];
}

export interface FixtureGraph {
  fixtures: FixtureInfo[];
  conftest_files: string[];
  fixture_count: number;
}

// Known pytest built-in fixtures (skip as dependencies)
const BUILTIN_FIXTURES = new Set([
  "request", "tmp_path", "tmp_path_factory", "tmpdir", "tmpdir_factory",
  "capsys", "capfd", "capsysbinary", "capfdbinary", "caplog",
  "monkeypatch", "recwarn", "pytestconfig", "cache", "record_property",
  "record_testsuite_property", "record_xml_attribute",
]);

/**
 * Extract pytest fixture dependency graph from a repository.
 */
export async function getTestFixtures(
  repo: string,
  options?: {
    file_pattern?: string;
  },
): Promise<FixtureGraph> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;

  // Find all fixture symbols (kind === "test_hook")
  const fixtureSymbols = index.symbols.filter((s) => {
    if (s.kind !== "test_hook") return false;
    if (!s.file.endsWith(".py")) return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  // Find conftest files
  const conftestFiles = [
    ...new Set(
      index.files
        .filter((f) => f.path.endsWith("conftest.py"))
        .map((f) => f.path)
        .sort(),
    ),
  ];

  // Build fixture name set for dependency resolution
  const fixtureNames = new Set(fixtureSymbols.map((s) => s.name));

  const fixtures: FixtureInfo[] = fixtureSymbols.map((sym) => {
    const source = sym.source ?? "";
    const decorators = sym.decorators ?? [];

    // Extract scope from decorator args
    const scope = extractScope(decorators, source);

    // Extract autouse from decorator args
    const autouse = extractAutouse(decorators, source);

    // Extract dependencies from function parameters
    const depends_on = extractDependencies(sym, fixtureNames);

    return {
      name: sym.name,
      file: sym.file,
      line: sym.start_line,
      scope,
      autouse,
      depends_on,
    };
  });

  return {
    fixtures,
    conftest_files: conftestFiles,
    fixture_count: fixtures.length,
  };
}

function extractScope(
  decorators: string[],
  source: string,
): FixtureInfo["scope"] {
  // Check decorator args: @pytest.fixture(scope="session")
  for (const dec of decorators) {
    const scopeMatch = dec.match(/scope\s*=\s*['"](\w+)['"]/);
    if (scopeMatch) {
      const s = scopeMatch[1]!;
      if (["function", "class", "module", "session", "package"].includes(s)) {
        return s as FixtureInfo["scope"];
      }
    }
  }
  // Also check source for scope in case decorator text doesn't capture it
  const srcMatch = source.match(/scope\s*=\s*['"](\w+)['"]/);
  if (srcMatch) {
    const s = srcMatch[1]!;
    if (["function", "class", "module", "session", "package"].includes(s)) {
      return s as FixtureInfo["scope"];
    }
  }
  return "function"; // pytest default
}

function extractAutouse(decorators: string[], source: string): boolean {
  for (const dec of decorators) {
    if (dec.includes("autouse=True") || dec.includes("autouse=true")) return true;
  }
  return source.includes("autouse=True") || source.includes("autouse=true");
}

function extractDependencies(sym: CodeSymbol, knownFixtures: Set<string>): string[] {
  const source = sym.source ?? "";
  const sig = sym.signature ?? "";

  // Extract parameter names from the function signature
  const paramMatch = sig.match(/\(([^)]*)\)/);
  if (!paramMatch) return [];

  const params = paramMatch[1]!
    .split(",")
    .map((p) => p.trim().split(":")[0]!.split("=")[0]!.trim())
    .filter((p) => p.length > 0 && p !== "self" && p !== "cls");

  // Filter to known fixtures (excluding builtins unless they're custom-defined)
  return params.filter((p) =>
    (knownFixtures.has(p) || BUILTIN_FIXTURES.has(p)) && p !== sym.name,
  );
}
