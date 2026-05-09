/**
 * Yii3 attribute conversion candidates (M2).
 *
 * Yii3 is natively PHP 8 attribute-based. The mechanical mapping from
 * Yii2 array-config idioms to Yii3 attributes is well-defined, but
 * applying it across thousands of files is the bottleneck for any
 * Yii2→Yii3 migration. This tool surfaces every site that's a candidate
 * for the conversion + a proposed attribute form, capped by sample limit
 * so the consumer can triage at their own pace.
 *
 * Conversions covered:
 *
 *   behaviors-to-attributes
 *     behaviors() returning an array with TimestampBehavior /
 *     BlameableBehavior / SluggableBehavior / etc → #[Behavior(class)] on
 *     the class. We surface the entire behaviors() body in `current_form`
 *     so the auditor sees the array-shape that needs conversion.
 *
 *   rules-to-attributes
 *     rules() returning array of [['field'], 'validator'] tuples →
 *     #[Required], #[Email], #[StringLength(min: 1)] on the property.
 *     Each tuple becomes one or more proposed attributes.
 *
 *   urlmanager-rule-to-route
 *     'GET api/users/<id>' => 'user/view' (in urlManager rules) →
 *     #[Route(method: 'GET', path: '/api/users/{id}')] on the controller
 *     action. We resolve the controller/action target from the rule's
 *     right side. {param} placeholders are emitted but type constraints
 *     are dropped (Yii2 supports inline regex like <id:\\d+>; Yii3 uses
 *     route attributes like #[Route('/{id<int>}')]).
 *
 * Output shape:
 *   - candidates[]    — flat list of all conversions
 *   - by_rule[]       — grouped + sample-capped, sorted by count desc
 *   - summary         — total + per-rule counts
 *
 * Like M1, this tool never auto-applies. Each candidate ships:
 *   current_form         (the source as written today)
 *   suggested_replacement (the attribute equivalent)
 *   confidence           ("high" | "medium" | "low")
 *   blockers[]           (string reasons the conversion may be unsafe —
 *                         e.g. "rule references a Closure validator that
 *                         can't be lifted to an attribute")
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Yii3AttributeRuleId =
  | "behaviors-to-attributes"
  | "rules-to-attributes"
  | "urlmanager-rule-to-route";

export interface Yii3AttributeCandidate {
  rule_id: Yii3AttributeRuleId;
  file: string;
  line: number;
  current_form: string;
  suggested_replacement: string;
  confidence: "high" | "medium" | "low";
  blockers: string[];
}

export interface Yii3AttributeCandidates {
  repo: string;
  scanned_files: number;
  total_candidates: number;
  by_rule: Array<{
    rule_id: Yii3AttributeRuleId;
    count: number;
    samples: Yii3AttributeCandidate[];
  }>;
  candidates: Yii3AttributeCandidate[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const VENDOR_RE = /(^|\/)(?:vendor|node_modules|runtime|tests\/_data)(\/|$)/;
const SAMPLE_LIMIT = 5;

interface IndexLike {
  root: string;
  files: Array<{ path: string }>;
  symbols: Array<{
    id?: string;
    name: string;
    kind: string;
    file: string;
    parent?: string | undefined;
    source?: string | undefined;
    start_line: number;
    end_line: number;
  }>;
}

export async function findYii3AttributeCandidates(
  repo: string,
  options?: {
    file_pattern?: string;
    rules?: Yii3AttributeRuleId[];
    max_samples_per_rule?: number;
    include_vendor?: boolean;
  },
): Promise<Yii3AttributeCandidates> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const sampleLimit = options?.max_samples_per_rule ?? SAMPLE_LIMIT;
  const includeVendor = options?.include_vendor ?? false;
  const filePattern = options?.file_pattern;
  const ruleFilter = options?.rules ? new Set(options.rules) : null;

  const phpFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (!includeVendor && VENDOR_RE.test(f.path)) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    return true;
  });

  const candidates: Yii3AttributeCandidate[] = [];

  // Symbol-level rules use the index directly.
  if (!ruleFilter || ruleFilter.has("behaviors-to-attributes")) {
    findBehaviorsToAttributes(index, candidates);
  }
  if (!ruleFilter || ruleFilter.has("rules-to-attributes")) {
    findRulesToAttributes(index, candidates);
  }
  // File-level rule (urlmanager-rule-to-route) reads config files directly.
  if (!ruleFilter || ruleFilter.has("urlmanager-rule-to-route")) {
    await Promise.all(
      phpFiles
        .filter((f) =>
          /config\/(?:web|main|api|backend|frontend|common)(?:[-_][\w-]+)?\.php$/.test(
            f.path,
          ),
        )
        .map(async (f) => {
          let content: string;
          try {
            content = await readFile(join(index.root, f.path), "utf-8");
          } catch {
            return;
          }
          findUrlManagerRules(content, f.path, candidates);
        }),
    );
  }

  // Group + cap.
  const byRuleMap = new Map<Yii3AttributeRuleId, Yii3AttributeCandidate[]>();
  for (const c of candidates) {
    if (!byRuleMap.has(c.rule_id)) byRuleMap.set(c.rule_id, []);
    byRuleMap.get(c.rule_id)!.push(c);
  }
  const byRule = [...byRuleMap.entries()]
    .map(([rule_id, list]) => ({
      rule_id,
      count: list.length,
      samples: list.slice(0, sampleLimit),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    repo,
    scanned_files: phpFiles.length,
    total_candidates: candidates.length,
    by_rule: byRule,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Rule: behaviors() → #[Behavior(...)]
// ---------------------------------------------------------------------------

function findBehaviorsToAttributes(
  index: IndexLike,
  out: Yii3AttributeCandidate[],
): void {
  const behaviorsMethods = index.symbols.filter(
    (s) =>
      s.kind === "method" &&
      s.name === "behaviors" &&
      s.file.endsWith(".php") &&
      s.source &&
      !VENDOR_RE.test(s.file),
  );

  for (const m of behaviorsMethods) {
    const src = m.source!;
    // Pull the body's `return [ ... ];` block. We don't try to walk
    // every key; instead we count the entries that look like behavior
    // class references and surface the whole body for the auditor.
    const returnMatch = /return\s*\[([\s\S]*?)\]\s*;/.exec(src);
    if (!returnMatch) continue;
    const body = returnMatch[1]!;

    // Detect behavior classes — anything ending in "Behavior".
    const behaviorRe = /([A-Z][\w]*Behavior)(?:::class|['"])/g;
    const found = new Set<string>();
    let bm: RegExpExecArray | null;
    while ((bm = behaviorRe.exec(body)) !== null) {
      found.add(bm[1]!);
    }
    if (found.size === 0) continue;

    const blockers: string[] = [];
    if (/=>\s*function\s*\(/.test(body)) {
      blockers.push("behavior config contains closure — review manually");
    }

    const list = [...found];
    out.push({
      rule_id: "behaviors-to-attributes",
      file: m.file,
      line: m.start_line,
      current_form: `behaviors() with ${list.length} entr${list.length === 1 ? "y" : "ies"}: ${list.join(", ")}`,
      suggested_replacement: list
        .map((b) => `#[Behavior(${b}::class)]`)
        .join(" "),
      confidence: blockers.length > 0 ? "medium" : "high",
      blockers,
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: rules() → #[Required], #[Email], etc.
// ---------------------------------------------------------------------------

const VALIDATOR_TO_ATTRIBUTE: Record<string, string> = {
  required: "Required",
  email: "Email",
  string: "StringLength",
  integer: "IntegerValue",
  number: "NumericValue",
  url: "Url",
  boolean: "BooleanValue",
  date: "Date",
  in: "InRange",
  match: "RegexMatch",
  unique: "Unique",
  exist: "Exist",
  default: "DefaultValue",
  filter: "Callback",
  safe: "Safe",
};

function findRulesToAttributes(
  index: IndexLike,
  out: Yii3AttributeCandidate[],
): void {
  const rulesMethods = index.symbols.filter(
    (s) =>
      s.kind === "method" &&
      s.name === "rules" &&
      s.file.endsWith(".php") &&
      s.source &&
      !VENDOR_RE.test(s.file),
  );

  for (const m of rulesMethods) {
    const src = m.source!;
    const returnMatch = /return\s*\[([\s\S]*?)\]\s*;/.exec(src);
    if (!returnMatch) continue;
    const body = returnMatch[1]!;

    // Each rule is a tuple [['field' | ['field1', ...]], 'validator', …].
    // We capture the first two positional arguments per tuple.
    const tupleRe =
      /\[\s*(?:\[([^\]]+)\]|['"]([\w-]+)['"])\s*,\s*['"]([\w-]+)['"]/g;
    const seen = new Map<string, Set<string>>();

    let tm: RegExpExecArray | null;
    while ((tm = tupleRe.exec(body)) !== null) {
      const fields = (tm[1] ?? tm[2] ?? "")
        .split(",")
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      const validator = tm[3]!;
      for (const f of fields) {
        if (!seen.has(f)) seen.set(f, new Set());
        seen.get(f)!.add(validator);
      }
    }
    if (seen.size === 0) continue;

    const blockers: string[] = [];
    if (/=>\s*function\s*\(/.test(body)) {
      blockers.push("rule references a closure validator — manual conversion");
    }

    for (const [field, validators] of seen.entries()) {
      const attrs: string[] = [];
      for (const v of validators) {
        const mapped = VALIDATOR_TO_ATTRIBUTE[v];
        if (mapped) attrs.push(`#[${mapped}]`);
        else attrs.push(`#[Validator('${v}')]`);
      }
      out.push({
        rule_id: "rules-to-attributes",
        file: m.file,
        line: m.start_line,
        current_form: `rules() entry for $${field}: ${[...validators].join(", ")}`,
        suggested_replacement: `${attrs.join(" ")} public mixed \$${field};`,
        confidence: validators.size === 1 && VALIDATOR_TO_ATTRIBUTE[[...validators][0]!] ? "high" : "medium",
        blockers: [...blockers],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule: urlManager rules → #[Route(...)]
// ---------------------------------------------------------------------------

function findUrlManagerRules(
  content: string,
  file: string,
  out: Yii3AttributeCandidate[],
): void {
  // Match `'GET api/users/<id>' => 'user/view'` style entries. Yii2
  // urlManager also accepts unverbed forms ('home' => 'site/index'); we
  // capture both. The right side is `controller/action[/sub]`.
  const ruleRe =
    /['"](?:(GET|POST|PUT|DELETE|PATCH)\s+)?([^'"]+)['"]\s*=>\s*['"]([\w\/-]+)['"]/g;

  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(content)) !== null) {
    const verb = m[1] ?? null;
    const pattern = m[2]!;
    const target = m[3]!;
    const line = countLines(content, m.index);

    // Skip non-route contexts: rules() entries, validation messages, etc.
    // Best heuristic: target must contain a "/" (controller/action shape).
    if (!target.includes("/")) continue;
    // Reject obvious false positives: 'class' => 'app\\X' (FQCN target).
    if (/\\/.test(target)) continue;

    // Convert <param> and <param:regex> placeholders to Yii3 {param}.
    // Regex constraints are dropped — Yii3 has its own attribute syntax.
    const path =
      "/" +
      pattern.replace(/<(\w+)(?::[^>]+)?>/g, "{$1}").replace(/^\//, "");

    const targetSegments = target.split("/");
    const action = targetSegments[targetSegments.length - 1]!;
    const controller = targetSegments.slice(0, -1).join("/");

    const blockers: string[] = [];
    if (/<\w+:/.test(pattern)) {
      blockers.push(
        "rule has inline regex constraint — re-encode with Yii3 typed route",
      );
    }
    if (target.split("/").length > 2) {
      blockers.push("rule targets a module — verify Yii3 module mapping");
    }

    const verbDecl = verb ? `method: '${verb}'` : "";
    const replacement = `#[Route(${[verbDecl, `path: '${path}'`].filter(Boolean).join(", ")})]\npublic function action${pascalize(action)}() { … }`;

    out.push({
      rule_id: "urlmanager-rule-to-route",
      file,
      line,
      current_form: `'${verb ? verb + " " : ""}${pattern}' => '${target}'`,
      suggested_replacement: `// On ${controller}Controller::action${pascalize(action)}:\n${replacement}`,
      confidence: blockers.length === 0 ? "high" : "medium",
      blockers,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pascalize(s: string): string {
  return s
    .split(/[-_]/)
    .map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : ""))
    .join("");
}

function countLines(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}
