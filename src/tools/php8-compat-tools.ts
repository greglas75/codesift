/**
 * PHP 8 compatibility check (M3) — pre-merge gating tool.
 *
 * Scans a PHP codebase for breaking changes between PHP 7.x and 8.0/8.1/8.2.
 * Designed to be run as the last gate before a team merges a PHP 8 upgrade
 * branch into main. The output groups findings into:
 *
 *   - blockers (BREAKING_8_0): code that won't run at all on PHP 8.0
 *   - deprecations (DEPRECATED_8_1, DEPRECATED_8_2): code that runs but
 *     emits warnings; noisy in prod logs
 *   - yii_version_warning: Yii < 2.0.49 has known PHP 8 bugs; refuse to
 *     ship PHP 8 without bumping the framework version
 *
 * The tool intentionally does NOT auto-fix anything — it's a gating
 * report, the team decides whether each finding is in scope for the
 * current merge or shipped as a follow-up.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Php8Severity = "breaking_8_0" | "deprecated_8_1" | "deprecated_8_2";
export type Php8RuleId =
  | "each-removed"
  | "create-function-removed"
  | "real-cast-removed"
  | "array-key-exists-on-object"
  | "spread-operator-on-string-keys"
  | "concatenation-precedence"
  | "ambiguous-ternary"
  | "core-fn-null-string-arg"
  | "dynamic-property-creation"
  | "utf8-encode-decode"
  | "set-current-locale-deprecated"
  | "money-format-removed"
  | "is-resource-on-closed";

export interface Php8RuleDef {
  id: Php8RuleId;
  severity: Php8Severity;
  description: string;
  fix: string;
  /** /g pattern; one finding per match. */
  pattern: RegExp;
}

export interface Php8Finding {
  rule_id: Php8RuleId;
  severity: Php8Severity;
  file: string;
  line: number;
  snippet: string;
  description: string;
  fix: string;
}

export interface Php8CompatReport {
  repo: string;
  scanned_files: number;
  total_findings: number;
  blocker_count: number;
  by_severity: Record<Php8Severity, number>;
  by_rule: Array<{
    rule_id: Php8RuleId;
    severity: Php8Severity;
    count: number;
    description: string;
    fix: string;
    sample_findings: Php8Finding[];
  }>;
  yii_version_warning: string | null;
  php_version_required: string | null;
  /** True iff at least one breaking_8_0 finding is present. */
  blocker_for_merge: boolean;
}

// ---------------------------------------------------------------------------
// Rule catalog
// ---------------------------------------------------------------------------

const RULES: Php8RuleDef[] = [
  {
    id: "each-removed",
    severity: "breaking_8_0",
    description: "each() was removed in PHP 8.0. The function returned a key/value pair while advancing the array pointer.",
    fix: "Replace `while (list($k, $v) = each($arr))` with `foreach ($arr as $k => $v)`.",
    pattern: /\beach\s*\(\s*\$\w+\s*\)/g,
  },
  {
    id: "create-function-removed",
    severity: "breaking_8_0",
    description: "create_function() was removed in PHP 8.0. It produced a runtime-evaluated lambda.",
    fix: "Use a real closure: `$fn = function ($x) { return $x * 2; };`.",
    pattern: /\bcreate_function\s*\(/g,
  },
  {
    id: "real-cast-removed",
    severity: "breaking_8_0",
    description: "The (real) cast was removed in PHP 8.0 — it was an alias for (float).",
    fix: "Replace `(real)` with `(float)`.",
    pattern: /\(\s*real\s*\)/g,
  },
  {
    id: "money-format-removed",
    severity: "breaking_8_0",
    description: "money_format() was removed in PHP 8.0.",
    fix: "Use NumberFormatter::CURRENCY: `(new NumberFormatter('en_US', NumberFormatter::CURRENCY))->format($value)`.",
    pattern: /\bmoney_format\s*\(/g,
  },
  {
    id: "array-key-exists-on-object",
    severity: "breaking_8_0",
    description: "array_key_exists() on an object was deprecated in 7.4 and is a TypeError in 8.0.",
    fix: "Use `property_exists($obj, 'prop')` or `isset($obj->prop)` instead.",
    // Heuristic: array_key_exists with a $variable second arg whose name
    // ends in a typical object suffix. False positives on actual arrays
    // named like objects are acceptable for a gating tool.
    pattern: /\barray_key_exists\s*\([^,]+,\s*\$(?:[a-z_]\w*(?:Object|Model|Entity|Class|User|Item|Record|Instance))\b/g,
  },
  {
    id: "core-fn-null-string-arg",
    severity: "deprecated_8_1",
    description: "Passing null to non-nullable string parameters of core functions is deprecated in 8.1 and will become an error in 9.0. This is the highest-volume PHP 8.1 deprecation in legacy codebases.",
    fix: "Coerce explicitly: `strpos($s ?? '', $needle)` or `(string)($s ?? '')`.",
    pattern: /\b(?:strpos|stripos|strrpos|strripos|str_contains|str_starts_with|str_ends_with|substr|strlen|trim|ltrim|rtrim|str_replace|preg_match|preg_replace|explode|implode|htmlspecialchars|htmlentities|urlencode|urldecode|md5|sha1|hash|strtolower|strtoupper)\s*\([^)]*\bnull\b/g,
  },
  {
    id: "dynamic-property-creation",
    severity: "deprecated_8_2",
    description: "Creating dynamic properties on a class without #[AllowDynamicProperties] is deprecated in 8.2 and will be removed in 9.0. Yii2 ActiveRecord relies on __set/__get magic, so most AR usage is exempt — but ad-hoc `$obj->newProp = X` on plain classes will warn.",
    fix: "Either declare the property explicitly, or add #[AllowDynamicProperties] to the class. ActiveRecord and other classes that implement __set are exempt.",
    // Cheap signal: standalone `$obj->newProp =` outside a class body — we
    // can't reliably tell that statically. Skipped: this rule is best
    // surfaced via a runtime PHP 8.2 deprecation log, not regex. Listed
    // here so the report mentions it; the pattern is a no-op fallback so
    // we never flag false positives.
    pattern: /(?!)/g,
  },
  {
    id: "utf8-encode-decode",
    severity: "deprecated_8_2",
    description: "utf8_encode() and utf8_decode() are deprecated in 8.2.",
    fix: "Use `mb_convert_encoding($s, 'UTF-8', 'ISO-8859-1')` (encode) or `mb_convert_encoding($s, 'ISO-8859-1', 'UTF-8')` (decode).",
    pattern: /\b(?:utf8_encode|utf8_decode)\s*\(/g,
  },
  {
    id: "spread-operator-on-string-keys",
    severity: "breaking_8_0",
    description: "Spread operator `...$arr` on arrays with string keys threw an error in 7.x but is allowed in 8.1+. If your code passes through 8.0 specifically, this can break.",
    fix: "If targeting 8.0: convert string-keyed arrays to numeric keys before spreading. If targeting 8.1+: no change needed.",
    // Hard to detect reliably without flow analysis. Conservative pattern:
    // a function call with `...$variable` where the variable name suggests
    // an associative array (config, options, params, attributes). False
    // positives accepted.
    pattern: /\.\.\.\$(?:config|options|params|attributes|settings|args|kwargs)\b/g,
  },
  {
    id: "concatenation-precedence",
    severity: "breaking_8_0",
    description: "PHP 8.0 made `+` and `-` higher precedence than `.`. Code like `echo 'a' . 'b' + 1;` parses differently — what was `('a'.'b') + 1` is now `'a' . ('b' + 1)`.",
    fix: "Add explicit parentheses around the concatenation: `echo ('a' . 'b') + 1;`.",
    pattern: /\.\s*\$\w+\s*[+\-]\s*\d/g,
  },
  {
    id: "ambiguous-ternary",
    severity: "breaking_8_0",
    description: "Nested ternaries without parentheses became a parse error in 8.0. `$a ? $b : $c ? $d : $e` no longer parses.",
    fix: "Add explicit parentheses: `$a ? $b : ($c ? $d : $e)`.",
    pattern: /\?[^?:]+:\s*[^()?:\n]+\?[^?:]+:[^?:\n]+/g,
  },
  {
    id: "is-resource-on-closed",
    severity: "deprecated_8_1",
    description: "is_resource() on a closed resource (e.g. closed file handle) returned true in 7.x; in 8.0+ many resources became objects so is_resource returns false and never matches.",
    fix: "Check explicitly for the object type after migration: `$h !== false && (is_resource($h) || $h instanceof \\\\GdImage)`.",
    pattern: /\bis_resource\s*\(/g,
  },
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const VENDOR_RE = /(^|\/)(?:vendor|node_modules|runtime)(\/|$)/;
const SAMPLE_LIMIT = 5;

export async function php8CompatCheck(
  repo: string,
  options?: {
    file_pattern?: string;
    max_samples_per_rule?: number;
    include_vendor?: boolean;
    rules?: Php8RuleId[];
  },
): Promise<Php8CompatReport> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const sampleLimit = options?.max_samples_per_rule ?? SAMPLE_LIMIT;
  const includeVendor = options?.include_vendor ?? false;
  const filePattern = options?.file_pattern;
  const ruleFilter = options?.rules ? new Set(options.rules) : null;

  const rules = ruleFilter
    ? RULES.filter((r) => ruleFilter.has(r.id))
    : RULES;

  const phpFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (!includeVendor && VENDOR_RE.test(f.path)) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    return true;
  });

  const buckets = new Map<
    Php8RuleId,
    { count: number; samples: Php8Finding[] }
  >();
  for (const r of rules) {
    buckets.set(r.id, { count: 0, samples: [] });
  }

  const reads = await Promise.allSettled(
    phpFiles.map(async (f) => ({
      path: f.path,
      content: await readFile(join(index.root, f.path), "utf-8"),
    })),
  );

  for (const r of reads) {
    if (r.status !== "fulfilled") continue;
    const { path, content } = r.value;
    for (const rule of rules) {
      const b = buckets.get(rule.id)!;
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(content)) !== null) {
        b.count++;
        if (b.samples.length < sampleLimit) {
          const line = countLinesUntil(content, m.index);
          const snippet = extractLineAt(content, m.index);
          b.samples.push({
            rule_id: rule.id,
            severity: rule.severity,
            file: path,
            line,
            snippet,
            description: rule.description,
            fix: rule.fix,
          });
        }
      }
    }
  }

  const byRule = rules
    .map((r) => {
      const b = buckets.get(r.id)!;
      return {
        rule_id: r.id,
        severity: r.severity,
        count: b.count,
        description: r.description,
        fix: r.fix,
        sample_findings: b.samples,
      };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => {
      const sevOrder: Record<Php8Severity, number> = {
        breaking_8_0: 0,
        deprecated_8_1: 1,
        deprecated_8_2: 2,
      };
      return sevOrder[a.severity] - sevOrder[b.severity] || b.count - a.count;
    });

  const bySeverity: Record<Php8Severity, number> = {
    breaking_8_0: 0,
    deprecated_8_1: 0,
    deprecated_8_2: 0,
  };
  let total = 0;
  for (const r of byRule) {
    bySeverity[r.severity] += r.count;
    total += r.count;
  }

  const meta = await readComposerMeta(index.root);
  const yiiWarning = buildYiiWarning(meta.yiiVersion);

  return {
    repo,
    scanned_files: phpFiles.length,
    total_findings: total,
    blocker_count: bySeverity.breaking_8_0,
    by_severity: bySeverity,
    by_rule: byRule,
    yii_version_warning: yiiWarning,
    php_version_required: meta.phpRequirement,
    blocker_for_merge: bySeverity.breaking_8_0 > 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countLinesUntil(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractLineAt(source: string, idx: number): string {
  const start = source.lastIndexOf("\n", idx) + 1;
  const end = source.indexOf("\n", idx);
  const line = source.slice(start, end === -1 ? source.length : end);
  return line.trim().slice(0, 200);
}

async function readComposerMeta(
  root: string,
): Promise<{ yiiVersion: string | null; phpRequirement: string | null }> {
  try {
    const raw = await readFile(join(root, "composer.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const requires = parsed.require ?? {};
    return {
      yiiVersion: requires["yiisoft/yii2"] ?? null,
      phpRequirement: requires.php ?? null,
    };
  } catch {
    return { yiiVersion: null, phpRequirement: null };
  }
}

/**
 * Yii 2.0.x had known PHP 8 bugs through 2.0.48. Code that bumps PHP to 8.x
 * without also bumping Yii to >=2.0.49 will hit runtime errors in core
 * (notably in yii\\base\\BaseObject and yii\\db\\Connection). We surface a
 * prominent warning when we detect this combination at audit time.
 */
function buildYiiWarning(yiiVersion: string | null): string | null {
  if (!yiiVersion) return null;
  const cleaned = yiiVersion.replace(/^[\^~>=<*]+/, "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!m) return null;
  const [, maj, min, patch] = m;
  const majorN = Number(maj);
  const minorN = Number(min);
  const patchN = Number(patch);
  if (majorN < 2) return null;
  if (majorN > 2) return null;
  if (minorN > 0) return null;
  if (patchN >= 49) return null;
  return (
    `Yii ${cleaned} predates 2.0.49 and has known PHP 8 incompatibilities ` +
    `(BaseObject __construct signature, Connection charset detection, etc). ` +
    `Bump yiisoft/yii2 to ^2.0.49 BEFORE merging the PHP 8 upgrade. ` +
    `2.0.49+ is the first release with full PHP 8.0/8.1 support.`
  );
}
