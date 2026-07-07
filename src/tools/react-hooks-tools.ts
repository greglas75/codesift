/**
 * React hook inventory and Rule of Hooks analysis.
 */
import { getCodeIndex } from "./index-tools.js";
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
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const componentName = options?.component_name;
  const filePattern = options?.file_pattern;
  const includeTests = options?.include_tests ?? false;
  const maxEntries = options?.max_entries ?? 100;

  // Filter symbols to components and hooks
  let symbols = index.symbols.filter(
    (s) => s.kind === "component" || s.kind === "hook",
  );
  if (!includeTests) symbols = symbols.filter((s) => !isTestFile(s.file));
  if (componentName) symbols = symbols.filter((s) => s.name === componentName);
  if (filePattern) symbols = symbols.filter((s) => s.file.includes(filePattern));

  const entries: HookInventoryEntry[] = [];
  const globalHookCount = new Map<string, number>();
  let totalComponents = 0;
  let totalHooks = 0;
  let violationsCount = 0;

  for (const sym of symbols) {
    if (!sym.source) continue;

    const hookCalls = extractHookCalls(sym.source);
    const violations = findRuleOfHooksViolations(sym.source);

    if (sym.kind === "component") totalComponents++;
    else if (sym.kind === "hook") totalHooks++;

    // Skip empty entries (no hooks, no violations)
    if (hookCalls.length === 0 && violations.length === 0) continue;

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

    if (entries.length >= maxEntries) break;
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
