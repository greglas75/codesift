/**
 * End-to-end smoke test for Python Phase 2-4 tools on a real project.
 *
 * Usage:
 *   npx tsx scripts/bench-python-phase-2-4.ts [project-path]
 *
 * Default: /tmp/review-projects/flask
 *
 * Exercises:
 *   - search_patterns (17 Python anti-patterns)
 *   - trace_route (Flask/FastAPI/Django)
 *   - get_model_graph
 *   - get_test_fixtures
 *   - find_framework_wiring
 *   - parse_pyproject
 *   - (run_ruff skipped — requires ruff installed)
 */
import { join } from "node:path";
import { initParser } from "../src/parser/parser-manager.js";
import { indexFolder, getCodeIndex } from "../src/tools/index-tools.js";
import { searchPatterns, BUILTIN_PATTERNS } from "../src/tools/pattern-tools.js";
import { traceRoute } from "../src/tools/route-tools.js";
import { getModelGraph } from "../src/tools/model-tools.js";
import { getTestFixtures } from "../src/tools/pytest-tools.js";
import { findFrameworkWiring } from "../src/tools/wiring-tools.js";
import { parsePyproject } from "../src/tools/pyproject-tools.js";

const DEFAULT_PROJECT = "/tmp/review-projects/flask";

const projectPath = process.argv[2] ?? DEFAULT_PROJECT;

function section(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${title}`);
  console.log("=".repeat(60));
}

function fmt(obj: unknown, maxLen = 500): string {
  const s = JSON.stringify(obj, null, 2);
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

async function main(): Promise<void> {
  console.log(`\nPython Phase 2-4 Benchmark — ${projectPath}`);

  await initParser();

  section("1. Index project");
  const t0 = Date.now();
  const indexResult = await indexFolder(projectPath);
  const repoName = indexResult.repo;
  console.log(`repo: ${repoName}`);
  const index = await getCodeIndex(repoName);
  if (!index) {
    console.error("Failed to index project");
    process.exit(1);
  }
  const indexMs = Date.now() - t0;
  console.log(`Indexed in ${indexMs}ms`);
  console.log(`Files: ${index.file_count}, Symbols: ${index.symbol_count}`);
  const pyFiles = index.files.filter((f) => f.path.endsWith(".py")).length;
  console.log(`Python files: ${pyFiles}`);

  // ---------------------------------------------------------------
  section("2. search_patterns — Python anti-patterns");
  const pythonPatterns = [
    "mutable-default",
    "bare-except",
    "broad-except",
    "star-import",
    "eval-exec",
    "shell-true",
    "pickle-load",
    "datetime-naive",
  ];

  for (const pat of pythonPatterns) {
    if (!BUILTIN_PATTERNS[pat]) continue;
    try {
      const result = await searchPatterns(repoName, pat, { max_results: 5 });
      console.log(
        `  ${pat.padEnd(20)} ${result.matches.length.toString().padStart(3)} matches ` +
        `(${result.scanned_symbols} scanned)`,
      );
      if (result.matches.length > 0 && result.matches[0]) {
        const m = result.matches[0];
        console.log(`    └─ ${m.file}:${m.start_line} in ${m.name}`);
      }
    } catch (err) {
      console.log(`  ${pat}: ERROR — ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------
  section("3. trace_route — Flask routes");
  const routes = ["/", "/hello", "/api"];
  for (const path of routes) {
    try {
      const result = await traceRoute(repoName, path);
      if ("handlers" in result) {
        console.log(
          `  ${path.padEnd(15)} ${result.handlers.length} handlers, ` +
          `${result.db_calls.length} DB calls`,
        );
        if (result.handlers.length > 0 && result.handlers[0]) {
          const h = result.handlers[0];
          console.log(`    └─ ${h.framework} ${h.method ?? "*"} ${h.file}`);
        }
      }
    } catch (err) {
      console.log(`  ${path}: ERROR — ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------
  section("4. get_model_graph");
  try {
    const graph = await getModelGraph(repoName);
    if ("models" in graph) {
      console.log(`  Models: ${graph.models.length}, Edges: ${graph.edges.length}`);
      console.log(`  Framework: ${graph.framework}`);
      if (graph.models.length > 0) {
        console.log(`  Sample: ${graph.models.slice(0, 3).map((m) => m.name).join(", ")}`);
      }
    }
  } catch (err) {
    console.log(`  ERROR — ${(err as Error).message}`);
  }

  // ---------------------------------------------------------------
  section("5. get_test_fixtures — pytest");
  try {
    const fixtures = await getTestFixtures(repoName);
    console.log(`  Fixtures: ${fixtures.fixture_count}`);
    console.log(`  Conftest files: ${fixtures.conftest_files.length}`);
    if (fixtures.conftest_files.length > 0) {
      console.log(`  First 3: ${fixtures.conftest_files.slice(0, 3).join(", ")}`);
    }
    const scopes = fixtures.fixtures.reduce<Record<string, number>>((acc, f) => {
      acc[f.scope] = (acc[f.scope] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  Scopes: ${fmt(scopes)}`);
    const withDeps = fixtures.fixtures.filter((f) => f.depends_on.length > 0);
    console.log(`  Fixtures with deps: ${withDeps.length}`);
    if (withDeps[0]) {
      console.log(`  Sample: ${withDeps[0].name} → [${withDeps[0].depends_on.join(", ")}]`);
    }
  } catch (err) {
    console.log(`  ERROR — ${(err as Error).message}`);
  }

  // ---------------------------------------------------------------
  section("6. find_framework_wiring");
  try {
    const wiring = await findFrameworkWiring(repoName);
    console.log(`  Total wiring points: ${wiring.total}`);
    console.log(`  By type: ${fmt(wiring.by_type)}`);
    if (wiring.entries.length > 0) {
      console.log(`  First 3:`);
      for (const e of wiring.entries.slice(0, 3)) {
        console.log(`    ${e.type.padEnd(14)} ${e.name.padEnd(20)} ${e.file}:${e.line}`);
      }
    }
  } catch (err) {
    console.log(`  ERROR — ${(err as Error).message}`);
  }

  // ---------------------------------------------------------------
  section("7. parse_pyproject");
  try {
    const info = await parsePyproject(repoName);
    if (info) {
      console.log(`  Name: ${info.name}`);
      console.log(`  Version: ${info.version}`);
      console.log(`  Requires Python: ${info.requires_python}`);
      console.log(`  Build system: ${info.build_system}`);
      console.log(`  Dependencies: ${info.dependencies.length}`);
      if (info.dependencies.length > 0) {
        const sample = info.dependencies.slice(0, 3).map((d) => `${d.name}${d.version}`).join(", ");
        console.log(`    Sample: ${sample}`);
      }
      console.log(`  Optional groups: ${Object.keys(info.optional_dependencies).join(", ")}`);
      console.log(`  Configured tools: ${info.configured_tools.join(", ")}`);
    } else {
      console.log(`  No pyproject.toml found`);
    }
  } catch (err) {
    console.log(`  ERROR — ${(err as Error).message}`);
  }

  section("DONE");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  console.error((err as Error).stack);
  process.exit(1);
});
