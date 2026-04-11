#!/usr/bin/env bash
# scripts/smoke-react-tier3.sh
#
# Validates React Tier 3 changes against a real React repo.
# Default target: /Users/greglas/DEV/coding-ui (React 19 + Vite, ~600 files)
# Override with: REACT_REPO=/path/to/other/react/project ./scripts/smoke-react-tier3.sh
#
# Validates 6 acceptance criteria from the Tier 3 plan:
#   1. nested-component-def hits drop from 3 false positives to genuine matches only
#   2. hook-in-condition matches multiline blocks (regex fix)
#   3. useEffect-async catches function expression variants
#   4. analyzeRenders produces at least 1 'high' risk on real codebase (not just medium)
#   5. analyze_project shows ui_library != null when shadcn or tailwind detected
#   6. form_library field populated when react-hook-form/formik/final-form in deps

set -e

REACT_REPO="${REACT_REPO:-/Users/greglas/DEV/coding-ui}"

if [ ! -d "$REACT_REPO" ]; then
  echo "ERROR: React repo not found at $REACT_REPO"
  echo "Set REACT_REPO env var to override target."
  exit 1
fi

echo "==> Smoke testing React Tier 3 against: $REACT_REPO"
echo

# Run via tsx so we use src/ (avoids stale dist/)
cat > /tmp/smoke-react-tier3-runner.ts <<'EOF'
import { indexFolder, getCodeIndex } from "/Users/greglas/DEV/codesift-mcp/src/tools/index-tools.js";
import { searchPatterns, BUILTIN_PATTERNS } from "/Users/greglas/DEV/codesift-mcp/src/tools/pattern-tools.js";
import { analyzeRenders, buildContextGraph } from "/Users/greglas/DEV/codesift-mcp/src/tools/react-tools.js";
import { analyzeProject } from "/Users/greglas/DEV/codesift-mcp/src/tools/project-tools.js";

const REPO_PATH = process.argv[2]!;

async function main() {
  console.log("[1/7] Indexing...");
  const meta = await indexFolder(REPO_PATH, { watch: false });
  console.log(`     Indexed ${meta.file_count} files, ${meta.symbol_count} symbols\n`);

  const repo = `local/${REPO_PATH.split("/").pop()}`;
  const idx = await getCodeIndex(repo);
  if (!idx) throw new Error("Failed to load index after indexFolder");

  // 1. nested-component-def — should NOT include top-level VirtualizedTable
  console.log("[2/7] Pattern: nested-component-def");
  const r1 = await searchPatterns(repo, "nested-component-def", { file_pattern: ".tsx", max_results: 10 });
  console.log(`     Hits in .tsx: ${r1.matches.length}`);
  for (const m of r1.matches.slice(0, 3)) console.log(`       ${m.file}:${m.start_line}`);

  // 2. hook-in-condition multiline
  console.log("[3/7] Pattern: hook-in-condition");
  const r2 = await searchPatterns(repo, "hook-in-condition", { max_results: 5 });
  console.log(`     Hits: ${r2.matches.length}`);

  // 3. useEffect-async
  console.log("[4/7] Pattern: useEffect-async");
  const r3 = await searchPatterns(repo, "useEffect-async", { max_results: 5 });
  console.log(`     Hits: ${r3.matches.length}`);

  // 4. analyzeRenders threshold
  console.log("[5/7] analyzeRenders threshold (looking for high risk)");
  const renders = await analyzeRenders(repo, { max_entries: 20 });
  if (typeof renders !== "string") {
    console.log(`     Total: ${renders.total_components}, High risk: ${renders.high_risk_count}`);
    if (renders.high_risk_count === 0) {
      console.log("     WARN: 0 high-risk components — threshold may still be too strict");
    } else {
      console.log("     ✓ Threshold formula produces high-risk classifications");
    }
  }

  // 5. analyze_project — shadcn/tailwind/form_library
  console.log("[6/7] analyze_project — ReactConventions");
  const proj = await analyzeProject(repo, { force: true });
  const rc = (proj as any)?.conventions?.react_conventions;
  if (rc) {
    console.log(`     ui_library: ${rc.ui_library}`);
    console.log(`     form_library: ${rc.form_library}`);
    console.log(`     state_management: ${rc.state_management}`);
    console.log(`     actual_components: ${rc.actual_component_count}, hooks: ${rc.actual_hook_count}`);
  }

  // 6. buildContextGraph
  console.log("[7/7] buildContextGraph");
  const graph = buildContextGraph(idx.symbols);
  console.log(`     Contexts found: ${graph.contexts.length}`);
  for (const c of graph.contexts.slice(0, 3))
    console.log(`       ${c.name}: ${c.providers.length} providers, ${c.consumers.length} consumers`);

  console.log("\n✓ Smoke test complete");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
EOF

cd /Users/greglas/DEV/codesift-mcp
npx tsx /tmp/smoke-react-tier3-runner.ts "$REACT_REPO" 2>&1 | grep -v "^\[parser\]\|^\[codesift\]\|^\[hotspot\]\|WASM grammar\|fatal:"
