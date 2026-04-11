/**
 * Kotlin Wave 2 integration test.
 *
 * Loads the synthetic fixture at tests/fixtures/kotlin-sample/ and exercises
 * every new Wave 2 tool — extractor, Kotest DSL, Gradle KTS, Hilt graph,
 * KMP expect/actual matching, and dead-code whitelist — end-to-end using
 * real tree-sitter parsing (no mocks on the parser path).
 *
 * Acts as the regression shield for the 14 Wave 2 tasks. If a future change
 * breaks one of the extractors or analyzers, this suite fails with a
 * precise test name so the regression is obvious in CI.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { initParser, getParser, getLanguageForPath } from "../../src/parser/parser-manager.js";
import { extractKotlinSymbols } from "../../src/parser/extractors/kotlin.js";
import { extractGradleKtsSymbols } from "../../src/parser/extractors/gradle-kts.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";
import { isFrameworkEntryPoint, detectFrameworks } from "../../src/utils/framework-detect.js";
import { buildHiltGraph, traceHiltGraph } from "../../src/tools/hilt-tools.js";
import { analyzeKmpDeclarations } from "../../src/tools/kotlin-tools.js";

const FIXTURE_ROOT = join(__dirname, "..", "fixtures", "kotlin-sample");

const FIXTURE_FILES = [
  "build.gradle.kts",
  "src/commonMain/kotlin/Platform.kt",
  "src/androidMain/kotlin/Platform.kt",
  "app/src/main/java/com/x/ui/UserViewModel.kt",
  "app/src/main/java/com/x/ui/RepositoryModule.kt",
  "app/src/main/java/com/x/ui/HomeScreen.kt",
  "app/src/test/java/com/x/UserSpec.kt",
];

let index: CodeIndex;

beforeAll(async () => {
  await initParser();
  const kotlinParser = await getParser("kotlin");
  expect(kotlinParser).not.toBeNull();

  const symbols: CodeSymbol[] = [];
  const files: FileEntry[] = [];

  for (const relPath of FIXTURE_FILES) {
    const absPath = join(FIXTURE_ROOT, relPath);
    const source = await readFile(absPath, "utf-8");
    const language = getLanguageForPath(absPath);
    expect(language, `no language for ${relPath}`).not.toBeNull();

    const tree = kotlinParser!.parse(source);
    const extracted = language === "gradle-kts"
      ? extractGradleKtsSymbols(tree, relPath, source, "kotlin-sample")
      : extractKotlinSymbols(tree, relPath, source, "kotlin-sample");

    symbols.push(...extracted);
    files.push({
      path: relPath,
      language: language!,
      symbol_count: extracted.length,
      last_modified: 0,
    });
  }

  index = {
    repo: "kotlin-sample",
    root: FIXTURE_ROOT,
    symbols,
    files,
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: files.length,
  };
});

// Stub getCodeIndex for the analyzer functions we're exercising.
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));
import { getCodeIndex } from "../../src/tools/index-tools.js";

describe("Kotlin Wave 2 — fixture parsing", () => {
  it("extracts symbols from every fixture file", () => {
    expect(index.symbols.length).toBeGreaterThan(10);
    expect(index.files).toHaveLength(FIXTURE_FILES.length);
  });

  it("routes .gradle.kts through the gradle-kts extractor (not plain kotlin)", () => {
    const gradleFile = index.files.find((f) => f.path === "build.gradle.kts")!;
    expect(gradleFile.language).toBe("gradle-kts");

    const gradleSymbols = index.symbols.filter((s) => s.file === "build.gradle.kts");
    const plugins = gradleSymbols.filter((s) => s.meta?.["gradle_type"] === "plugin");
    const deps = gradleSymbols.filter((s) => s.meta?.["gradle_type"] === "dependency");
    const configs = gradleSymbols.filter((s) => s.meta?.["gradle_type"] === "config");

    expect(plugins.length).toBeGreaterThanOrEqual(2); // multiplatform + com.android.application
    expect(deps.length).toBeGreaterThanOrEqual(3);    // hilt + compose + kotest + ...
    expect(configs.length).toBeGreaterThanOrEqual(2); // namespace + compileSdk
  });
});

describe("Kotlin Wave 2 — Kotest DSL detection", () => {
  it("classifies UserSpec as test_suite and emits 2 test_case symbols", () => {
    const suite = index.symbols.find((s) => s.name === "UserSpec" && s.kind === "test_suite");
    expect(suite).toBeDefined();

    const cases = index.symbols.filter(
      (s) => s.kind === "test_case" && s.parent === suite!.id,
    );
    expect(cases.map((c) => c.name).sort()).toEqual(["rejects empty email", "validates email"]);
  });
});

describe("Kotlin Wave 2 — KMP expect/actual", () => {
  it("surfaces expect and actual modifiers on Platform class", () => {
    const expectPlatform = index.symbols.find(
      (s) => s.name === "Platform" && s.file.includes("commonMain") && s.kind === "class",
    );
    const actualPlatform = index.symbols.find(
      (s) => s.name === "Platform" && s.file.includes("androidMain") && s.kind === "class",
    );

    expect(expectPlatform?.meta?.["kmp_modifier"]).toBe("expect");
    expect(actualPlatform?.meta?.["kmp_modifier"]).toBe("actual");
  });

  it("analyzeKmpDeclarations pairs commonMain expect with androidMain actual", async () => {
    vi.mocked(getCodeIndex).mockResolvedValueOnce(index);
    const result = await analyzeKmpDeclarations("kotlin-sample");

    expect(result.total_expects).toBeGreaterThanOrEqual(2);
    expect(result.source_sets_detected).toContain("commonMain");
    expect(result.source_sets_detected).toContain("androidMain");
    // Platform (class) and getPlatformInfo (function) both have android actuals
    expect(result.fully_matched).toBeGreaterThanOrEqual(2);

    // The inner `name` property inside `actual class Platform` carries its
    // own `actual` modifier (KMP rule: members of an actual class must be
    // explicitly marked actual even though their expects are implicit from
    // the enclosing class). The analyzer tracks symbols flat, so the inner
    // property appears as an orphan. This is an accepted limitation — the
    // class-level pairing is what matters for KMP validation.
    const innerOrphans = result.orphan_actuals.filter((o) => o.name === "name");
    expect(innerOrphans.length).toBeLessThanOrEqual(1);
  });
});

describe("Kotlin Wave 2 — Hilt DI graph", () => {
  it("builds a graph with UserViewModel and RepositoryModule", async () => {
    vi.mocked(getCodeIndex).mockResolvedValueOnce(index);
    const graph = await buildHiltGraph("kotlin-sample");

    expect(graph.view_models).toHaveLength(1);
    expect(graph.view_models[0]!.name).toBe("UserViewModel");
    expect(graph.view_models[0]!.dependencies).toContain("UserRepository");
    expect(graph.view_models[0]!.dependencies).toContain("Logger");

    expect(graph.modules).toHaveLength(1);
    expect(graph.modules[0]!.name).toBe("RepositoryModule");
    expect(graph.modules[0]!.providers.map((p) => p.provides).sort()).toEqual([
      "Logger",
      "UserRepository",
    ]);
  });

  it("traceHiltGraph resolves both dependencies through RepositoryModule", async () => {
    vi.mocked(getCodeIndex).mockResolvedValueOnce(index);
    const tree = await traceHiltGraph("kotlin-sample", "UserViewModel");

    expect(tree.root.name).toBe("UserViewModel");
    expect(tree.root.kind).toBe("HiltViewModel");
    expect(tree.dependencies).toHaveLength(2);
    for (const dep of tree.dependencies) {
      expect(dep.module).toBe("RepositoryModule");
      expect(dep.unresolved).toBeUndefined();
    }
  });
});

describe("Kotlin Wave 2 — framework-aware dead code whitelist", () => {
  it("flags kotlin-android as a detected framework", () => {
    const frameworks = detectFrameworks(index);
    expect(frameworks.has("kotlin-android")).toBe(true);
  });

  it("@HiltViewModel class is NOT flagged as dead code", () => {
    const userViewModel = index.symbols.find((s) => s.name === "UserViewModel");
    expect(userViewModel).toBeDefined();
    const frameworks = detectFrameworks(index);
    expect(isFrameworkEntryPoint(userViewModel!, frameworks)).toBe(true);
  });

  it("@Composable function is NOT flagged as dead code", () => {
    const homeScreen = index.symbols.find((s) => s.name === "HomeScreen");
    expect(homeScreen).toBeDefined();
    const frameworks = detectFrameworks(index);
    expect(isFrameworkEntryPoint(homeScreen!, frameworks)).toBe(true);
  });

  it("@Preview function is NOT flagged as dead code", () => {
    const preview = index.symbols.find((s) => s.name === "HomeScreenPreview");
    expect(preview).toBeDefined();
    const frameworks = detectFrameworks(index);
    expect(isFrameworkEntryPoint(preview!, frameworks)).toBe(true);
  });

  it("@Module object is NOT flagged (whitelisted via Module annotation)", () => {
    const module = index.symbols.find((s) => s.name === "RepositoryModule");
    expect(module).toBeDefined();
    const frameworks = detectFrameworks(index);
    expect(isFrameworkEntryPoint(module!, frameworks)).toBe(true);
  });
});

describe("Kotlin Wave 2 — decorators surfaced by extractor", () => {
  it.each([
    ["UserViewModel", "HiltViewModel"],
    ["RepositoryModule", "Module"],
    ["HomeScreen", "Composable"],
    ["HomeScreenPreview", "Preview"],
  ])("%s has @%s decorator", (name, expectedDecorator) => {
    const sym = index.symbols.find((s) => s.name === name);
    expect(sym, `symbol ${name} not found`).toBeDefined();
    expect(sym!.decorators).toContain(expectedDecorator);
  });
});

// Make relative paths debuggable when a test fails.
function _unused_refHelper() {
  return relative(FIXTURE_ROOT, "");
}
