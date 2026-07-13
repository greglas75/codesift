/** Public facade for the compound Python project health check. */
import { getCodeIndex } from "./index-tools.js";
import { runCheck } from "./python-audit/runner.js";
import { aggregateAudit } from "./python-audit/aggregate.js";
import { runCircularImports } from "./python-audit/checks/circular-imports.js";
import { runDjangoSettings } from "./python-audit/checks/django-settings.js";
import { runAntiPatterns } from "./python-audit/checks/anti-patterns.js";
import { runFrameworkWiring } from "./python-audit/checks/framework-wiring.js";
import { runCelery } from "./python-audit/checks/celery.js";
import { runPytestFixtures } from "./python-audit/checks/pytest-fixtures.js";
import { runDependencies } from "./python-audit/checks/dependencies.js";
import { runDeadCode } from "./python-audit/checks/dead-code.js";
import type { CheckRun, PythonAuditOptions, PythonAuditResult } from "./python-audit/types.js";

export type { PythonAuditGate, PythonAuditResult, PythonAuditOptions } from "./python-audit/types.js";

const ALL_CHECKS = [
  "circular_imports", "django_settings", "anti_patterns", "framework_wiring",
  "celery", "pytest_fixtures", "dependencies", "dead_code",
];

export async function pythonAudit(repo: string, options?: PythonAuditOptions): Promise<PythonAuditResult> {
  const startTime = Date.now();
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const hasDjangoFiles = index.files.some((file) => /\/settings\.py$|\/settings\/[\w_]+\.py$/.test(file.path));
  const enabled = new Set(options?.checks ?? ALL_CHECKS);
  const filePattern = options?.file_pattern;
  const tasks: Array<Promise<CheckRun<unknown>>> = [];

  if (enabled.has("circular_imports")) tasks.push(runCheck("circular_imports", () => runCircularImports(repo, filePattern)));
  if (enabled.has("django_settings") && hasDjangoFiles) tasks.push(runCheck("django_settings", () => runDjangoSettings(repo)));
  if (enabled.has("anti_patterns")) tasks.push(runCheck("anti_patterns", () => runAntiPatterns(repo, filePattern)));
  if (enabled.has("framework_wiring")) tasks.push(runCheck("framework_wiring", () => runFrameworkWiring(repo, filePattern)));
  if (enabled.has("celery")) tasks.push(runCheck("celery", () => runCelery(repo, filePattern)));
  if (enabled.has("pytest_fixtures")) tasks.push(runCheck("pytest_fixtures", () => runPytestFixtures(repo, filePattern)));
  if (enabled.has("dependencies")) tasks.push(runCheck("dependencies", () => runDependencies(repo)));
  if (enabled.has("dead_code")) tasks.push(runCheck("dead_code", () => runDeadCode(repo)));

  const results = await Promise.all(tasks);
  return aggregateAudit(repo, startTime, results, enabled, hasDjangoFiles);
}
