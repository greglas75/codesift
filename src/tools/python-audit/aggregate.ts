import type { CheckRun, PythonAuditGate, PythonAuditResult } from "./types.js";

export function aggregateAudit(
  repo: string,
  startTime: number,
  results: CheckRun<unknown>[],
  enabled: Set<string>,
  hasDjangoFiles: boolean,
): PythonAuditResult {
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
      const gate: PythonAuditGate = { name: r.name, status: "error", findings_count: 0, duration_ms: r.ms };
      if (r.error) gate.error = r.error;
      gates.push(gate);
      continue;
    }

    let count = 0;
    const res = r.result as Record<string, unknown>;
    switch (r.name) {
      case "circular_imports": {
        count = (res.total as number) ?? 0;
        findings.circular_imports = count;
        const cycles = (res.cycles as Array<{ severity: string }>) ?? [];
        high += cycles.filter((cycle) => cycle.severity === "error").length;
        medium += cycles.filter((cycle) => cycle.severity === "warning").length;
        break;
      }
      case "django_settings": {
        const django = res as { findings: unknown[]; by_severity: Record<string, number> };
        count = django.findings?.length ?? 0;
        findings.django_critical = django.by_severity?.critical ?? 0;
        findings.django_high = django.by_severity?.high ?? 0;
        critical += django.by_severity?.critical ?? 0;
        high += django.by_severity?.high ?? 0;
        medium += django.by_severity?.medium ?? 0;
        low += django.by_severity?.low ?? 0;
        break;
      }
      case "anti_patterns":
        count = (res.total as number) ?? 0;
        findings.anti_patterns = count;
        medium += count;
        break;
      case "framework_wiring":
        break;
      case "celery": {
        count = ((res.orphan_tasks as string[]) ?? []).length;
        findings.orphan_tasks = count;
        low += count;
        break;
      }
      case "pytest_fixtures":
        findings.fixture_count = (res.fixture_count as number) ?? 0;
        break;
      case "dependencies": {
        if (typeof res === "object" && res !== null && "dependencies" in res) {
          const deps = (res.dependencies as Array<{ version: string }>) ?? [];
          count = deps.filter((dep) => dep.version === "*" || dep.version === "").length;
          findings.unpinned_deps = count;
          low += count;
        }
        break;
      }
      case "dead_code":
        count = ((res.candidates as unknown[]) ?? []).length;
        findings.dead_code = count;
        low += count;
        break;
    }
    gates.push({ name: r.name, status: "ok", findings_count: count, duration_ms: r.ms });
  }

  if (enabled.has("django_settings") && !hasDjangoFiles) {
    gates.push({ name: "django_settings", status: "skipped", findings_count: 0, duration_ms: 0 });
  }

  const rawScore = 100 - critical * 15 - high * 8 - medium * 3 - low;
  const health_score = Math.max(0, Math.min(100, rawScore));
  const total_findings = critical + high + medium + low;
  const top_risks: string[] = [];
  if ((findings.django_critical ?? 0) > 0) top_risks.push(`Django: ${findings.django_critical} critical security issues in settings.py`);
  if ((findings.circular_imports ?? 0) > 0) top_risks.push(`${findings.circular_imports} circular import cycles detected`);
  if ((findings.anti_patterns ?? 0) > 5) top_risks.push(`${findings.anti_patterns} Python anti-pattern matches`);
  if ((findings.orphan_tasks ?? 0) > 0) top_risks.push(`${findings.orphan_tasks} orphan Celery tasks (defined but never called)`);
  if ((findings.unpinned_deps ?? 0) > 0) top_risks.push(`${findings.unpinned_deps} unpinned dependencies`);
  if ((findings.dead_code ?? 0) > 10) top_risks.push(`${findings.dead_code} dead code candidates`);

  return {
    repo,
    duration_ms: Date.now() - startTime,
    checks_run: gates.map((gate) => gate.name),
    gates,
    summary: { total_findings, critical, high, medium, low, health_score, top_risks },
    findings,
  };
}
