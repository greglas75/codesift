/**
 * PHP 8 modernization candidate finder (M1).
 *
 * Companion to M3 (php8_compat_check). Where M3 is the gating tool — "will
 * this PHP 8 merge break anything" — M1 is the post-merge modernization
 * tool. After PHP 8 lands, run M1 to surface places where the legacy
 * 7.2-style idiom can be tightened up using new language features.
 *
 * Sub-checks (each is a regex pattern over file content):
 *
 *   promotable-ctor           ctor with N parameters whose body only does
 *                             $this->x = $x assignments — collapse to
 *                             promoted constructor (PHP 8.0+).
 *   docblock-to-typed-property /** @var T *\/ above an untyped public/private
 *                             property — convert to inline `public T $x`
 *                             (PHP 7.4+).
 *   nullable-flag-to-syntax   /** @var T|null *\/ — same conversion but
 *                             produces `public ?T $x`.
 *   readonly-candidate        property only assigned in __construct — add
 *                             `readonly` modifier (PHP 8.1+).
 *   enum-from-class-consts    class with N const NAME = 'value' entries +
 *                             a getValues()/getOptions() method — convert
 *                             to a backed enum (PHP 8.1+).
 *   match-from-switch         switch ($x) { case A: return ...; ...}
 *                             without fall-through — convert to match.
 *
 * Each finding includes:
 *   - file, line, snippet
 *   - rule_id, severity (always "modernize" — informational, never blocking)
 *   - suggested_replacement: rough sketch of the new form (string, NOT
 *     auto-applied)
 *   - confidence: "high" | "medium" | "low"
 *
 * The tool is intentionally lossy: many candidates will be rejected after
 * human review (e.g., a property "only assigned in ctor" might still be
 * mutated via reflection for testing). The point is to triage thousands
 * of files into a small reviewable list, not to auto-fix.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Php8MigrationRuleId =
  | "promotable-ctor"
  | "docblock-to-typed-property"
  | "nullable-flag-to-syntax"
  | "readonly-candidate"
  | "enum-from-class-consts"
  | "match-from-switch";

export type Confidence = "high" | "medium" | "low";

export interface Php8Candidate {
  rule_id: Php8MigrationRuleId;
  file: string;
  line: number;
  snippet: string;
  description: string;
  suggested_replacement: string;
  confidence: Confidence;
}

export interface Php8MigrationCandidates {
  repo: string;
  scanned_files: number;
  total_candidates: number;
  by_rule: Array<{
    rule_id: Php8MigrationRuleId;
    count: number;
    description: string;
    samples: Php8Candidate[];
  }>;
  candidates: Php8Candidate[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const VENDOR_RE = /(^|\/)(?:vendor|node_modules|runtime|tests\/_data)(\/|$)/;
const SAMPLE_LIMIT_PER_RULE = 5;

interface IndexLike {
  root: string;
  files: Array<{ path: string }>;
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    parent?: string | undefined;
    source?: string | undefined;
    start_line: number;
    end_line: number;
    meta?: Record<string, unknown> | undefined;
  }>;
}

export async function findPhp8MigrationCandidates(
  repo: string,
  options?: {
    file_pattern?: string;
    rules?: Php8MigrationRuleId[];
    max_samples_per_rule?: number;
    include_vendor?: boolean;
  },
): Promise<Php8MigrationCandidates> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const sampleLimit = options?.max_samples_per_rule ?? SAMPLE_LIMIT_PER_RULE;
  const includeVendor = options?.include_vendor ?? false;
  const filePattern = options?.file_pattern;
  const ruleFilter = options?.rules ? new Set(options.rules) : null;

  const phpFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (!includeVendor && VENDOR_RE.test(f.path)) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    return true;
  });

  const candidates: Php8Candidate[] = [];

  // Symbol-level rules use the index directly (faster, no second file read).
  if (!ruleFilter || ruleFilter.has("docblock-to-typed-property")) {
    findDocblockToTypedProperty(index, candidates);
  }
  if (!ruleFilter || ruleFilter.has("nullable-flag-to-syntax")) {
    findNullableFlagToSyntax(index, candidates);
  }
  if (!ruleFilter || ruleFilter.has("readonly-candidate")) {
    findReadonlyCandidates(index, candidates);
  }
  if (!ruleFilter || ruleFilter.has("enum-from-class-consts")) {
    findEnumFromClassConsts(index, candidates);
  }
  if (!ruleFilter || ruleFilter.has("promotable-ctor")) {
    findPromotableCtor(index, candidates);
  }

  // File-level rule (match-from-switch) needs the raw source — switch/match
  // can span across functions, so a per-symbol scan would miss cross-method
  // patterns. Scoped to the file set we already filtered.
  if (!ruleFilter || ruleFilter.has("match-from-switch")) {
    await Promise.all(
      phpFiles.map(async (f) => {
        let content: string;
        try {
          content = await readFile(join(index.root, f.path), "utf-8");
        } catch {
          return;
        }
        findMatchFromSwitch(content, f.path, candidates);
      }),
    );
  }

  // Group by rule with sample cap.
  const byRuleMap = new Map<Php8MigrationRuleId, Php8Candidate[]>();
  for (const c of candidates) {
    if (!byRuleMap.has(c.rule_id)) byRuleMap.set(c.rule_id, []);
    byRuleMap.get(c.rule_id)!.push(c);
  }
  const byRule = [...byRuleMap.entries()].map(([rule_id, list]) => ({
    rule_id,
    count: list.length,
    description: RULE_DESCRIPTIONS[rule_id],
    samples: list.slice(0, sampleLimit),
  }));
  byRule.sort((a, b) => b.count - a.count);

  return {
    repo,
    scanned_files: phpFiles.length,
    total_candidates: candidates.length,
    by_rule: byRule,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Rule descriptions (used in output for clarity)
// ---------------------------------------------------------------------------

const RULE_DESCRIPTIONS: Record<Php8MigrationRuleId, string> = {
  "promotable-ctor":
    "__construct that only assigns parameters to same-named properties — collapse to PHP 8.0 promoted constructor.",
  "docblock-to-typed-property":
    "/** @var T */ above an untyped property — convert to PHP 7.4 inline typed property `public T $x;`.",
  "nullable-flag-to-syntax":
    "/** @var T|null */ above a property — convert to PHP 7.4 nullable typed property `public ?T $x;`.",
  "readonly-candidate":
    "Property only assigned in __construct, no setter, no unset — add `readonly` modifier (PHP 8.1+).",
  "enum-from-class-consts":
    "Pre-enum idiom: class of `const FOO = 'foo'` literals + getValues()/getOptions() — convert to PHP 8.1 backed enum.",
  "match-from-switch":
    "switch with no fall-through where every case returns a value — convert to PHP 8.0 match expression.",
};

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * docblock-to-typed-property: inline type would replace @var. Uses the v2.0.0
 * extractor's `meta.type_source: "phpdoc"` flag — that's exactly the cohort
 * we want (property has type info in the docblock but not inline).
 */
function findDocblockToTypedProperty(
  index: IndexLike,
  out: Php8Candidate[],
): void {
  for (const sym of index.symbols) {
    if (sym.kind !== "field") continue;
    if (!sym.file.endsWith(".php")) continue;
    if (sym.meta?.from_constructor) continue; // skip promoted-ctor synth fields
    const ts = sym.meta?.type_source;
    if (ts !== "phpdoc") continue;
    const t = sym.meta?.type as string | undefined;
    if (!t) continue;

    // Skip rule 2 patterns (nullable union) — they belong to nullable-flag-to-syntax
    if (/\|null\b|\bnull\|/.test(t)) continue;

    const visibility =
      (sym.meta?.visibility as string | undefined) ?? "public";
    const propName = sym.name.replace(/^\$/, "");
    out.push({
      rule_id: "docblock-to-typed-property",
      file: sym.file,
      line: sym.start_line,
      snippet: `/** @var ${t} */ ${visibility} ${sym.name}`,
      description: RULE_DESCRIPTIONS["docblock-to-typed-property"],
      suggested_replacement: `${visibility} ${normalizeDocblockType(t)} \$${propName};`,
      confidence: rateTypeConfidence(t),
    });
  }
}

/**
 * nullable-flag-to-syntax: `@var T|null` → `?T`. Carved out from
 * docblock-to-typed-property so callers can decide they want only the
 * nullable conversion (which is the safer of the two — it never loses
 * information).
 */
function findNullableFlagToSyntax(
  index: IndexLike,
  out: Php8Candidate[],
): void {
  for (const sym of index.symbols) {
    if (sym.kind !== "field") continue;
    if (!sym.file.endsWith(".php")) continue;
    if (sym.meta?.from_constructor) continue;
    if (sym.meta?.type_source !== "phpdoc") continue;
    const t = sym.meta?.type as string | undefined;
    if (!t) continue;
    if (!/\|null\b|\bnull\|/.test(t)) continue;

    const baseType = t.replace(/\|null$|^null\|/, "");
    if (!baseType || baseType.includes("|")) continue; // Multi-type union — not a simple ?T

    const visibility =
      (sym.meta?.visibility as string | undefined) ?? "public";
    const propName = sym.name.replace(/^\$/, "");
    out.push({
      rule_id: "nullable-flag-to-syntax",
      file: sym.file,
      line: sym.start_line,
      snippet: `/** @var ${t} */ ${visibility} ${sym.name}`,
      description: RULE_DESCRIPTIONS["nullable-flag-to-syntax"],
      suggested_replacement: `${visibility} ?${normalizeDocblockType(baseType)} \$${propName};`,
      confidence: rateTypeConfidence(baseType),
    });
  }
}

/**
 * readonly-candidate: property assigned only in __construct. We approximate
 * by walking the parent class's source for `$this->propName = ` patterns
 * and checking that all of them appear inside the __construct body (or
 * inside a method we know is the ctor). Conservative — false positives
 * acceptable for a discovery tool.
 */
function findReadonlyCandidates(
  index: IndexLike,
  out: Php8Candidate[],
): void {
  // Group fields by parent class id so we can scan each class once.
  const fieldsByClass = new Map<string, typeof index.symbols>();
  for (const sym of index.symbols) {
    if (sym.kind !== "field") continue;
    if (!sym.parent) continue;
    if (sym.meta?.is_readonly) continue; // already readonly
    if (sym.meta?.is_static) continue;
    if (!fieldsByClass.has(sym.parent)) fieldsByClass.set(sym.parent, []);
    fieldsByClass.get(sym.parent)!.push(sym);
  }

  for (const [classId, fields] of fieldsByClass.entries()) {
    const cls = index.symbols.find((s) => (s as { id?: string }).id === classId);
    if (!cls || !cls.source) continue;

    // Find the constructor method by name (could be __construct).
    const ctor = index.symbols.find(
      (s) =>
        s.parent === classId && s.kind === "method" && s.name === "__construct",
    );
    const ctorSource = ctor?.source ?? "";

    for (const f of fields) {
      const propName = f.name.replace(/^\$/, "");
      // All assignment sites for $this->propName in the class body.
      const assignRe = new RegExp(
        `\\$this->${escapeRegex(propName)}\\s*=`,
        "g",
      );
      const allAssigns = (cls.source.match(assignRe) ?? []).length;
      if (allAssigns === 0) continue;
      // How many of those assignments are inside the ctor body?
      const ctorAssigns = (ctorSource.match(assignRe) ?? []).length;
      if (ctorAssigns !== allAssigns) continue;

      // Skip if there is an explicit setter that mutates this property.
      const setterRe = new RegExp(
        `function\\s+set${propName.charAt(0).toUpperCase()}${propName.slice(1)}\\s*\\(`,
        "i",
      );
      if (setterRe.test(cls.source)) continue;

      const visibility =
        (f.meta?.visibility as string | undefined) ?? "public";
      const inlineType = (f.meta?.type as string | undefined) ?? "mixed";
      out.push({
        rule_id: "readonly-candidate",
        file: f.file,
        line: f.start_line,
        snippet: `${visibility} ${inlineType} \$${propName}`,
        description: RULE_DESCRIPTIONS["readonly-candidate"],
        suggested_replacement: `${visibility} readonly ${inlineType} \$${propName};`,
        confidence: f.meta?.type_source === "inline" ? "high" : "medium",
      });
    }
  }
}

/**
 * enum-from-class-consts: classes that look like a pre-enum bag-of-constants.
 * Heuristic: a class with >=3 `constant` symbols whose values are all
 * string literals AND a static method named getValues / getOptions /
 * getList / cases (which devs commonly add to enumerate the constants).
 */
function findEnumFromClassConsts(
  index: IndexLike,
  out: Php8Candidate[],
): void {
  const constsByClass = new Map<string, typeof index.symbols>();
  for (const sym of index.symbols) {
    if (sym.kind !== "constant") continue;
    if (!sym.parent) continue;
    if (!sym.file.endsWith(".php")) continue;
    if (!constsByClass.has(sym.parent)) constsByClass.set(sym.parent, []);
    constsByClass.get(sym.parent)!.push(sym);
  }

  const ENUM_HELPER_NAMES = new Set([
    "getValues",
    "getOptions",
    "getList",
    "all",
    "labels",
    "names",
    "values",
  ]);

  for (const [classId, consts] of constsByClass.entries()) {
    if (consts.length < 3) continue;
    const cls = index.symbols.find((s) => (s as { id?: string }).id === classId);
    if (!cls || cls.kind !== "class") continue;

    // All constants must have string-literal values for this to be a true
    // pre-enum. Mixed types or method calls are a sign of a config class.
    let allStrings = true;
    for (const c of consts) {
      if (!c.source) { allStrings = false; break; }
      // const_element source is just `NAME = 'value'` (no `const` keyword,
      // no trailing `;` — those belong to the enclosing const_declaration).
      // Match a string literal anywhere after the `=`.
      if (!/=\s*['"][^'"]*['"]/.test(c.source)) {
        allStrings = false;
        break;
      }
    }
    if (!allStrings) continue;

    // At least one helper method name must be present (or class name ends
    // in "Enum" / "Status" / "Type" — common pre-enum suffixes).
    const helperPresent = index.symbols.some(
      (s) =>
        s.parent === classId &&
        s.kind === "method" &&
        ENUM_HELPER_NAMES.has(s.name),
    );
    const naming = /(?:Enum|Status|Type|Kind|Code)$/.test(cls.name);
    if (!helperPresent && !naming) continue;

    out.push({
      rule_id: "enum-from-class-consts",
      file: cls.file,
      line: cls.start_line,
      snippet: `class ${cls.name} { ${consts.length} consts }`,
      description: RULE_DESCRIPTIONS["enum-from-class-consts"],
      suggested_replacement: `enum ${cls.name}: string { case Foo = 'foo'; /* … convert each const */ }`,
      confidence: helperPresent ? "high" : "medium",
    });
  }
}

/**
 * promotable-ctor: __construct(T $x, U $y) { $this->x = $x; $this->y = $y; }
 * is mechanically promotable to __construct(public T $x, public U $y) {}.
 *
 * Heuristic: extract the constructor body, count assignment statements,
 * count formal parameters. If every parameter $X has exactly one matching
 * `$this->X = $X;` in the body and there are no other statements (modulo
 * whitespace), the constructor is promotable.
 */
function findPromotableCtor(index: IndexLike, out: Php8Candidate[]): void {
  for (const sym of index.symbols) {
    if (sym.kind !== "method" || sym.name !== "__construct") continue;
    if (!sym.source) continue;

    // Skip if already using promoted ctor (visibility on parameters).
    if (/\b(?:public|private|protected)\s+(?:readonly\s+)?[\w\\?|&]+\s+\$\w+/.test(sym.source)) {
      // This is a heuristic — promoted params have visibility BEFORE the
      // type. Already-promoted ctors have nothing to modernize.
      continue;
    }

    // Pull formal parameter names from the signature
    const sigMatch = /__construct\s*\(([^)]*)\)/.exec(sym.source);
    if (!sigMatch) continue;
    const sig = sigMatch[1]!;
    if (!sig.trim()) continue;
    const paramNames: string[] = [];
    for (const part of sig.split(",")) {
      const pm = /\$(\w+)/.exec(part);
      if (pm) paramNames.push(pm[1]!);
    }
    if (paramNames.length === 0) continue;

    // Pull body { … }
    const bodyStart = sym.source.indexOf("{");
    const bodyEnd = sym.source.lastIndexOf("}");
    if (bodyStart === -1 || bodyEnd <= bodyStart) continue;
    const body = sym.source.slice(bodyStart + 1, bodyEnd).trim();

    // Count $this->NAME = $NAME; statements with names matching params.
    let matched = 0;
    let extras = 0;
    const statements = body
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      const am = /^\$this->(\w+)\s*=\s*\$(\w+)$/.exec(stmt);
      if (am && am[1] === am[2] && paramNames.includes(am[1]!)) {
        matched++;
      } else if (stmt && !/^\/\/|^#/.test(stmt)) {
        extras++;
      }
    }
    if (matched !== paramNames.length || extras > 0) continue;

    out.push({
      rule_id: "promotable-ctor",
      file: sym.file,
      line: sym.start_line,
      snippet: sym.source.slice(0, Math.min(160, sym.source.length)).replace(/\s+/g, " "),
      description: RULE_DESCRIPTIONS["promotable-ctor"],
      suggested_replacement: `public function __construct(${paramNames
        .map((n) => `public \$${n}`)
        .join(", ")}) {}`,
      confidence: "high",
    });
  }
}

/**
 * match-from-switch: every case returns a value, no fall-through. Pattern
 * is regex-based — over-approximates by including switches that already
 * have break statements. The auditor reviews each finding.
 */
function findMatchFromSwitch(
  content: string,
  file: string,
  out: Php8Candidate[],
): void {
  // Bounded regex: switch with at least 2 case-return blocks and no
  // visible break / fall-through within a 2000-char window after the
  // switch keyword.
  const switchRe = /switch\s*\(\s*(\$\w+(?:->\w+)?|\w+\s*\([^)]*\))\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = switchRe.exec(content)) !== null) {
    const body = content.slice(m.index, m.index + 2000);
    // Each case must contain a return; no `break` between cases means
    // every branch terminates the switch.
    const caseReturns = (body.match(/case\s+[^:]+:\s*[^\n]*return/g) ?? []).length;
    const breaks = (body.match(/\bbreak\s*;/g) ?? []).length;
    if (caseReturns >= 2 && breaks === 0) {
      out.push({
        rule_id: "match-from-switch",
        file,
        line: countLines(content, m.index),
        snippet: extractLine(content, m.index),
        description: RULE_DESCRIPTIONS["match-from-switch"],
        suggested_replacement: "return match($expr) { … };",
        confidence: caseReturns >= 4 ? "high" : "medium",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rateTypeConfidence(type: string): Confidence {
  // Plain primitives = high confidence; class types = medium (might need
  // alias resolution); union/intersection = low.
  if (/^(?:string|int|integer|float|bool|boolean|array|mixed|void|object|iterable|callable)$/i.test(type)) {
    return "high";
  }
  if (/[|&]/.test(type)) return "low";
  return "medium";
}

function normalizeDocblockType(type: string): string {
  // Map common docblock spellings to PHP keyword forms.
  const map: Record<string, string> = {
    integer: "int",
    boolean: "bool",
    double: "float",
  };
  return map[type.toLowerCase()] ?? type;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countLines(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractLine(source: string, idx: number): string {
  const start = source.lastIndexOf("\n", idx) + 1;
  const end = source.indexOf("\n", idx);
  const line = source.slice(start, end === -1 ? source.length : end);
  return line.trim().slice(0, 200);
}
