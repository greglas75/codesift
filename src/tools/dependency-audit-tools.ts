/**
 * dependency_audit — composite tool that runs 4 dependency health checks
 * in parallel: vulnerabilities, licenses, freshness, and lockfile integrity.
 * Wraps existing CLI tools (npm/pnpm/yarn/bun audit + outdated).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import {
  CHECK_DEADLINE_MS,
  SEVERITY_RANK,
  type DependencyAuditResult,
  type FreshnessAggregate,
  type LicenseAggregate,
  type LockfileAggregate,
  type PackageManager,
  type Severity,
  type VulnerabilityAggregate as VulnAggregate,
} from "./dependency-audit-types.js";
import {
  checkDependencyVulnerabilities,
  emptyVulnerabilityAggregate,
} from "./dependency-audit-vulnerability-tools.js";
import { checkDependencyLicenses } from "./dependency-audit-license-tools.js";
import { checkDependencyFreshness } from "./dependency-audit-freshness-tools.js";
import { checkDependencyLockfile } from "./dependency-audit-lockfile-tools.js";

export type {
  DependencyAuditResult,
  LicenseInfo,
  LockfileIssue,
  OutdatedPackage,
  PackageManager,
  Severity,
  Vulnerability,
} from "./dependency-audit-types.js";

// ---------------------------------------------------------------------------
// Timeout helper — wraps a promise so a stuck sub-check can't block the whole audit
// ---------------------------------------------------------------------------

interface TimeoutSentinel { status: "timeout" }

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | TimeoutSentinel> {
  return new Promise<T | TimeoutSentinel>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ status: "timeout" }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isTimeout(v: unknown): v is TimeoutSentinel {
  return v != null
    && typeof v === "object"
    && "status" in v
    && (v as TimeoutSentinel).status === "timeout";
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error
      && ((error as { code?: unknown }).code === "ENOENT"
        || (error as { code?: unknown }).code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function detectPackageManager(workspace: string): Promise<PackageManager> {
  if (await fileExists(join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(workspace, "yarn.lock"))) return "yarn";
  if (await fileExists(join(workspace, "bun.lockb"))) return "bun";
  if (await fileExists(join(workspace, "bun.lock"))) return "bun";
  if (await fileExists(join(workspace, "package-lock.json"))) return "npm";
  return "unknown";
}

type SettledCheck<T> = PromiseSettledResult<T | TimeoutSentinel>;

function resolveCheck<T>(
  name: string,
  result: SettledCheck<T>,
  fallback: T,
  errors: string[],
): T {
  if (result.status === "rejected") {
    errors.push(`${name}: check failed`);
    return fallback;
  }
  if (isTimeout(result.value)) {
    errors.push(`${name}: check timed out`);
    return fallback;
  }
  return result.value;
}

async function runDependencyChecks(
  packageManager: PackageManager,
  workspace: string,
  minRank: number,
  skipLicenses: boolean,
  indexFiles: Array<{ path: string }>,
): Promise<[
  SettledCheck<VulnAggregate>,
  SettledCheck<LicenseAggregate>,
  SettledCheck<FreshnessAggregate>,
  SettledCheck<LockfileAggregate>,
]> {
  return Promise.allSettled([
    packageManager === "unknown"
      ? Promise.resolve<VulnAggregate>(emptyVulnerabilityAggregate())
      : withTimeout(
        checkDependencyVulnerabilities(packageManager, workspace, minRank),
        CHECK_DEADLINE_MS,
      ),
    skipLicenses
      ? Promise.resolve<LicenseAggregate>({ total: 0, problematic: [], distribution: {} })
      : withTimeout(checkDependencyLicenses(workspace, indexFiles), CHECK_DEADLINE_MS),
    packageManager === "unknown"
      ? Promise.resolve<FreshnessAggregate>({ outdated_count: 0, major_gaps: [] })
      : withTimeout(checkDependencyFreshness(packageManager, workspace), CHECK_DEADLINE_MS),
    withTimeout(checkDependencyLockfile(workspace, packageManager), CHECK_DEADLINE_MS),
  ]);
}

type DependencyCheckResults = Awaited<ReturnType<typeof runDependencyChecks>>;

function resolveDependencyCheckResults(
  results: DependencyCheckResults,
  errors: string[],
): Pick<DependencyAuditResult, "vulnerabilities" | "licenses" | "freshness" | "lockfile"> {
  const [vulnerabilityResult, licenseResult, freshnessResult, lockfileResult] = results;
  return {
    vulnerabilities: resolveCheck(
      "vulnerabilities",
      vulnerabilityResult,
      emptyVulnerabilityAggregate(),
      errors,
    ),
    licenses: resolveCheck(
      "licenses",
      licenseResult,
      { total: 0, problematic: [], distribution: {} },
      errors,
    ),
    freshness: resolveCheck(
      "freshness",
      freshnessResult,
      { outdated_count: 0, major_gaps: [] },
      errors,
    ),
    lockfile: resolveCheck(
      "lockfile",
      lockfileResult,
      { present: false, issues: [] },
      errors,
    ),
  };
}

// ---------------------------------------------------------------------------
// Sub-check 1: vulnerabilities (npm/pnpm/yarn/bun audit --json)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sub-check 2: licenses (scan node_modules/*/package.json via the index)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sub-check 3: freshness (npm outdated --json)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sub-check 4: lockfile integrity
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main composite tool
// ---------------------------------------------------------------------------

export async function dependencyAudit(
  repo: string,
  options?: {
    workspace_path?: string;
    skip_licenses?: boolean;
    min_severity?: Severity;
  },
): Promise<DependencyAuditResult> {
  const startMs = Date.now();

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  if (options?.workspace_path !== undefined && options.workspace_path.trim() === "") {
    throw new Error("workspace_path must not be empty");
  }
  const workspace = options?.workspace_path ?? index.root;
  const minRank = SEVERITY_RANK[options?.min_severity ?? "low"];
  const skipLicenses = options?.skip_licenses === true;

  const pm = await detectPackageManager(workspace);

  const errors: string[] = [];

  const checkResults = await runDependencyChecks(
    pm,
    workspace,
    minRank,
    skipLicenses,
    index.files,
  );
  const resolved = resolveDependencyCheckResults(checkResults, errors);

  if (pm === "unknown") {
    errors.push("package_manager: could not detect from lockfile");
  }

  return {
    workspace,
    package_manager: pm,
    ...resolved,
    duration_ms: Date.now() - startMs,
    errors,
  };
}
