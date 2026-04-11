/**
 * python_audit — compound Python project health check.
 *
 * Runs 8 checks in parallel with per-check timeouts:
 *   1. Circular imports (find_python_circular_imports)
 *   2. Django settings (analyze_django_settings) — only if Django project
 *   3. Python anti-patterns (search_patterns across 17 Python patterns)
 *   4. Framework wiring (find_framework_wiring)
 *   5. Celery orphan tasks (trace_celery_chain)
 *   6. pytest fixture issues (get_test_fixtures)
 *   7. pyproject dependency freshness (parse_pyproject)
 *   8. Dead code (find_dead_code on Python files)
 *
 * Produces a unified health score (0-100), severity counts, and a
 * prioritized top_risks list. Mirrors the shape of php_project_audit
 * so downstream report tooling can reuse formatters.
 */
import { getCodeIndex } from "./index-tools.js";
import { findPythonCircularImports } from "./python-circular-imports.js";
import { analyzeDjangoSettings } from "./django-settings.js";
import { searchPatterns } from "./pattern-tools.js";
import { findFrameworkWiring } from "./wiring-tools.js";
import { traceCeleryChain } from "./celery-tools.js";
import { getTestFixtures } from "./pytest-tools.js";
import { parsePyproject } from "./pyproject-tools.js";

export interface PythonAuditGate {
  name: string;
  status: "ok" | "error" | "timeout" | "skipped";
  findings_count: number;
  duration_ms: number;
  error?: string;
}

export interface PythonAuditResult {
  repo: string;
  duration_ms: number;
  checks_run: string[];
  gates: PythonAuditGate[];
  summary: {
    total_findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    health_score: number;
    top_risks: string[];
  };
  findings: {
    circular_imports?: number;
    django_critical?: number;
    django_high?: number;
    anti_patterns?: number;
    orphan_tasks?: number;
    unpinned_deps?: number;
    dead_code?: number;
    fixture_count?: number;
  };
}

const AUDIT_TIMEOUT = 10000;

const PYTHON_PATTERNS = [
  "mutable-default",
  "bare-except",
  "broad-except",
  "eval-exec",
  "shell-true",
  "pickle-load",
  "yaml-unsafe",
  "shadow-builtin",
  "n-plus-one-django",
  "late-binding",
  "assert-tuple",
];

/** Run one check with timeout and capture result + duration. */
async function runCheck<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ name: string; result: T | "TIMEOUT" | "ERROR"; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), AUDIT_TIMEOUT)),
    ]);
    return { name, result, ms: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, result: "ERROR", ms: Date.now() - start, error: msg };
  }
}

/**
 * Run a compound Python project audit: 8 parallel checks with unified scoring.
 */
export async function pythonAudit(
  repo: string,
  options?: {
    file_pattern?: string;
    checks?: string[];
  },
): Promise<PythonAuditResult> {
  const startTime = Date.now();
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Detect if this is a Django project (only then run django settings check)
  const hasDjangoFiles = index.files.some(
    (f) => /\/settings\.py$|\/settings\/[\w_]+\.py$/.test(f.path),
  );

  const allChecks = [
    "circular_imports",
    "django_settings",
    "anti_patterns",
    "framework_wiring",
    "celery",
    "pytest_fixtures",
    "dependencies",
    "dead_code",
  ];
  const enabled = new Set(options?.checks ?? allChecks);

  const tasks: Array<Promise<Awaited<ReturnType<typeof runCheck>>>> = [];

  if (enabled.has("circular_imports")) {
    tasks.push(runCheck("circular_imports", () =>
      findPythonCircularImports(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined),
    ));
  }

  if (enabled.has("django_settings") && hasDjangoFiles) {
    tasks.push(runCheck("django_settings", () => analyzeDjangoSettings(repo)));
  }

  if (enabled.has("anti_patterns")) {
    // Run all Python patterns in parallel, aggregate counts
    tasks.push(runCheck("anti_patterns", async () => {
      const results = await Promise.all(
        PYTHON_PATTERNS.map((p) =>
          searchPatterns(repo, p, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined)
            .catch(() => ({ matches: [] })),
        ),
      );
      const allMatches = results.flatMap((r) => r.matches ?? []);
      return { matches: allMatches, total: allMatches.length };
    }));
  }

  if (enabled.has("framework_wiring")) {
    tasks.push(runCheck("framework_wiring", () =>
      findFrameworkWiring(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined),
    ));
  }

  if (enabled.has("celery")) {
    tasks.push(runCheck("celery", () =>
      traceCeleryChain(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined),
    ));
  }

  if (enabled.has("pytest_fixtures")) {
    tasks.push(runCheck("pytest_fixtures", () =>
      getTestFixtures(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined),
    ));
  }

  if (enabled.has("dependencies")) {
    tasks.push(runCheck("dependencies", () => parsePyproject(repo)));
  }

  if (enabled.has("dead_code")) {
    tasks.push(runCheck("dead_code", async () => {
      const { findDeadCode } = await import("./symbol-tools.js");
      return findDeadCode(repo, { file_pattern: ".py" });
    }));
  }

  const results = await Promise.all(tasks);

  // Build gates + aggregate findings
  const gates: PythonAuditGate[] = [];
  const findings: PythonAuditResult["findings"] = {};
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const r of results) {
    if (r.result === "TIMEOUT") {
      gates.push({ name: r.name, status: "timeout", findings_count: 0, duration_ms: r.ms });
      continue;
    }
    if (r.result === "ERROR") {
      const g: PythonAuditGate = { name: r.name, status: "error", findings_count: 0, duration_ms: r.ms };
      if (r.error) g.error = r.error;
      gates.push(g);
      continue;
    }

    let count = 0;
    const res = r.result as Record<string, unknown>;

    switch (r.name) {
      case "circular_imports": {
        count = (res.total as number) ?? 0;
        findings.circular_imports = count;
        // Short cycles (≤3) are errors — count as high severity
        const cycles = (res.cycles as Array<{ severity: string }>) ?? [];
        high += cycles.filter((c) => c.severity === "error").length;
        medium += cycles.filter((c) => c.severity === "warning").length;
        break;
      }
      case "django_settings": {
        const dj = res as { findings: Array<{ severity: string }>; by_severity: Record<string, number> };
        count = dj.findings?.length ?? 0;
        findings.django_critical = dj.by_severity?.critical ?? 0;
        findings.django_high = dj.by_severity?.high ?? 0;
        critical += dj.by_severity?.critical ?? 0;
        high += dj.by_severity?.high ?? 0;
        medium += dj.by_severity?.medium ?? 0;
        low += dj.by_severity?.low ?? 0;
        break;
      }
      case "anti_patterns": {
        count = (res.total as number) ?? 0;
        findings.anti_patterns = count;
        // All Python anti-patterns are medium unless proven otherwise
        medium += count;
        break;
      }
      case "framework_wiring": {
        // Informational — not a finding
        count = 0;
        break;
      }
      case "celery": {
        const orphans = (res.orphan_tasks as string[]) ?? [];
        count = orphans.length;
        findings.orphan_tasks = count;
        low += count;
        break;
      }
      case "pytest_fixtures": {
        // Informational
        count = 0;
        findings.fixture_count = (res.fixture_count as number) ?? 0;
        break;
      }
      case "dependencies": {
        if (res && typeof res === "object" && "dependencies" in res) {
          const deps = (res.dependencies as Array<{ version: string }>) ?? [];
          const unpinned = deps.filter((d) => d.version === "*" || d.version === "").length;
          count = unpinned;
          findings.unpinned_deps = unpinned;
          low += unpinned;
        }
        break;
      }
      case "dead_code": {
        const candidates = (res.candidates as unknown[]) ?? [];
        count = candidates.length;
        findings.dead_code = count;
        low += count;
        break;
      }
    }

    gates.push({ name: r.name, status: "ok", findings_count: count, duration_ms: r.ms });
  }

  // Skipped checks (not run because not applicable)
  if (enabled.has("django_settings") && !hasDjangoFiles) {
    gates.push({ name: "django_settings", status: "skipped", findings_count: 0, duration_ms: 0 });
  }

  // Compute health score: 100 - weighted penalties
  //   critical = -15, high = -8, medium = -3, low = -1, floor at 0
  const rawScore = 100 - critical * 15 - high * 8 - medium * 3 - low;
  const health_score = Math.max(0, Math.min(100, rawScore));
  const total_findings = critical + high + medium + low;

  // Top risks: most severe categories first
  const top_risks: string[] = [];
  if ((findings.django_critical ?? 0) > 0) {
    top_risks.push(`Django: ${findings.django_critical} critical security issues in settings.py`);
  }
  if ((findings.circular_imports ?? 0) > 0) {
    top_risks.push(`${findings.circular_imports} circular import cycles detected`);
  }
  if ((findings.anti_patterns ?? 0) > 5) {
    top_risks.push(`${findings.anti_patterns} Python anti-pattern matches`);
  }
  if ((findings.orphan_tasks ?? 0) > 0) {
    top_risks.push(`${findings.orphan_tasks} orphan Celery tasks (defined but never called)`);
  }
  if ((findings.unpinned_deps ?? 0) > 0) {
    top_risks.push(`${findings.unpinned_deps} unpinned dependencies`);
  }
  if ((findings.dead_code ?? 0) > 10) {
    top_risks.push(`${findings.dead_code} dead code candidates`);
  }

  return {
    repo,
    duration_ms: Date.now() - startTime,
    checks_run: gates.map((g) => g.name),
    gates,
    summary: {
      total_findings,
      critical,
      high,
      medium,
      low,
      health_score,
      top_risks,
    },
    findings,
  };
}
