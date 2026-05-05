/**
 * Yii3 migration audit (M4) — decision-support tool.
 *
 * Inventories Yii2-specific API usage across a codebase and projects an
 * effort estimate so the team can choose between staying on Yii 2.0.49+
 * with PHP 8 vs migrating to Yii3. The tool is grep-style by design: it
 * does not try to understand semantics, only to count call sites by
 * category and surface the highest-leverage blockers.
 *
 * Every category maps a Yii2 idiom to its Yii3 equivalent and assigns a
 * severity + per-call effort estimate. The aggregated effort_estimate
 * gives a rough hours-low/hours-high range. Severity reflects how hard
 * the migration is, NOT how dangerous the current code is.
 *
 * Out of scope:
 *   - Vendor / third-party packages (we strip vendor/ paths before scan).
 *   - Semantic disambiguation (e.g. `Yii::$app->db` is service-locator
 *     even when the property is dynamically resolved at runtime — we
 *     don't try to detect that).
 *   - Migration plans for non-Yii frameworks (Laravel/Symfony).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Yii3MigrationCategoryName =
  | "service-locator"
  | "object-factory"
  | "aliases"
  | "i18n"
  | "logger"
  | "application-props"
  | "module"
  | "request"
  | "response"
  | "session"
  | "user-identity"
  | "active-record"
  | "validators"
  | "form-model"
  | "widgets"
  | "view"
  | "url-manager"
  | "console"
  | "migrations"
  | "queue"
  | "rbac";

export type Severity = "critical" | "high" | "medium" | "low";
export type EffortBucket = "trivial" | "small" | "medium" | "large";

export interface CategoryDefinition {
  category: Yii3MigrationCategoryName;
  severity: Severity;
  description: string;
  yii3_replacement: string;
  effort_per_call: EffortBucket;
  /** One or more regexes; a file is counted once per match. The regex must
   *  be globally flagged so we can iterate matches in a single source pass. */
  patterns: RegExp[];
}

export interface CategoryFinding {
  category: Yii3MigrationCategoryName;
  severity: Severity;
  count: number;
  effort_per_call: EffortBucket;
  description: string;
  yii3_replacement: string;
  /** First few file:line:snippet triples — capped to keep output tight. */
  sample_files: Array<{
    file: string;
    line: number;
    snippet: string;
  }>;
}

export interface Yii3MigrationAudit {
  repo: string;
  scanned_files: number;
  total_call_sites: number;
  by_category: CategoryFinding[];
  by_severity: Record<Severity, number>;
  blockers: Array<{
    category: Yii3MigrationCategoryName;
    reason: string;
    related_files_count: number;
  }>;
  effort_estimate: {
    hours_low: number;
    hours_high: number;
    note: string;
  };
  decision_signal:
    | "stay-on-yii2"
    | "consider-yii3"
    | "high-effort-yii3"
    | "blocked";
  yii_version_detected: string | null;
  php_version_required: string | null;
}

// ---------------------------------------------------------------------------
// Effort tariff
// ---------------------------------------------------------------------------

const EFFORT_HOURS: Record<EffortBucket, [number, number]> = {
  // [low_estimate, high_estimate] hours per call site.
  // Calibrated against common Yii2→Yii3 retrospectives. The low end assumes
  // a team that has migrated similar code before; high end assumes greenfield.
  trivial: [0.05, 0.15],
  small: [0.25, 0.75],
  medium: [1, 3],
  large: [4, 12],
};

// ---------------------------------------------------------------------------
// Category catalog (21 categories)
// ---------------------------------------------------------------------------

const CATEGORIES: CategoryDefinition[] = [
  {
    category: "service-locator",
    severity: "critical",
    description:
      "Yii::$app->X service locator access — every call site needs DI ctor injection in Yii3.",
    yii3_replacement:
      "Inject the service via constructor (e.g. `public function __construct(private Connection $db)`).",
    effort_per_call: "small",
    patterns: [
      // Catches both Yii::$app->X and \Yii::$app->X. Excludes the more
      // specific subcategories below by NOT matching their well-known
      // property names — those land in their own buckets.
      /\\?\bYii::\$app->(?!request\b|response\b|session\b|user\b|urlManager\b|authManager\b|queue\b|view\b|controller\b|errorHandler\b|id\b|params\b|language\b|name\b|homeUrl\b|formatter\b|i18n\b)([a-zA-Z_][\w]*)/g,
    ],
  },
  {
    category: "object-factory",
    severity: "high",
    description:
      "Yii::createObject() factory — Yii3 uses a PSR-11 container directly.",
    yii3_replacement:
      "Resolve via Yii3 DI: `$container->get(ClassName::class)`. Most call sites can become constructor injection.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::createObject\s*\(/g],
  },
  {
    category: "aliases",
    severity: "high",
    description:
      "Yii::getAlias / Yii::setAlias path-alias system — Yii3 has a dedicated Aliases service.",
    yii3_replacement:
      "Inject `Yiisoft\\Aliases\\Aliases` and use its API.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::(?:getAlias|setAlias)\s*\(/g],
  },
  {
    category: "i18n",
    severity: "high",
    description:
      "Yii::t() translation calls — Yii3 uses a TranslatorInterface injected per consumer.",
    yii3_replacement:
      "Inject `Yiisoft\\Translator\\TranslatorInterface`. Message files migrate to PO/PHP arrays per package.",
    effort_per_call: "trivial",
    patterns: [/\\?\bYii::t\s*\(/g],
  },
  {
    category: "logger",
    severity: "high",
    description:
      "Yii::error / Yii::info / Yii::warning / Yii::trace — Yii3 uses PSR-3 LoggerInterface.",
    yii3_replacement:
      "Inject `Psr\\Log\\LoggerInterface` and call `$logger->info(...)`, `$logger->error(...)`.",
    effort_per_call: "trivial",
    patterns: [/\\?\bYii::(?:error|info|warning|trace|debug|beginProfile|endProfile)\s*\(/g],
  },
  {
    category: "application-props",
    severity: "medium",
    description:
      "Yii::$app->id / params / language / homeUrl / name — Yii3 splits these across several services.",
    yii3_replacement:
      "Read via dedicated service (Application name / Aliases / Translator locale / Params service).",
    effort_per_call: "trivial",
    patterns: [
      /\\?\bYii::\$app->(?:id|params|language|homeUrl|name|formatter|i18n)\b/g,
    ],
  },
  {
    category: "module",
    severity: "critical",
    description:
      "Class extends yii\\base\\Module — Yii3 has no module concept; flatten to packages or use DI scopes.",
    yii3_replacement:
      "Convert each module into a Composer package or restructure into namespaces with their own DI bindings.",
    effort_per_call: "large",
    patterns: [
      /\bextends\s+(?:\\?yii\\base\\Module|Module)\b/g,
    ],
  },
  {
    category: "request",
    severity: "high",
    description:
      "Yii::$app->request->X — replace with PSR-7 ServerRequestInterface.",
    yii3_replacement:
      "Inject `Psr\\Http\\Message\\ServerRequestInterface` (or a Yii Request decorator).",
    effort_per_call: "small",
    patterns: [/\\?\bYii::\$app->request->/g],
  },
  {
    category: "response",
    severity: "high",
    description:
      "Yii::$app->response->X — replace with PSR-7 ResponseFactoryInterface.",
    yii3_replacement:
      "Inject `Psr\\Http\\Message\\ResponseFactoryInterface` and return `ResponseInterface`.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::\$app->response->/g],
  },
  {
    category: "session",
    severity: "medium",
    description:
      "Yii::$app->session->X — Yii3 has a session package with its own interface.",
    yii3_replacement:
      "Inject `Yiisoft\\Session\\SessionInterface` (or PSR-15 session middleware).",
    effort_per_call: "trivial",
    patterns: [/\\?\bYii::\$app->session->/g],
  },
  {
    category: "user-identity",
    severity: "high",
    description:
      "Yii::$app->user->identity / id / isGuest / can — auth shape differs in Yii3.",
    yii3_replacement:
      "Inject `Yiisoft\\Auth\\IdentityInterface` (or a project-specific identity service) + RBAC package.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::\$app->user->/g],
  },
  {
    category: "active-record",
    severity: "critical",
    description:
      "ActiveRecord (yii\\db\\ActiveRecord) — Yii3 has no AR core. Pick Cycle ORM or yiisoft/active-record.",
    yii3_replacement:
      "Cycle ORM (preferred for new code) or `yiisoft/active-record` (closer to Yii2 API).",
    effort_per_call: "medium",
    patterns: [
      /\bextends\s+(?:\\?yii\\db\\ActiveRecord|ActiveRecord)\b/g,
    ],
  },
  {
    category: "validators",
    severity: "high",
    description:
      "Yii2 rules() validation array — Yii3 uses `yiisoft/validator` with attributes or rule objects.",
    yii3_replacement:
      "Replace `rules()` with attribute-based validation (`#[Required, Email]`) or a Validator service.",
    effort_per_call: "small",
    // Heuristic: a `rules()` method that returns an array. We count one per
    // class that defines such a method. False positives possible if a class
    // unrelated to Yii2 has its own rules().
    patterns: [
      /\bpublic\s+function\s+rules\s*\(\s*\)\s*(?::\s*array\s*)?\{/g,
    ],
  },
  {
    category: "form-model",
    severity: "high",
    description:
      "Form models extending yii\\base\\Model with load() + validate() — Yii3 has `yiisoft/form-model`.",
    yii3_replacement:
      "Migrate to `yiisoft/form-model`. The `load()`/`validate()` lifecycle moves to FormModelInterface.",
    effort_per_call: "small",
    patterns: [
      /\bextends\s+(?:\\?yii\\base\\Model|Model)\b(?!\\)/g,
      /->load\s*\(\s*Yii::\$app->request->post\s*\(\s*\)\s*\)/g,
    ],
  },
  {
    category: "widgets",
    severity: "high",
    description:
      "Yii2 widgets (GridView, ActiveForm, Pjax, ListView) — Yii3 splits widgets into separate packages and some are gone.",
    yii3_replacement:
      "Per widget: use `yiisoft/yii-bootstrap5`, `yiisoft/yii-gridview`, `yiisoft/form` or rewrite as Twig/Vue components.",
    effort_per_call: "medium",
    patterns: [
      /\b(?:GridView|ActiveForm|Pjax|ListView|DetailView|Breadcrumbs|Menu|LinkPager)::(?:widget|begin)\s*\(/g,
    ],
  },
  {
    category: "view",
    severity: "high",
    description:
      "$this->render() / $this->layout — Yii3 has a yii-view package with a different lifecycle.",
    yii3_replacement:
      "Inject `Yiisoft\\View\\ViewInterface`. `$this->layout` becomes view parameters/decorators.",
    effort_per_call: "small",
    patterns: [
      /\$this->render(?:Partial|Ajax|AsJson|File)?\s*\(/g,
      /\$this->layout\s*=/g,
    ],
  },
  {
    category: "url-manager",
    severity: "high",
    description:
      "Yii::$app->urlManager / urlManager rules in config — Yii3 uses a Router package + attribute-based routes.",
    yii3_replacement:
      "Migrate `urlManager` rules to `yiisoft/router` + per-action `#[Route]` attributes.",
    effort_per_call: "medium",
    patterns: [
      /\\?\bYii::\$app->urlManager->/g,
      /[\'\"]urlManager[\'\"]\s*=>\s*\[/g,
    ],
  },
  {
    category: "console",
    severity: "high",
    description:
      "Console controllers extending yii\\console\\Controller — Yii3 console uses Symfony Console.",
    yii3_replacement:
      "Rewrite each console controller as a `Symfony\\Component\\Console\\Command\\Command` subclass.",
    effort_per_call: "medium",
    patterns: [
      /\bextends\s+(?:\\?yii\\console\\Controller|Controller)\b/g,
    ],
  },
  {
    category: "migrations",
    severity: "low",
    description:
      "Migrations extending yii\\db\\Migration — Yii3 has `yiisoft/db-migration` with similar API.",
    yii3_replacement:
      "Largely API-compatible. Migrate base class import; bulk-replace `extends Migration` with the new namespace.",
    effort_per_call: "trivial",
    patterns: [
      /\bextends\s+(?:\\?yii\\db\\Migration|Migration)\b/g,
    ],
  },
  {
    category: "queue",
    severity: "medium",
    description:
      "Yii::$app->queue / yii\\queue\\Queue — Yii3 has `yiisoft/queue` (or use Symfony Messenger).",
    yii3_replacement:
      "Rewrite jobs to implement Yii3 queue's MessageInterface or Symfony Messenger handlers.",
    effort_per_call: "small",
    patterns: [
      /\\?\bYii::\$app->queue\b/g,
      /\bextends\s+(?:\\?yii\\queue\\)/g,
      /\bimplements\s+(?:\\?yii\\queue\\JobInterface|JobInterface)\b/g,
    ],
  },
  {
    category: "rbac",
    severity: "high",
    description:
      "Yii::$app->authManager (createPermission/createRole/add/addChild) and ->can() — Yii3 uses yiisoft/rbac.",
    yii3_replacement:
      "Migrate seed migrations to `yiisoft/rbac` Manager API. ->can() becomes `Manager::userHasPermission()`.",
    effort_per_call: "medium",
    // Yii2 RBAC seed migrations universally alias the manager into a local
    // variable (`$auth = Yii::$app->authManager;`) and then call
    // `$auth->createRole/createPermission/add/addChild` — so we can't rely
    // on a single combined regex. We catch:
    //   1. The aliased read itself (any reference to `Yii::$app->authManager`)
    //   2. RBAC builder method names (createRole/createPermission/add/addChild/
    //      assign/revoke/getRole/getPermission/checkAccess)
    //   3. The runtime check `Yii::$app->user->can(...)`.
    patterns: [
      /\\?\bYii::\$app->authManager\b/g,
      /->(?:createRole|createPermission|addChild|assign|revoke|getRole|getPermission|checkAccess)\s*\(/g,
      /\\?\bYii::\$app->user->can\s*\(/g,
    ],
  },
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const VENDOR_RE = /(^|\/)(?:vendor|node_modules|runtime|tests\/_data)(\/|$)/;
const SAMPLE_LIMIT = 5;

interface RawHit {
  file: string;
  line: number;
  snippet: string;
}

export async function yii3MigrationAudit(
  repo: string,
  options?: {
    file_pattern?: string;
    max_samples_per_category?: number;
    include_vendor?: boolean;
  },
): Promise<Yii3MigrationAudit> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const sampleLimit = options?.max_samples_per_category ?? SAMPLE_LIMIT;
  const includeVendor = options?.include_vendor ?? false;
  const filePattern = options?.file_pattern;

  // Pick PHP files under non-vendor paths. The CodeIndex tracks .php under
  // many roots; we just filter here so callers don't need to pre-trim.
  const phpFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (!includeVendor && VENDOR_RE.test(f.path)) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    return true;
  });

  // One bucket per category; we keep raw counts + first N samples and
  // collapse to the public CategoryFinding shape at the end.
  const buckets = new Map<
    Yii3MigrationCategoryName,
    { count: number; samples: RawHit[]; files: Set<string> }
  >();
  for (const cat of CATEGORIES) {
    buckets.set(cat.category, { count: 0, samples: [], files: new Set() });
  }

  // Read every file once, run all 21 categories against the same source
  // string. This is much faster than 21 separate scans (one fs read vs N).
  const readResults = await Promise.allSettled(
    phpFiles.map(async (f) => ({
      path: f.path,
      content: await readFile(join(index.root, f.path), "utf-8"),
    })),
  );

  for (const r of readResults) {
    if (r.status !== "fulfilled") continue;
    const { path, content } = r.value;
    for (const cat of CATEGORIES) {
      const b = buckets.get(cat.category)!;
      for (const pat of cat.patterns) {
        // Each regex must be /g; we manually reset lastIndex so categories
        // don't poison each other across patterns. The catalog above is
        // /g everywhere — this is a guard for future additions.
        pat.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pat.exec(content)) !== null) {
          b.count++;
          b.files.add(path);
          if (b.samples.length < sampleLimit) {
            const line = countLinesUntil(content, m.index);
            const snippet = extractLineAt(content, m.index);
            b.samples.push({ file: path, line, snippet });
          }
        }
      }
    }
  }

  // Roll up
  const byCategory: CategoryFinding[] = CATEGORIES.map((cat) => {
    const b = buckets.get(cat.category)!;
    return {
      category: cat.category,
      severity: cat.severity,
      count: b.count,
      effort_per_call: cat.effort_per_call,
      description: cat.description,
      yii3_replacement: cat.yii3_replacement,
      sample_files: b.samples,
    };
  })
    .filter((f) => f.count > 0)
    .sort((a, b) => {
      const sevOrder: Record<Severity, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };
      return (
        sevOrder[a.severity] - sevOrder[b.severity] || b.count - a.count
      );
    });

  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let totalCalls = 0;
  let hoursLow = 0;
  let hoursHigh = 0;
  for (const f of byCategory) {
    bySeverity[f.severity] += f.count;
    totalCalls += f.count;
    const [lo, hi] = EFFORT_HOURS[f.effort_per_call];
    hoursLow += f.count * lo;
    hoursHigh += f.count * hi;
  }

  // Blockers: critical-severity categories with non-trivial volume.
  // The threshold is intentionally high — a Yii3 migration is always going
  // to require some manual rework; we only flag the categories that would
  // dominate the schedule.
  const blockers: Yii3MigrationAudit["blockers"] = [];
  for (const f of byCategory) {
    if (f.severity !== "critical") continue;
    if (f.count < 10) continue;
    const fileCount = buckets.get(f.category)!.files.size;
    blockers.push({
      category: f.category,
      reason: `${f.count} call sites in ${fileCount} files — ${f.description}`,
      related_files_count: fileCount,
    });
  }

  // Decision signal — coarse heuristic for the executive summary.
  let decisionSignal: Yii3MigrationAudit["decision_signal"];
  if (blockers.length === 0 && totalCalls < 500) {
    decisionSignal = "consider-yii3";
  } else if (blockers.length === 0 && totalCalls < 2000) {
    decisionSignal = "consider-yii3";
  } else if (blockers.length <= 2 && totalCalls < 5000) {
    decisionSignal = "high-effort-yii3";
  } else if (blockers.length >= 3 || totalCalls >= 5000) {
    decisionSignal = "blocked";
  } else {
    decisionSignal = "stay-on-yii2";
  }

  // Composer-derived metadata — best-effort.
  const composerMeta = await readComposerMeta(index.root);

  return {
    repo,
    scanned_files: phpFiles.length,
    total_call_sites: totalCalls,
    by_category: byCategory,
    by_severity: bySeverity,
    blockers,
    effort_estimate: {
      hours_low: Math.round(hoursLow),
      hours_high: Math.round(hoursHigh),
      note:
        "Per-call estimates from CategoryDefinition.effort_per_call. Real " +
        "migrations take 2-4× longer due to integration tests, edge cases, " +
        "and team learning curve. Treat the high bound as a floor.",
    },
    decision_signal: decisionSignal,
    yii_version_detected: composerMeta.yiiVersion,
    php_version_required: composerMeta.phpRequirement,
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
    const yiiVersion = requires["yiisoft/yii2"] ?? null;
    const phpRequirement = requires.php ?? null;
    return { yiiVersion, phpRequirement };
  } catch {
    return { yiiVersion: null, phpRequirement: null };
  }
}
