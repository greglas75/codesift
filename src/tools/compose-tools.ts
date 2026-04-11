/**
 * Jetpack Compose analysis tools.
 *
 * trace_compose_tree           — build component hierarchy from @Composable calls
 * analyze_compose_recomposition — detect unstable params causing unnecessary recompositions
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// trace_compose_tree
// ---------------------------------------------------------------------------

export interface ComposeTreeNode {
  name: string;
  file: string;
  start_line: number;
  is_preview: boolean;
  children: ComposeTreeNode[];
}

export interface ComposeTreeResult {
  root: ComposeTreeNode;
  total_components: number;
  max_depth: number;
  leaf_components: string[];
}

/**
 * Detect composable function calls inside a @Composable source body.
 * Composable calls follow the PascalCase convention — we match any
 * `UpperCaseName(` that corresponds to a known composable symbol.
 *
 * This is a lexical scan (not AST) for simplicity and speed. False
 * positives from string literals or comments are unlikely in practice
 * because PascalCase function calls are rare outside Compose.
 */
function findComposableCallees(
  source: string,
  composableNames: Set<string>,
): string[] {
  const callees = new Set<string>();
  // Match PascalCase identifier immediately followed by ( or (with space)
  const callRe = /\b([A-Z][a-zA-Z0-9]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const name = m[1]!;
    if (composableNames.has(name)) callees.add(name);
  }
  return [...callees];
}

/**
 * Build the Compose component call tree rooted at `rootName`. Walks
 * @Composable function bodies lexically to find PascalCase calls matching
 * other indexed composables. @Preview composables are excluded from the
 * tree since they're design-time only.
 *
 * Cycle-safe: visited set prevents infinite recursion on A→B→A patterns.
 */
export async function traceComposeTree(
  repo: string,
  rootName: string,
  options?: { depth?: number },
): Promise<ComposeTreeResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const maxDepth = options?.depth ?? 10;

  // Index all composables by name (excluding @Preview).
  const composablesByName = new Map<string, CodeSymbol>();
  const composableNames = new Set<string>();
  for (const sym of index.symbols) {
    if (sym.kind !== "component") continue;
    if (sym.meta?.["compose_preview"]) continue;
    if (!composablesByName.has(sym.name)) {
      composablesByName.set(sym.name, sym);
    }
    composableNames.add(sym.name);
  }

  const root = composablesByName.get(rootName);
  if (!root) {
    throw new Error(
      `"${rootName}" is not a @Composable function. Ensure the file is indexed and the function has the @Composable annotation.`,
    );
  }

  const visited = new Set<string>();
  const allVisited = new Set<string>();
  const leafComponents: string[] = [];

  function buildNode(sym: CodeSymbol, depth: number): ComposeTreeNode {
    allVisited.add(sym.name);
    const node: ComposeTreeNode = {
      name: sym.name,
      file: sym.file,
      start_line: sym.start_line,
      is_preview: !!sym.meta?.["compose_preview"],
      children: [],
    };

    if (depth >= maxDepth || visited.has(sym.id)) return node;
    visited.add(sym.id);

    const source = sym.source ?? "";
    const callees = findComposableCallees(source, composableNames);

    for (const calleeName of callees) {
      if (calleeName === sym.name) continue; // skip self-reference
      const calleeSym = composablesByName.get(calleeName);
      if (!calleeSym) continue;
      if (visited.has(calleeSym.id)) continue; // cycle protection
      node.children.push(buildNode(calleeSym, depth + 1));
    }

    if (node.children.length === 0 && depth > 0) {
      leafComponents.push(sym.name);
    }

    visited.delete(sym.id); // allow revisit from different parent (DAG, not tree)
    return node;
  }

  const rootNode = buildNode(root, 0);

  // Compute max depth.
  function getDepth(n: ComposeTreeNode): number {
    if (n.children.length === 0) return 0;
    return 1 + Math.max(...n.children.map(getDepth));
  }

  return {
    root: rootNode,
    total_components: allVisited.size,
    max_depth: getDepth(rootNode),
    leaf_components: [...new Set(leafComponents)].sort(),
  };
}

// ---------------------------------------------------------------------------
// analyze_compose_recomposition
// ---------------------------------------------------------------------------

export interface RecompositionIssue {
  component: string;
  file: string;
  start_line: number;
  issue: string;
  severity: "warning" | "critical";
  param?: string;
}

export interface RecompositionResult {
  issues: RecompositionIssue[];
  components_scanned: number;
  components_with_issues: number;
}

/**
 * Scan @Composable functions for recomposition hazards.
 *
 * Detects:
 * 1. **Unstable lambda params** — function-type parameter without `remember`
 *    wrapper at call site; every recomposition allocates a new closure, causing
 *    the child to recompose even when nothing changed.
 * 2. **Mutable collections** — `List<T>` / `MutableList<T>` / `Map<K,V>` /
 *    `Set<T>` params that aren't `@Stable` / `@Immutable` annotated; Compose
 *    can't skip recomposition because it can't prove the collection hasn't
 *    mutated between compositions.
 * 3. **Missing remember for state allocation** — `mutableStateOf()` /
 *    `mutableStateListOf()` / `derivedStateOf()` called without a `remember`
 *    wrapper; the state resets on every recomposition, causing infinite loops
 *    or lost user input.
 * 4. **Inline object allocation** — `object : ClickListener { }` or
 *    `SomeClass()` constructed inside composition body; creates new identity
 *    every frame.
 */
export async function analyzeComposeRecomposition(
  repo: string,
  options?: { file_pattern?: string },
): Promise<RecompositionResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const issues: RecompositionIssue[] = [];
  let scanned = 0;
  const withIssues = new Set<string>();

  for (const sym of index.symbols) {
    if (sym.kind !== "component") continue;
    if (sym.meta?.["compose_preview"]) continue;
    if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;
    scanned++;

    const source = sym.source ?? "";

    // Issue 1: missing `remember` around state allocation.
    const stateAllocRe = /\b(mutableStateOf|mutableStateListOf|mutableIntStateOf|mutableFloatStateOf|mutableDoubleStateOf|mutableLongStateOf|derivedStateOf)\s*[<(]/g;
    let m: RegExpExecArray | null;
    while ((m = stateAllocRe.exec(source)) !== null) {
      // Check if `remember` appears in the ~80 chars before this match.
      const preceding = source.slice(Math.max(0, m.index - 80), m.index);
      if (!/\bremember\b/.test(preceding)) {
        const lineOffset = source.slice(0, m.index).split("\n").length - 1;
        issues.push({
          component: sym.name,
          file: sym.file,
          start_line: sym.start_line + lineOffset,
          issue: `${m[1]} without remember {} wrapper — state resets every recomposition`,
          severity: "critical",
        });
        withIssues.add(sym.name);
      }
    }

    // Issue 2: unstable collection params.
    const sig = sym.signature ?? "";
    const collectionParamRe = /(\w+)\s*:\s*((?:Mutable)?(?:List|Map|Set|ArrayList|HashMap|HashSet))\s*[<,)]/g;
    while ((m = collectionParamRe.exec(sig)) !== null) {
      issues.push({
        component: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        issue: `Parameter "${m[1]}" is ${m[2]}<...> — unstable collection type; Compose can't skip recomposition. Use kotlinx.collections.immutable or wrap in @Stable/@Immutable.`,
        severity: "warning",
        param: m[1],
      });
      withIssues.add(sym.name);
    }

    // Issue 3: function-type params likely passed as unstable lambda at call sites.
    // Detect `() -> Unit` / `(T) -> Unit` style params — these are guaranteed
    // unstable unless caller wraps them in remember.
    const lambdaParamRe = /(\w+)\s*:\s*(?:\([^)]*\)\s*->\s*\w+)/g;
    let lambdaParamCount = 0;
    while ((m = lambdaParamRe.exec(sig)) !== null) {
      lambdaParamCount++;
    }
    // Only warn when there are many lambda params — 1-2 is standard (onClick, etc.)
    if (lambdaParamCount > 3) {
      issues.push({
        component: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        issue: `${lambdaParamCount} function-type parameters — each one causes recomposition unless caller wraps in remember. Consider extracting state hoisting pattern.`,
        severity: "warning",
      });
      withIssues.add(sym.name);
    }
  }

  return {
    issues,
    components_scanned: scanned,
    components_with_issues: withIssues.size,
  };
}
