/**
 * React hook inventory and Rule of Hooks analysis.
 */
import { findRepoSymbols, getIndexSummary, streamRepoSymbols } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import { REACT_STDLIB_HOOKS } from "./react-shared-tools.js";

// ─────────────────────────────────────────────────────────────
// analyze_hooks
// ─────────────────────────────────────────────────────────────

export interface HookCall {
  name: string;
  line: number;          // line within the symbol (1-based relative to symbol start)
  is_stdlib: boolean;    // true if in REACT_STDLIB_HOOKS
  context: string;       // the matching line, trimmed
}

export interface HookInventoryEntry {
  name: string;           // component or hook name
  kind: "component" | "hook";
  file: string;
  start_line: number;
  hook_count: number;
  hooks: HookCall[];      // up to 20 hook calls
  violations: string[];   // rule-of-hooks violations found
}

export interface HookUsageSummary {
  name: string;           // hook name (e.g. "useState")
  count: number;
  is_stdlib: boolean;
}

export interface AnalyzeHooksResult {
  entries: HookInventoryEntry[];
  total_components: number;
  total_custom_hooks: number;
  hook_usage: HookUsageSummary[]; // top 20 hooks used across codebase
  violations_count: number;
}

/**
 * Scan a component/hook source for Rule of Hooks violations.
 * Detects: hook inside if/for/while/switch, hook after early return.
 * Returns a list of human-readable violation descriptions.
 */
function findRuleOfHooksViolations(source: string): string[] {
  const violations: string[] = [];

  // Heuristic: hook call inside if/for/while/switch block
  const conditionalHook = /\b(if|for|while|switch)\s*\([^)]*\)\s*\{[^}]*\b(use[A-Z]\w*)\s*\(/;
  const condMatch = conditionalHook.exec(source);
  if (condMatch) {
    violations.push(
      `Hook "${condMatch[2]}" called inside ${condMatch[1]} block — violates Rule of Hooks`,
    );
  }

  // Heuristic: hook after early return
  const earlyReturnHook = /\breturn\s+[^;{]*;\s*\n[\s\S]*?\b(use[A-Z]\w*)\s*\(/;
  const earlyMatch = earlyReturnHook.exec(source);
  if (earlyMatch) {
    violations.push(
      `Hook "${earlyMatch[1]}" called after early return — violates Rule of Hooks`,
    );
  }

  return violations;
}

/**
 * Extract unique hook names from source (no line numbers, no cap).
 * Use when you only need the set of hooks — e.g. React context bundle.
 */
function extractHookNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /\b(use[A-Z]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    names.add(m[1]!);
  }
  return names;
}

/**
 * Extract hook calls from source with their relative line number.
 */
function extractHookCalls(source: string): HookCall[] {
  const calls: HookCall[] = [];
  const lines = source.split("\n");
  const pattern = /\b(use[A-Z]\w*)\s*\(/;

  for (let i = 0; i < lines.length && calls.length < 20; i++) {
    const line = lines[i]!;
    const m = pattern.exec(line);
    if (m) {
      calls.push({
        name: m[1]!,
        line: i + 1,
        is_stdlib: REACT_STDLIB_HOOKS.has(m[1]!),
        context: line.trim().slice(0, 160),
      });
    }
  }

  return calls;
}

/**
 * Analyze hook usage across components and custom hooks in a repo.
 *
 * Returns:
 * - per-symbol inventory (hooks called, violations)
 * - codebase-wide hook usage summary
 * - Rule of Hooks violation count
 */
export async function analyzeHooks(
  repo: string,
  options?: {
    component_name?: string | undefined;  // filter to a single component (or omit for all)
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
    max_entries?: number | undefined;
  },
): Promise<AnalyzeHooksResult> {
  const index = await getIndexSummary(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const componentName = options?.component_name;
  const filePattern = options?.file_pattern;
  const includeTests = options?.include_tests ?? false;
  const maxEntries = options?.max_entries ?? 100;

  // Components and hooks, in index order. Two kinds cannot be one `kind =` query, and merging two
  // queries would lose the interleaving the `maxEntries` cut-off depends on — so the scan is a
  // stream (paged, never all resident) narrowed to one name when a component is named. Source is
  // requested: every check below parses it (ADR-004 stage 2).
  const wanted = (s: CodeSymbol): boolean =>
    (s.kind === "component" || s.kind === "hook")
    && (includeTests || !isTestFile(s.file))
    && (!componentName || s.name === componentName)
    && (!filePattern || s.file.includes(filePattern));

  const entries: HookInventoryEntry[] = [];
  const globalHookCount = new Map<string, number>();
  let totalComponents = 0;
  let totalHooks = 0;
  let violationsCount = 0;

  /** Returns false once `maxEntries` is reached — the same point the full-array loop broke at. */
  const visit = (sym: CodeSymbol): boolean => {
    if (!wanted(sym)) return true;
    if (!sym.source) return true;

    const hookCalls = extractHookCalls(sym.source);
    const violations = findRuleOfHooksViolations(sym.source);

    if (sym.kind === "component") totalComponents++;
    else if (sym.kind === "hook") totalHooks++;

    // Skip empty entries (no hooks, no violations)
    if (hookCalls.length === 0 && violations.length === 0) return true;

    violationsCount += violations.length;

    for (const call of hookCalls) {
      globalHookCount.set(call.name, (globalHookCount.get(call.name) ?? 0) + 1);
    }

    entries.push({
      name: sym.name,
      kind: sym.kind as "component" | "hook",
      file: sym.file,
      start_line: sym.start_line,
      hook_count: hookCalls.length,
      hooks: hookCalls,
      violations,
    });

    return entries.length < maxEntries;
  };

  const foldBatch = (batch: CodeSymbol[]): boolean | undefined => {
    for (const sym of batch) if (!visit(sym)) return false;
    return undefined;
  };
  if (componentName) {
    foldBatch(await findRepoSymbols(repo, { withSource: true, name: componentName }, { skipFreshness: true }));
  } else {
    await streamRepoSymbols(repo, { withSource: true }, foldBatch, { skipFreshness: true });
  }

  // Sort entries: violations first, then by hook_count descending
  entries.sort((a, b) => {
    const vdiff = b.violations.length - a.violations.length;
    if (vdiff !== 0) return vdiff;
    return b.hook_count - a.hook_count;
  });

  const hook_usage: HookUsageSummary[] = [...globalHookCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({
      name,
      count,
      is_stdlib: REACT_STDLIB_HOOKS.has(name),
    }));

  return {
    entries,
    total_components: totalComponents,
    total_custom_hooks: totalHooks,
    hook_usage,
    violations_count: violationsCount,
  };
}

export { extractHookCalls, extractHookNames, findRuleOfHooksViolations };
