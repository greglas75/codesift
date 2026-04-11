/**
 * find_python_callers — cross-module call site tracing for Python.
 *
 * Given a Python symbol (function, class, method), find every place it's
 * referenced across the codebase. Uses the Python import graph to resolve
 * `from myapp.utils import foo` style imports, then scans symbol sources
 * for usage patterns.
 *
 * Differs from generic `find_references`:
 *   - Python-aware: understands `X.delay()` for Celery task calls, `X()` for
 *     constructor calls, `.X.method()` for method access
 *   - Returns call context (containing function, call kind)
 *   - Respects Python aliasing: `from X import Y as Z`
 */
import { getCodeIndex } from "./index-tools.js";

export interface PythonCallerInfo {
  caller_symbol: string;
  caller_kind: string;
  caller_file: string;
  caller_line: number;
  call_kind: "direct" | "method" | "delay" | "apply_async" | "constructor" | "reference";
  context: string; // the matching line, trimmed
}

export interface PythonCallersResult {
  target: {
    name: string;
    file: string;
    kind: string;
  };
  callers: PythonCallerInfo[];
  caller_count: number;
  called_from_files: string[];
}

/**
 * Find all Python call sites of a given symbol.
 * The target is identified by name (+ optional file pattern to disambiguate).
 */
export async function findPythonCallers(
  repo: string,
  targetName: string,
  options?: {
    file_pattern?: string;      // restrict caller search scope
    target_file?: string;        // disambiguate target if name collides
    max_results?: number;
  },
): Promise<PythonCallersResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const maxResults = options?.max_results ?? 100;

  // 1. Find the target symbol
  const candidates = index.symbols.filter((s) => {
    if (s.name !== targetName) return false;
    if (!s.file.endsWith(".py")) return false;
    if (options?.target_file && !s.file.includes(options.target_file)) return false;
    return true;
  });

  if (candidates.length === 0) {
    throw new Error(`Symbol "${targetName}" not found in Python files`);
  }

  // Prefer function/class/method over variable if ambiguous
  const targetSymbol = candidates.find(
    (s) => ["function", "method", "class"].includes(s.kind),
  ) ?? candidates[0]!;

  // 2. Build regex patterns for different call kinds
  // Escape the symbol name for regex (though Python names shouldn't have metacharacters)
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Patterns ordered by specificity (most specific first)
  const patterns: Array<{ re: RegExp; kind: PythonCallerInfo["call_kind"] }> = [
    // Celery: foo.delay(...) or foo.apply_async(...)
    { re: new RegExp(`\\b${escaped}\\.delay\\s*\\(`), kind: "delay" },
    { re: new RegExp(`\\b${escaped}\\.apply_async\\s*\\(`), kind: "apply_async" },
    // Method call: X.foo(...)
    { re: new RegExp(`\\b\\w+\\.${escaped}\\s*\\(`), kind: "method" },
    // Direct call: foo(...)
    { re: new RegExp(`\\b${escaped}\\s*\\(`), kind: "direct" },
    // Reference (no call): foo (as arg, assignment, etc.)
    { re: new RegExp(`\\b${escaped}\\b`), kind: "reference" },
  ];

  // 3. Scan all Python symbols for callers
  const callers: PythonCallerInfo[] = [];
  const filesSeen = new Set<string>();
  const filePattern = options?.file_pattern;

  for (const sym of index.symbols) {
    if (callers.length >= maxResults) break;
    if (!sym.file.endsWith(".py")) continue;
    if (sym.file === targetSymbol.file && sym.name === targetSymbol.name) continue; // skip self
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (!sym.source) continue;

    // Find first matching pattern (most specific wins)
    let matched: { kind: PythonCallerInfo["call_kind"]; context: string } | null = null;
    for (const { re, kind } of patterns) {
      re.lastIndex = 0;
      const m = re.exec(sym.source);
      if (m) {
        // Extract the matching line for context
        const lineStart = sym.source.lastIndexOf("\n", m.index) + 1;
        const lineEnd = sym.source.indexOf("\n", m.index);
        const line = sym.source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        matched = { kind, context: line.slice(0, 200) };
        break;
      }
    }

    if (!matched) continue;

    // Count how many lines into the symbol the match occurred
    const matchIdx = patterns.find((p) => p.re.test(sym.source!))?.re.exec(sym.source)?.index ?? 0;
    const linesBefore = sym.source.slice(0, matchIdx).split("\n").length - 1;

    callers.push({
      caller_symbol: sym.name,
      caller_kind: sym.kind,
      caller_file: sym.file,
      caller_line: sym.start_line + linesBefore,
      call_kind: matched.kind,
      context: matched.context,
    });
    filesSeen.add(sym.file);
  }

  return {
    target: {
      name: targetSymbol.name,
      file: targetSymbol.file,
      kind: targetSymbol.kind,
    },
    callers,
    caller_count: callers.length,
    called_from_files: [...filesSeen].sort(),
  };
}
