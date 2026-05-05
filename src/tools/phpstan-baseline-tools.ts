/**
 * PHPStan baseline analyzer (N6).
 *
 * Mature PHP codebases adopt PHPStan incrementally — they raise the level
 * to e.g. 6, generate a baseline file containing every existing error,
 * and treat the baseline as a debt ledger. The Yii2 panel in this gap
 * analysis (tgm-panel) ships an 18 011-line phpstan-baseline.neon — that's
 * roughly 1 800 ignored errors. The team knows the debt is there but has
 * no per-path triage data.
 *
 * This tool parses phpstan-baseline.neon and surfaces:
 *   - by_path:    files ranked by error count
 *   - by_category: error types (no-return-type, undefined-property,
 *                  iterable-no-value-type, ...) ranked by frequency
 *   - quick_wins: files with 1-3 errors — easy refactor targets
 *   - aggregate counts (total_ignored, by-severity if hints present)
 *
 * The tool is universal — works on any PHP repo with PHPStan, not only
 * Yii2. Auto-loads on composer.json detection.
 *
 * NEON parsing: NEON is a YAML superset with PHP-specific bracket forms.
 * Rather than pull in a NEON parser dependency we hand-roll a minimal
 * reader — the baseline format is mechanical (parameters: → ignoreErrors:
 * → array of {message, count, path}). Edge cases like nested includes are
 * out of scope; the tool would surface a file_unparseable note rather
 * than crash.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PhpStanBaselineEntry {
  message: string;
  count: number;
  path: string;
  /** Best-effort category derived from the message text. */
  category: string;
}

export interface PhpStanBaselineAudit {
  repo: string;
  baseline_file: string | null;
  /** Total ignored errors (sum of count fields). */
  total_ignored: number;
  /** Files containing at least one ignored error. */
  total_files: number;
  by_path: Array<{ path: string; count: number }>;
  by_category: Record<string, number>;
  /** Files with 1-3 ignored errors — quickest to clear. */
  quick_wins: Array<{ path: string; count: number; categories: string[] }>;
  /** Raw entries (full list, sorted by count descending). */
  entries: PhpStanBaselineEntry[];
  /** Diagnostic when the baseline couldn't be parsed cleanly. */
  parse_warnings: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const QUICK_WIN_THRESHOLD = 3;

export async function analyzePhpStanBaseline(
  repo: string,
  options?: { baseline_path?: string; max_paths?: number },
): Promise<PhpStanBaselineAudit> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const maxPaths = options?.max_paths ?? 50;
  const explicitPath = options?.baseline_path;

  // Locate the baseline file. Convention: phpstan-baseline.neon at the
  // repo root. Some projects nest it in config/; we try a small candidate
  // list before giving up.
  const candidates = explicitPath
    ? [explicitPath]
    : [
        "phpstan-baseline.neon",
        "config/phpstan-baseline.neon",
        ".phpstan-baseline.neon",
      ];

  let baselineFile: string | null = null;
  let content: string | null = null;
  for (const c of candidates) {
    try {
      content = await readFile(join(index.root, c), "utf-8");
      baselineFile = c;
      break;
    } catch {
      continue;
    }
  }

  if (!content || !baselineFile) {
    return {
      repo,
      baseline_file: null,
      total_ignored: 0,
      total_files: 0,
      by_path: [],
      by_category: {},
      quick_wins: [],
      entries: [],
      parse_warnings: [
        `No phpstan-baseline.neon found at ${candidates.join(", ")}`,
      ],
    };
  }

  const { entries, warnings } = parseNeonBaseline(content);

  // Aggregate.
  const byPathMap = new Map<string, number>();
  const categoryByPath = new Map<string, Set<string>>();
  const byCategory: Record<string, number> = {};

  for (const e of entries) {
    byPathMap.set(e.path, (byPathMap.get(e.path) ?? 0) + e.count);
    if (!categoryByPath.has(e.path)) categoryByPath.set(e.path, new Set());
    categoryByPath.get(e.path)!.add(e.category);
    byCategory[e.category] = (byCategory[e.category] ?? 0) + e.count;
  }

  const byPath = [...byPathMap.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxPaths);

  const quickWins = [...byPathMap.entries()]
    .filter(([, count]) => count <= QUICK_WIN_THRESHOLD)
    .map(([path, count]) => ({
      path,
      count,
      categories: [...(categoryByPath.get(path) ?? [])].sort(),
    }))
    .sort((a, b) => a.count - b.count);

  const totalIgnored = entries.reduce((sum, e) => sum + e.count, 0);

  return {
    repo,
    baseline_file: baselineFile,
    total_ignored: totalIgnored,
    total_files: byPathMap.size,
    by_path: byPath,
    by_category: byCategory,
    quick_wins: quickWins,
    entries: [...entries].sort((a, b) => b.count - a.count),
    parse_warnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// Minimal NEON parser
// ---------------------------------------------------------------------------

interface ParseResult {
  entries: PhpStanBaselineEntry[];
  warnings: string[];
}

/**
 * Parse a phpstan-baseline.neon file. The format we care about:
 *
 *   parameters:
 *     ignoreErrors:
 *       -
 *         message: "#regex#"
 *         count: 3
 *         path: relative/path.php
 *
 * NEON allows several syntactic alternatives (single-line vs block,
 * quoted vs unquoted, single-tick vs double-tick strings). We accept the
 * variants PHPStan itself emits. Anything outside `ignoreErrors` is
 * ignored. Includes (top-level `includes:` directive) are not followed —
 * the tool reports against the explicit baseline file only.
 */
function parseNeonBaseline(content: string): ParseResult {
  const warnings: string[] = [];
  const entries: PhpStanBaselineEntry[] = [];

  // Find the ignoreErrors block. Indentation varies between projects, so
  // we anchor on the keyword and walk forward.
  const headerRe = /^\s*ignoreErrors\s*:\s*$/m;
  const headerMatch = headerRe.exec(content);
  if (!headerMatch) {
    return {
      entries,
      warnings: ["No ignoreErrors block found in baseline"],
    };
  }
  const blockStart = headerMatch.index + headerMatch[0].length;

  // Each entry starts with `-` at the same indent. We split on
  // /^\s*-\s*$/m delimiters and parse each chunk.
  const tail = content.slice(blockStart);
  // Stop at next top-level key (not indented) — handles edge cases where
  // ignoreErrors isn't the last block.
  const stopRe = /^\S/m;
  const stopMatch = stopRe.exec(tail);
  const blockBody = stopMatch ? tail.slice(0, stopMatch.index) : tail;

  // Split on entry markers. NEON entries inside an ignoreErrors block
  // start with `-` followed by either a newline (multi-line entry) or
  // a space + inline { ... }.
  const entryRe = /^\s*-\s*(?:\n|\r\n)/gm;
  const parts: string[] = [];
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(blockBody)) !== null) {
    if (lastIdx >= 0) parts.push(blockBody.slice(lastIdx, m.index));
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx >= 0) parts.push(blockBody.slice(lastIdx));

  for (const part of parts) {
    const entry = parseEntryChunk(part);
    if (entry) entries.push(entry);
    else warnings.push(`Skipped unparseable entry near: ${part.slice(0, 80)}`);
  }

  return { entries, warnings };
}

function parseEntryChunk(chunk: string): PhpStanBaselineEntry | null {
  // message: extract text between the first quote pair after `message:`.
  const msgMatch = /message\s*:\s*(?:["']((?:[^"'\\]|\\.)*?)["']|(\S[^\n]*))/m.exec(chunk);
  if (!msgMatch) return null;
  const message = (msgMatch[1] ?? msgMatch[2] ?? "").trim();
  if (!message) return null;

  const countMatch = /count\s*:\s*(\d+)/m.exec(chunk);
  const count = countMatch ? Number(countMatch[1]) : 1;

  // path: unquoted is more common; accept quoted too.
  const pathMatch = /path\s*:\s*(?:["']([^"']+)["']|(\S[^\n]*))/m.exec(chunk);
  if (!pathMatch) return null;
  const path = (pathMatch[1] ?? pathMatch[2] ?? "").trim();
  if (!path) return null;

  return {
    message,
    count,
    path,
    category: classifyMessage(message),
  };
}

/**
 * Bucket a PHPStan error message into a coarse category. The default
 * categories cover ~95% of typical baseline content; uncategorized
 * messages fall into "other". Categories chosen to give actionable
 * triage signal: "no-return-type" is mechanical to fix, "undefined-property"
 * usually means a missing @property docblock, etc.
 */
function classifyMessage(message: string): string {
  const m = message;
  if (/has no return type/i.test(m)) return "no-return-type";
  if (/has parameter \S+ with no type/i.test(m)) return "no-parameter-type";
  if (/no value type specified in iterable/i.test(m)) return "iterable-no-value-type";
  if (/has no type specified/i.test(m)) return "no-type-specified";
  if (/Access to an undefined property/i.test(m)) return "undefined-property";
  if (/Access to an undefined static property/i.test(m)) return "undefined-static-property";
  if (/Call to an undefined method/i.test(m)) return "undefined-method";
  if (/Call to an undefined static method/i.test(m)) return "undefined-static-method";
  if (/Undefined variable/i.test(m)) return "undefined-variable";
  if (/might not be defined/i.test(m)) return "possibly-undefined-variable";
  if (/Strict comparison/i.test(m)) return "strict-comparison";
  if (/Loose comparison/i.test(m)) return "loose-comparison";
  if (/Cannot access/i.test(m)) return "cannot-access";
  if (/Method \S+ is unused|Property \S+ is unused/i.test(m)) return "unused-symbol";
  if (/Function \S+ is unused/i.test(m)) return "unused-function";
  if (/Unreachable statement/i.test(m)) return "unreachable-statement";
  if (/Dead catch/i.test(m)) return "dead-catch";
  if (/PHPDoc tag \S+ contains unresolvable/i.test(m)) return "phpdoc-unresolvable";
  if (/PHPDoc tag \S+ has invalid value/i.test(m)) return "phpdoc-invalid";
  if (/Generic type \S+ specifies/i.test(m)) return "generic-type-mismatch";
  if (/Parameter #\d+ \S+ of \S+ expects/i.test(m)) return "parameter-type-mismatch";
  if (/Cannot call method \S+ on/i.test(m)) return "method-on-null";
  if (/should return \S+ but returns/i.test(m)) return "return-type-mismatch";
  if (/instanceof.*always (?:true|false)/i.test(m)) return "always-true-false";
  if (/Comparison operation/i.test(m)) return "comparison-operation";
  if (/Result of \|\| is always|Result of && is always/i.test(m)) return "always-true-false";
  return "other";
}
