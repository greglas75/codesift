/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Provides 9 hidden/discoverable tools that augment generic code intelligence
 * with PHP framework awareness: PSR-4 namespace resolution, ActiveRecord schema
 * extraction, event/listener tracing, view mapping, service locator resolution,
 * security scanning, compound project audit (9-gate), N+1 query detection,
 * and god-model detection.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { searchPatterns } from "./pattern-tools.js";

// ---------------------------------------------------------------------------
// 7a. resolve_php_namespace — PSR-4 resolver
// ---------------------------------------------------------------------------

export interface PhpNamespaceResolution {
  class_name: string;
  namespace: string;
  file_path: string | null;
  exists: boolean;
  psr4_root: string | null;
  psr4_prefix: string | null;
}

export async function resolvePhpNamespace(
  repo: string,
  className: string,
): Promise<PhpNamespaceResolution> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const composer = await readJsonSafe(join(index.root, "composer.json"));
  const psr4: Record<string, string | string[]> = {
    ...(composer?.autoload?.["psr-4"] ?? {}),
    ...(composer?.["autoload-dev"]?.["psr-4"] ?? {}),
  };

  // Strip leading backslash
  const normalized = className.replace(/^\\/, "");
  const parts = normalized.split("\\");
  const namespaceOnly = parts.slice(0, -1).join("\\");
  const shortName = parts[parts.length - 1]!;

  // Find matching PSR-4 prefix (longest match wins)
  let bestPrefix: string | null = null;
  let bestRoot: string | null = null;
  for (const [prefix, roots] of Object.entries(psr4)) {
    const normalizedPrefix = prefix.replace(/\\$/, "");
    if (normalized.startsWith(normalizedPrefix + "\\") || normalized === normalizedPrefix) {
      if (!bestPrefix || normalizedPrefix.length > bestPrefix.length) {
        bestPrefix = normalizedPrefix;
        bestRoot = Array.isArray(roots) ? roots[0] ?? null : roots;
      }
    }
  }

  if (!bestPrefix || !bestRoot) {
    return {
      class_name: shortName,
      namespace: namespaceOnly,
      file_path: null,
      exists: false,
      psr4_root: null,
      psr4_prefix: null,
    };
  }

  // Construct file path: strip prefix, replace \ with /, append .php
  const remainder = normalized.slice(bestPrefix.length).replace(/^\\/, "");
  const relativePath = remainder.replace(/\\/g, "/") + ".php";
  const root = bestRoot.replace(/\/$/, "");
  const filePath = root + "/" + relativePath;

  // Check if file exists in index (strip leading ./ for comparison)
  const normalizedFP = filePath.replace(/^\.\//, "");
  const exists = index.files.some((f) => f.path === normalizedFP || f.path === filePath);

  return {
    class_name: shortName,
    namespace: namespaceOnly,
    file_path: filePath,
    exists,
    psr4_root: bestRoot,
    psr4_prefix: bestPrefix,
  };
}

// ---------------------------------------------------------------------------
// 7b. analyze_activerecord — Model schema
// ---------------------------------------------------------------------------

export interface ActiveRecordModel {
  name: string;
  file: string;
  table_name: string | null;
  relations: { name: string; type: "hasOne" | "hasMany" | "manyMany"; target_class: string }[];
  rules: string[];
  behaviors: string[];
  methods: string[];
}

export interface ActiveRecordAnalysis {
  models: ActiveRecordModel[];
  total: number;
}

export async function analyzeActiveRecord(
  repo: string,
  options?: { model_name?: string; file_pattern?: string },
): Promise<ActiveRecordAnalysis> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Find PHP class symbols in model files
  const classSymbols = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith(".php")) return false;
    if (options?.model_name && s.name !== options.model_name) return false;
    if (options?.file_pattern && !s.file.includes(options.file_pattern)) return false;
    return true;
  });

  const models: ActiveRecordModel[] = [];

  for (const cls of classSymbols) {
    // Heuristic: only models that have source containing ActiveRecord or extend Model
    if (!cls.source) continue;
    const extendsAR = /extends\s+(?:ActiveRecord|Model|\\yii\\db\\ActiveRecord)/.test(cls.source);
    if (!extendsAR) continue;

    const model: ActiveRecordModel = {
      name: cls.name,
      file: cls.file,
      table_name: null,
      relations: [],
      rules: [],
      behaviors: [],
      methods: [],
    };

    // Extract tableName() return value
    const tableMatch = /function\s+tableName\s*\([^)]*\)[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/s.exec(cls.source);
    if (tableMatch) model.table_name = tableMatch[1]!;

    // Find child method symbols
    const methods = index.symbols.filter(
      (s) => s.parent === cls.id && s.kind === "method",
    );
    model.methods = methods.map((m) => m.name);

    // Extract relations from getX() methods that return hasOne/hasMany
    for (const m of methods) {
      if (!m.name.startsWith("get") || !m.source) continue;
      const relName = m.name.slice(3);
      const relMatch = /->(hasOne|hasMany|hasMany\(\)->viaTable)\s*\(\s*([\w\\]+)(?:::class)?/.exec(m.source);
      if (relMatch) {
        const type = relMatch[1]!.startsWith("hasOne") ? "hasOne" : relMatch[1]!.includes("viaTable") ? "manyMany" : "hasMany";
        model.relations.push({
          name: relName.charAt(0).toLowerCase() + relName.slice(1),
          type,
          target_class: relMatch[2]!,
        });
      }
    }

    // Extract rule validators (loose regex on rules() method source)
    const rulesMethod = methods.find((m) => m.name === "rules");
    if (rulesMethod?.source) {
      const ruleMatches = rulesMethod.source.matchAll(/\[\s*\[?['"]?[\w,\s'"]+['"]?\]?\s*,\s*['"]([\w]+)['"]/g);
      for (const rm of ruleMatches) {
        if (rm[1] && !model.rules.includes(rm[1])) model.rules.push(rm[1]);
      }
    }

    // Extract behaviors from behaviors() method
    const behaviorsMethod = methods.find((m) => m.name === "behaviors");
    if (behaviorsMethod?.source) {
      const bMatches = behaviorsMethod.source.matchAll(/([A-Z]\w+Behavior)(?:::class)?/g);
      for (const bm of bMatches) {
        if (bm[1] && !model.behaviors.includes(bm[1])) model.behaviors.push(bm[1]);
      }
    }

    models.push(model);
  }

  return { models, total: models.length };
}

// ---------------------------------------------------------------------------
// 7c. trace_php_event — Event → Listener chain
// ---------------------------------------------------------------------------

export interface PhpEventChain {
  event_name: string;
  triggers: { file: string; line: number; context: string }[];
  listeners: { file: string; line: number; context: string }[];
}

export async function tracePhpEvent(
  repo: string,
  options?: { event_name?: string },
): Promise<{ events: PhpEventChain[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const eventMap = new Map<string, PhpEventChain>();

  const getOrCreate = (name: string): PhpEventChain => {
    let e = eventMap.get(name);
    if (!e) {
      e = { event_name: name, triggers: [], listeners: [] };
      eventMap.set(name, e);
    }
    return e;
  };

  // Scan PHP file symbols for event triggers and listeners
  const phpSymbols = index.symbols.filter((s) => s.file.endsWith(".php") && s.source);

  for (const sym of phpSymbols) {
    const source = sym.source!;

    // Triggers: ->trigger('eventName') or Event::trigger(...)
    const triggerRe = /->trigger\s*\(\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = triggerRe.exec(source)) !== null) {
      const eventName = match[1]!;
      if (options?.event_name && eventName !== options.event_name) continue;
      const line = sym.start_line + (source.slice(0, match.index).match(/\n/g)?.length ?? 0);
      getOrCreate(eventName).triggers.push({
        file: sym.file,
        line,
        context: extractLineContext(source, match.index),
      });
    }

    // Listeners: ->on('eventName', ...) or Event::on(...)
    const listenerRe = /(?:->|::)on\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = listenerRe.exec(source)) !== null) {
      const eventName = match[1]!;
      if (options?.event_name && eventName !== options.event_name) continue;
      const line = sym.start_line + (source.slice(0, match.index).match(/\n/g)?.length ?? 0);
      getOrCreate(eventName).listeners.push({
        file: sym.file,
        line,
        context: extractLineContext(source, match.index),
      });
    }
  }

  const events = [...eventMap.values()];
  return { events, total: events.length };
}

// ---------------------------------------------------------------------------
// 7d. find_php_views — render() → view file mapping
// ---------------------------------------------------------------------------

export interface PhpViewMapping {
  controller: string;
  action: string;
  view_name: string;
  view_file: string | null;
  render_line: number;
}

export async function findPhpViews(
  repo: string,
  options?: { controller?: string },
): Promise<{ mappings: PhpViewMapping[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const mappings: PhpViewMapping[] = [];

  // Find action methods in controllers
  const controllers = index.symbols.filter(
    (s) => s.kind === "class" && s.name.endsWith("Controller") && s.file.endsWith(".php"),
  );

  for (const ctrl of controllers) {
    if (options?.controller && !ctrl.name.includes(options.controller)) continue;

    const actions = index.symbols.filter(
      (s) => s.parent === ctrl.id && s.kind === "method" && s.name.startsWith("action"),
    );

    for (const action of actions) {
      if (!action.source) continue;

      // Match $this->render('viewName'), renderPartial('...'), renderAjax('...')
      const renderRe = /\$this->render(?:Partial|Ajax|AsJson)?\s*\(\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = renderRe.exec(action.source)) !== null) {
        const viewName = match[1]!;
        // Yii2 convention: views/{controller-id}/{view}.php
        const controllerId = pascalToKebab(ctrl.name.replace(/Controller$/, ""));
        const viewFile = `views/${controllerId}/${viewName}.php`;
        const exists = index.files.some((f) => f.path === viewFile || f.path.endsWith("/" + viewFile));
        const line = action.start_line + (action.source.slice(0, match.index).match(/\n/g)?.length ?? 0);

        mappings.push({
          controller: ctrl.name,
          action: action.name,
          view_name: viewName,
          view_file: exists ? viewFile : null,
          render_line: line,
        });
      }
    }
  }

  return { mappings, total: mappings.length };
}

// ---------------------------------------------------------------------------
// 7e. resolve_php_service — DI / Service Locator resolver
// ---------------------------------------------------------------------------

export interface PhpServiceResolution {
  name: string;
  class: string | null;
  file: string | null;
  config_file: string | null;
}

export async function resolvePhpService(
  repo: string,
  options?: { service_name?: string },
): Promise<{ services: PhpServiceResolution[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const services: PhpServiceResolution[] = [];
  const configFiles = index.files.filter((f) =>
    /config\/(web|console|main|db)\.php$/.test(f.path),
  );

  for (const cf of configFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, cf.path), "utf-8");
    } catch { continue; }

    // Match component definitions: 'componentName' => ['class' => 'FQCN', ...]
    const componentRe = /['"]([\w-]+)['"]\s*=>\s*\[\s*['"]class['"]\s*=>\s*['"]([\w\\]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = componentRe.exec(source)) !== null) {
      const name = match[1]!;
      const cls = match[2]!;

      if (options?.service_name && name !== options.service_name) continue;

      // Resolve class to file via PSR-4
      let filePath: string | null = null;
      try {
        const resolved = await resolvePhpNamespace(repo, cls);
        if (resolved.exists) filePath = resolved.file_path;
      } catch { /* ignore */ }

      services.push({
        name,
        class: cls,
        file: filePath,
        config_file: cf.path,
      });
    }
  }

  return { services, total: services.length };
}

// ---------------------------------------------------------------------------
// 7f. php_security_scan — Compound security tool
// ---------------------------------------------------------------------------

export interface PhpSecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  pattern: string;
  file: string;
  line: number;
  context: string;
  description: string;
}

export interface PhpSecurityScanResult {
  findings: PhpSecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  checks_run: string[];
}

const PHP_SECURITY_CHECKS = [
  { pattern: "sql-injection-php", severity: "critical" as const },
  { pattern: "xss-php", severity: "critical" as const },
  { pattern: "eval-php", severity: "critical" as const },
  { pattern: "exec-php", severity: "critical" as const },
  { pattern: "unserialize-php", severity: "high" as const },
  { pattern: "file-include-var", severity: "high" as const },
  { pattern: "unescaped-yii-view", severity: "high" as const },
  { pattern: "raw-query-yii", severity: "high" as const },
];

export async function phpSecurityScan(
  repo: string,
  options?: { file_pattern?: string; checks?: string[] },
): Promise<PhpSecurityScanResult> {
  const selectedChecks = options?.checks
    ? PHP_SECURITY_CHECKS.filter((c) => options.checks!.includes(c.pattern))
    : PHP_SECURITY_CHECKS;

  const findings: PhpSecurityFinding[] = [];
  const summary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };

  // Run pattern checks in parallel
  const results = await Promise.all(
    selectedChecks.map((check) =>
      searchPatterns(repo, check.pattern, {
        file_pattern: options?.file_pattern ?? ".php",
        include_tests: false,
      }).then((r) => ({ check, result: r })).catch(() => null),
    ),
  );

  for (const res of results) {
    if (!res) continue;
    for (const m of res.result.matches) {
      findings.push({
        severity: res.check.severity,
        pattern: res.check.pattern,
        file: m.file,
        line: m.start_line,
        context: m.context,
        description: "", // description populated by searchPatterns but not in PatternMatch type
      });
      summary[res.check.severity]++;
      summary.total++;
    }
  }

  return {
    findings,
    summary,
    checks_run: selectedChecks.map((c) => c.pattern),
  };
}

// ---------------------------------------------------------------------------
// 7h. find_php_n_plus_one — detect foreach + relation access without ->with()
// ---------------------------------------------------------------------------

/**
 * Common ActiveRecord scalar field names. Property access like $user->id or
 * $user->created_at inside a foreach is NOT a relation (no N+1 risk), so we
 * allow-list these to cut false positives.
 */
const SCALAR_FIELD_NAMES = new Set([
  "id", "name", "title", "created_at", "updated_at", "deleted_at", "status",
  "email", "slug", "code", "type", "value", "label", "description", "enabled",
  "active", "position", "sort", "order", "count", "total", "amount", "price",
  "uuid", "hash", "token", "key", "url", "path", "image", "avatar",
]);

export interface NPlusOneFinding {
  file: string;
  method: string;
  line: number;
  relation: string;
  pattern: string;
}

/**
 * Detect N+1 query patterns in Yii2/Eloquent controllers.
 *
 * Pattern: `foreach ($items as $item) { $item->relation->... }` without a
 * prior `->with('relation')` call in the same method scope. This is the
 * most common N+1 anti-pattern in Yii2 ActiveRecord code.
 *
 * Known limitations (acceptable for a "discovery" tool, not a gate):
 * - Regex-based — can miss multi-line foreach bodies split across nested blocks
 * - Doesn't cross function boundaries — eager loading in caller is invisible
 * - False positives on nested loops if the outer collection is already eager-loaded
 */
export async function findPhpNPlusOne(
  repo: string,
  options?: { limit?: number; file_pattern?: string },
): Promise<{ findings: NPlusOneFinding[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const findings: NPlusOneFinding[] = [];
  const limit = options?.limit ?? 100;
  const filePattern = options?.file_pattern;

  for (const sym of index.symbols) {
    if (sym.kind !== "method" || !sym.file.endsWith(".php") || !sym.source) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;

    const src = sym.source;
    const foreachRe = /foreach\s*\(\s*\$(\w+)\s+as\s+(?:\$\w+\s*=>\s*)?\$(\w+)\s*\)/g;
    let fm: RegExpExecArray | null;
    while ((fm = foreachRe.exec(src)) !== null) {
      const itemVar = fm[2]!;
      // Scan everything after the foreach opening for $itemVar->relation
      // (property access, not method call — methods are too ambiguous).
      const after = src.slice(fm.index);
      const relRe = new RegExp(`\\$${itemVar}->(\\w+)(?!\\()`, "g");
      const relMatch = relRe.exec(after);
      if (!relMatch) continue;
      const relation = relMatch[1]!;

      // Skip well-known scalar fields
      if (SCALAR_FIELD_NAMES.has(relation.toLowerCase())) continue;

      // Check if an earlier ->with('relation') eager-loads this relation
      const beforeForeach = src.slice(0, fm.index);
      const withRe = new RegExp(`\\bwith\\s*\\(\\s*['"]${relation}['"]`);
      if (withRe.test(beforeForeach)) continue;

      const lineOffset = beforeForeach.split("\n").length - 1;
      findings.push({
        file: sym.file,
        method: sym.name,
        line: sym.start_line + lineOffset,
        relation,
        pattern: "foreach-access-without-with",
      });
      if (findings.length >= limit) return { findings, total: findings.length };
    }
  }

  return { findings, total: findings.length };
}

// ---------------------------------------------------------------------------
// 7i. find_php_god_model — oversized ActiveRecord models
// ---------------------------------------------------------------------------

export interface GodModelFinding {
  name: string;
  file: string;
  method_count: number;
  relation_count: number;
  line_count: number;
  reasons: string[];
}

/**
 * Flag ActiveRecord models with too many methods, relations, or lines.
 * Thresholds are configurable (default 50/15/500). Uses analyzeActiveRecord
 * for model detection, then cross-references the class symbol for line span.
 *
 * Classic anti-pattern in large Yii2 apps — Survey.php in Mobi2 has 175
 * methods, 30 relations, split across a single 3000-line file.
 */
export async function findPhpGodModel(
  repo: string,
  options?: { min_methods?: number; min_relations?: number; min_lines?: number },
): Promise<{ models: GodModelFinding[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const ar = await analyzeActiveRecord(repo);
  const minM = options?.min_methods ?? 50;
  const minR = options?.min_relations ?? 15;
  const minL = options?.min_lines ?? 500;

  const models: GodModelFinding[] = [];
  for (const m of ar.models) {
    // Look up the class symbol by (name, kind, file) — file match keeps
    // duplicate class names in different paths (e.g. Survey.php + Survey copy.php)
    // reported independently.
    const classSym = index.symbols.find(
      (s) => s.name === m.name && s.kind === "class" && s.file === m.file,
    );
    const lineCount = classSym ? classSym.end_line - classSym.start_line : 0;

    const reasons: string[] = [];
    if (m.methods.length > minM) reasons.push(`methods: ${m.methods.length} > ${minM}`);
    if (m.relations.length > minR) reasons.push(`relations: ${m.relations.length} > ${minR}`);
    if (lineCount > minL) reasons.push(`lines: ${lineCount} > ${minL}`);

    if (reasons.length > 0) {
      models.push({
        name: m.name,
        file: m.file,
        method_count: m.methods.length,
        relation_count: m.relations.length,
        line_count: lineCount,
        reasons,
      });
    }
  }

  // Sort by severity (number of reasons desc, then methods desc)
  models.sort((a, b) => b.reasons.length - a.reasons.length || b.method_count - a.method_count);

  return { models, total: models.length };
}

// ---------------------------------------------------------------------------
// 7g. php_project_audit — Compound meta-tool
// ---------------------------------------------------------------------------

export interface AuditGate {
  name: string;
  status: "ok" | "error" | "timeout";
  findings_count: number;
  duration_ms: number;
  error?: string;
}

export interface PhpProjectAudit {
  repo: string;
  duration_ms: number;
  checks_run: string[];
  gates: AuditGate[];
  summary: {
    total_findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    health_score: number;
    top_risks: string[];
  };
  security: PhpSecurityScanResult;
  activerecord: ActiveRecordAnalysis;
}

const AUDIT_TIMEOUT = 8000;

export async function phpProjectAudit(
  repo: string,
  options?: { file_pattern?: string; checks?: string[] },
): Promise<PhpProjectAudit> {
  const startTime = Date.now();
  const gates: AuditGate[] = [];
  const allChecks = ["security", "activerecord", "complexity", "dead_code", "patterns", "clones", "hotspots", "n_plus_one", "god_model"];
  const enabled = new Set(options?.checks ?? allChecks);
  const fp = options?.file_pattern ?? ".php";
  const secOpts: { file_pattern?: string } = {};
  if (options?.file_pattern) secOpts.file_pattern = options.file_pattern;

  type Task = { name: string; run: () => Promise<unknown> };
  const tasks: Task[] = [];

  if (enabled.has("security")) tasks.push({ name: "security", run: () => phpSecurityScan(repo, secOpts) });
  if (enabled.has("activerecord")) tasks.push({ name: "activerecord", run: () => analyzeActiveRecord(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined) });
  if (enabled.has("complexity")) tasks.push({ name: "complexity", run: async () => { const { analyzeComplexity } = await import("./complexity-tools.js"); return analyzeComplexity(repo, { file_pattern: fp, top_n: 10 }); } });
  if (enabled.has("dead_code")) tasks.push({ name: "dead_code", run: async () => { const { findDeadCode } = await import("./symbol-tools.js"); return findDeadCode(repo, { file_pattern: fp }); } });
  if (enabled.has("patterns")) tasks.push({ name: "patterns", run: () => searchPatterns(repo, "empty-catch", { file_pattern: fp }) });
  if (enabled.has("clones")) tasks.push({ name: "clones", run: async () => { const { findClones } = await import("./clone-tools.js"); return findClones(repo, { file_pattern: fp }); } });
  if (enabled.has("hotspots")) tasks.push({ name: "hotspots", run: async () => { const { analyzeHotspots } = await import("./hotspot-tools.js"); return analyzeHotspots(repo, {}); } });
  if (enabled.has("n_plus_one")) tasks.push({ name: "n_plus_one", run: () => findPhpNPlusOne(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined) });
  if (enabled.has("god_model")) tasks.push({ name: "god_model", run: () => findPhpGodModel(repo) });

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      const s = Date.now();
      const r = await Promise.race([t.run(), new Promise<"TIMEOUT">((ok) => setTimeout(() => ok("TIMEOUT"), AUDIT_TIMEOUT))]);
      return { name: t.name, result: r, ms: Date.now() - s };
    }),
  );

  let securityResult: PhpSecurityScanResult = { findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, checks_run: [] };
  let arResult: ActiveRecordAnalysis = { models: [], total: 0 };
  let totalFindings = 0;

  for (const s of settled) {
    if (s.status === "rejected") { gates.push({ name: "unknown", status: "error", findings_count: 0, duration_ms: 0, error: String(s.reason) }); continue; }
    const { name, result, ms } = s.value;
    if (result === "TIMEOUT") { gates.push({ name, status: "timeout", findings_count: 0, duration_ms: ms }); continue; }

    let count = 0;
    // activerecord is informational (model count), not a problem finding — excluded from totalFindings and health score
    if (name === "security") { securityResult = result as PhpSecurityScanResult; count = securityResult.summary.total; }
    else if (name === "activerecord") { arResult = result as ActiveRecordAnalysis; count = arResult.total; }
    else if (name === "complexity") count = (result as { summary?: { above_threshold?: number } })?.summary?.above_threshold ?? 0;
    else if (name === "dead_code") count = (result as { candidates?: unknown[] })?.candidates?.length ?? 0;
    else if (name === "patterns") count = (result as { matches?: unknown[] })?.matches?.length ?? 0;
    else if (name === "clones") count = (result as { clones?: unknown[] })?.clones?.length ?? 0;
    else if (name === "hotspots") count = (result as { hotspots?: unknown[] })?.hotspots?.length ?? 0;
    else if (name === "n_plus_one") count = (result as { findings?: unknown[] })?.findings?.length ?? 0;
    else if (name === "god_model") count = (result as { models?: unknown[] })?.models?.length ?? 0;

    if (name !== "activerecord") totalFindings += count;
    gates.push({ name, status: "ok", findings_count: count, duration_ms: ms });
  }

  const sec = securityResult.summary;
  // Logarithmic penalties — a few critical findings are serious, but hundreds of
  // complexity warnings shouldn't tank the score to 0. Each gate uses log2 scaling
  // so 1 finding ≈ 0, 10 ≈ 17, 100 ≈ 33, 1000 ≈ 50 penalty points.
  const secPenalty = sec.total > 0 ? Math.round(Math.log2(sec.total + 1) * (sec.critical > 0 ? 8 : 4)) : 0;
  const qualityFindings = totalFindings - sec.total;
  const qualPenalty = qualityFindings > 0 ? Math.round(Math.log2(qualityFindings + 1) * 4) : 0;
  const healthScore = Math.max(0, Math.min(100, 100 - secPenalty - qualPenalty));
  const topRisks = gates.filter(g => g.findings_count > 0 && g.name !== "activerecord").sort((a, b) => b.findings_count - a.findings_count).slice(0, 3).map(g => `${g.name}: ${g.findings_count} findings`);

  return {
    repo, duration_ms: Date.now() - startTime,
    checks_run: gates.filter(g => g.status === "ok").map(g => g.name),
    gates,
    summary: { total_findings: totalFindings, critical: sec.critical, high: sec.high, medium: sec.medium, low: sec.low, health_score: healthScore, top_risks: topRisks },
    security: securityResult,
    activerecord: arResult,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonSafe(path: string): Promise<any> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function extractLineContext(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const lineEnd = source.indexOf("\n", index);
  const end = lineEnd === -1 ? source.length : lineEnd;
  return source.slice(lineStart, end).trim().slice(0, 200);
}

function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
