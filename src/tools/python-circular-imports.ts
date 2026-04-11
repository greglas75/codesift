/**
 * find_python_circular_imports — detect Python import cycles with full paths.
 *
 * Python circular imports cause runtime ImportError — unlike JS where
 * hoisted imports usually work. This tool uses the Python import graph
 * (from python-imports.ts + python-import-resolver.ts) to build a file→file
 * adjacency and find cycles via DFS.
 *
 * Reports the full cycle path so users can identify which edge to break.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { getParser } from "../parser/parser-manager.js";
import { extractPythonImports } from "../utils/python-imports.js";
import { resolvePythonImport, detectSrcLayout } from "../utils/python-import-resolver.js";

export interface CircularImportCycle {
  cycle: string[];         // list of file paths forming the cycle (first === last)
  length: number;
  severity: "error" | "warning";
  note: string;
}

export interface CircularImportsResult {
  cycles: CircularImportCycle[];
  total: number;
  files_scanned: number;
}

/**
 * Find all Python circular imports in the repository.
 */
export async function findPythonCircularImports(
  repo: string,
  options?: {
    file_pattern?: string;
    max_cycles?: number;
  },
): Promise<CircularImportsResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;
  const maxCycles = options?.max_cycles ?? 50;

  // Collect Python files
  const pyFiles = index.files
    .filter((f) => f.path.endsWith(".py"))
    .filter((f) => !filePattern || f.path.includes(filePattern))
    .map((f) => f.path);

  const pyFileSet = new Set(pyFiles);
  const srcLayout = detectSrcLayout(pyFiles);

  // Build file → file adjacency via extractPythonImports + resolvePythonImport
  const adjacency = new Map<string, Set<string>>();
  const parser = await getParser("python");
  if (!parser) {
    return { cycles: [], total: 0, files_scanned: 0 };
  }

  for (const filePath of pyFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, filePath), "utf-8");
    } catch {
      continue;
    }

    const tree = parser.parse(source);
    const imports = extractPythonImports(tree);
    const outgoing = new Set<string>();

    for (const imp of imports) {
      // Skip type-only imports (not a runtime cycle)
      if (imp.is_type_only) continue;
      const resolved = resolvePythonImport(
        { module: imp.module, level: imp.level },
        filePath,
        pyFileSet,
        srcLayout,
      );
      if (resolved && resolved !== filePath && pyFileSet.has(resolved)) {
        outgoing.add(resolved);
      }
    }

    adjacency.set(filePath, outgoing);
  }

  // Find all cycles via DFS
  const cycles: CircularImportCycle[] = [];
  const cycleSignatures = new Set<string>();

  function dfs(
    node: string,
    visited: Set<string>,
    path: string[],
  ): void {
    if (cycles.length >= maxCycles) return;
    if (visited.has(node)) {
      // Found a cycle — extract from path
      const cycleStart = path.indexOf(node);
      if (cycleStart === -1) return;
      const cycle = [...path.slice(cycleStart), node];

      // Canonicalize for dedup (start from lexicographically smallest)
      const sig = canonicalizeCycle(cycle);
      if (cycleSignatures.has(sig)) return;
      cycleSignatures.add(sig);

      cycles.push({
        cycle,
        length: cycle.length - 1,
        severity: cycle.length <= 3 ? "error" : "warning",
        note: cycle.length <= 3
          ? "Short cycle — likely causes ImportError at runtime"
          : "Long cycle — may work if imports are inside functions/methods",
      });
      return;
    }

    visited.add(node);
    path.push(node);

    const neighbors = adjacency.get(node);
    if (neighbors) {
      for (const next of neighbors) {
        dfs(next, new Set(visited), [...path]);
      }
    }
  }

  for (const start of pyFiles) {
    if (cycles.length >= maxCycles) break;
    dfs(start, new Set(), []);
  }

  return {
    cycles,
    total: cycles.length,
    files_scanned: pyFiles.length,
  };
}

/**
 * Canonicalize a cycle for dedup: rotate to start from the lex-smallest node.
 */
function canonicalizeCycle(cycle: string[]): string {
  if (cycle.length < 2) return cycle.join("->");
  // Drop the repeated last element
  const core = cycle.slice(0, -1);
  // Find the lex-smallest start
  let minIdx = 0;
  for (let i = 1; i < core.length; i++) {
    if (core[i]! < core[minIdx]!) minIdx = i;
  }
  const rotated = [...core.slice(minIdx), ...core.slice(0, minIdx)];
  rotated.push(rotated[0]!);
  return rotated.join("->");
}
