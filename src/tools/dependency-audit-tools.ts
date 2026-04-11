/**
 * dependency_audit — composite tool that runs 4 dependency health checks
 * in parallel: vulnerabilities, licenses, freshness, and lockfile integrity.
 * Wraps existing CLI tools (npm/pnpm/yarn/bun audit + outdated).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "low" | "moderate" | "high" | "critical";

export interface Vulnerability {
  package: string;
  severity: Severity;
  via: string[];
  fix_available: boolean;
  advisory_url?: string;
}

export interface LicenseInfo {
  package: string;
  license: string;
  is_problematic: boolean; // GPL/AGPL/SSPL/copyleft
}

export interface OutdatedPackage {
  package: string;
  current: string;
  latest: string;
  major_gap: number;
}

export interface LockfileIssue {
  type: "missing" | "drift" | "duplicate";
  package?: string;
  message: string;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface DependencyAuditResult {
  workspace: string;
  package_manager: PackageManager;
  vulnerabilities: {
    total: number;
    by_severity: { critical: number; high: number; moderate: number; low: number };
    findings: Vulnerability[]; // top 20
  };
  licenses: {
    total: number;
    problematic: LicenseInfo[];
    distribution: Record<string, number>;
  };
  freshness: {
    outdated_count: number;
    major_gaps: OutdatedPackage[]; // top 20
  };
  lockfile: {
    present: boolean;
    issues: LockfileIssue[];
  };
  duration_ms: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECK_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB — npm audit can be large
const TOP_N = 20;

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

// GPL, AGPL, LGPL, SSPL, EUPL, OSL family → copyleft/problematic for many orgs
const PROBLEMATIC_LICENSE_PATTERNS = [
  /^GPL(-|$)/i,
  /^AGPL(-|$)/i,
  /^LGPL(-|$)/i,
  /^SSPL(-|$)/i,
  /^EUPL(-|$)/i,
  /^OSL(-|$)/i,
  /^CC-BY-NC/i,
  /copyleft/i,
];

// ---------------------------------------------------------------------------
// Timeout helper — wraps a promise so a stuck sub-check can't block the whole audit
// ---------------------------------------------------------------------------

interface TimeoutSentinel { status: "timeout" }

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | TimeoutSentinel> {
  return Promise.race([
    promise,
    new Promise<TimeoutSentinel>((resolve) =>
      setTimeout(() => resolve({ status: "timeout" }), ms),
    ),
  ]);
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
  } catch {
    return false;
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

function lockfileName(pm: PackageManager): string | null {
  switch (pm) {
    case "npm": return "package-lock.json";
    case "pnpm": return "pnpm-lock.yaml";
    case "yarn": return "yarn.lock";
    case "bun": return "bun.lockb";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-check 1: vulnerabilities (npm/pnpm/yarn/bun audit --json)
// ---------------------------------------------------------------------------

interface VulnAggregate {
  total: number;
  by_severity: { critical: number; high: number; moderate: number; low: number };
  findings: Vulnerability[];
}

function emptyVulnAggregate(): VulnAggregate {
  return {
    total: 0,
    by_severity: { critical: 0, high: 0, moderate: 0, low: 0 },
    findings: [],
  };
}

function normalizeSeverity(raw: unknown): Severity | null {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s === "critical" || s === "high" || s === "moderate" || s === "low") {
    return s;
  }
  // npm sometimes emits "info" — treat as low
  if (s === "info") return "low";
  return null;
}

function parseNpmAudit(stdout: string, minRank: number): VulnAggregate {
  const agg = emptyVulnAggregate();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return agg;
  }

  if (!parsed || typeof parsed !== "object") return agg;
  const vulns = (parsed as { vulnerabilities?: unknown }).vulnerabilities;
  if (!vulns || typeof vulns !== "object") return agg;

  for (const [pkg, data] of Object.entries(vulns as Record<string, unknown>)) {
    if (!data || typeof data !== "object") continue;
    const entry = data as {
      severity?: unknown;
      via?: unknown;
      fixAvailable?: unknown;
      url?: unknown;
    };

    const severity = normalizeSeverity(entry.severity);
    if (!severity) continue;
    if (SEVERITY_RANK[severity] < minRank) continue;

    // `via` can be an array of strings or objects (when transitive)
    const viaRaw = Array.isArray(entry.via) ? entry.via : [];
    const via: string[] = viaRaw.map((v) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "name" in v && typeof (v as { name: unknown }).name === "string") {
        return (v as { name: string }).name;
      }
      return "";
    }).filter((s) => s.length > 0);

    // fixAvailable may be boolean or an object
    const fixAvailable = entry.fixAvailable === true
      || (entry.fixAvailable !== undefined && entry.fixAvailable !== false
        && typeof entry.fixAvailable === "object" && entry.fixAvailable !== null);

    agg.total++;
    agg.by_severity[severity]++;

    const finding: Vulnerability = {
      package: pkg,
      severity,
      via,
      fix_available: fixAvailable,
    };
    if (typeof entry.url === "string" && entry.url.length > 0) {
      finding.advisory_url = entry.url;
    }
    agg.findings.push(finding);
  }

  // Sort by severity (critical first), then by package name
  agg.findings.sort((a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || a.package.localeCompare(b.package));
  agg.findings = agg.findings.slice(0, TOP_N);

  return agg;
}

async function runAudit(
  pm: PackageManager,
  workspace: string,
  minRank: number,
): Promise<VulnAggregate> {
  if (pm === "unknown") {
    throw new Error("cannot run audit: unknown package manager");
  }

  // All supported package managers accept `audit --json`
  const args = ["audit", "--json"];

  // execFile with non-zero exit is treated as error, but npm audit exits
  // non-zero when vulnerabilities are found. We still want the stdout.
  try {
    const { stdout } = await execFileAsync(pm, args, {
      cwd: workspace,
      maxBuffer: MAX_BUFFER,
      timeout: CHECK_TIMEOUT_MS,
      // Don't inherit the parent's TTY; force non-interactive output
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    });
    return parseNpmAudit(stdout, minRank);
  } catch (err: unknown) {
    // Non-zero exit is normal if vulns exist; stdout may still hold the JSON
    if (err && typeof err === "object" && "stdout" in err) {
      const stdout = (err as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.trim().length > 0) {
        return parseNpmAudit(stdout, minRank);
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sub-check 2: licenses (scan node_modules/*/package.json via the index)
// ---------------------------------------------------------------------------

interface LicenseAggregate {
  total: number;
  problematic: LicenseInfo[];
  distribution: Record<string, number>;
}

function isProblematicLicense(license: string): boolean {
  return PROBLEMATIC_LICENSE_PATTERNS.some((pat) => pat.test(license));
}

function normalizeLicenseField(raw: unknown): string {
  if (typeof raw === "string") return raw;
  // SPDX object form: { type: "MIT" }
  if (raw && typeof raw === "object") {
    const obj = raw as { type?: unknown };
    if (typeof obj.type === "string") return obj.type;
  }
  return "UNKNOWN";
}

async function scanLicenses(
  workspace: string,
  indexFiles: Array<{ path: string }>,
): Promise<LicenseAggregate> {
  const agg: LicenseAggregate = {
    total: 0,
    problematic: [],
    distribution: {},
  };

  // Look for node_modules/<pkg>/package.json entries in the index.
  // Scoped packages: node_modules/@scope/pkg/package.json (depth 3)
  // Regular:        node_modules/pkg/package.json (depth 2)
  const pkgManifests = indexFiles.filter((f) => {
    if (!f.path.includes("node_modules/")) return false;
    if (!f.path.endsWith("/package.json")) return false;
    // Strip everything up to and including "node_modules/"
    const idx = f.path.lastIndexOf("node_modules/");
    const tail = f.path.slice(idx + "node_modules/".length);
    const parts = tail.split("/");
    // Regular: ["pkg", "package.json"] (2 parts)
    // Scoped:  ["@scope", "pkg", "package.json"] (3 parts)
    if (parts.length === 2) return true;
    if (parts.length === 3 && parts[0]!.startsWith("@")) return true;
    return false;
  });

  for (const file of pkgManifests) {
    try {
      const absPath = join(workspace, file.path);
      const source = await readFile(absPath, "utf-8");
      const json = JSON.parse(source) as { name?: unknown; license?: unknown; licenses?: unknown };

      const pkgName = typeof json.name === "string" ? json.name : file.path;

      // Prefer `license` (SPDX), fall back to legacy `licenses` array
      let license = "UNKNOWN";
      if (json.license !== undefined) {
        license = normalizeLicenseField(json.license);
      } else if (Array.isArray(json.licenses) && json.licenses.length > 0) {
        license = normalizeLicenseField(json.licenses[0]);
      }

      agg.total++;
      agg.distribution[license] = (agg.distribution[license] ?? 0) + 1;

      if (isProblematicLicense(license)) {
        agg.problematic.push({
          package: pkgName,
          license,
          is_problematic: true,
        });
      }
    } catch {
      // Skip unreadable / malformed manifests
    }
  }

  return agg;
}

// ---------------------------------------------------------------------------
// Sub-check 3: freshness (npm outdated --json)
// ---------------------------------------------------------------------------

interface FreshnessAggregate {
  outdated_count: number;
  major_gaps: OutdatedPackage[];
}

function parseMajor(version: string): number | null {
  const cleaned = version.replace(/^[\^~>=<v\s]+/, "");
  const first = cleaned.split(".")[0];
  if (!first) return null;
  const num = parseInt(first, 10);
  return Number.isNaN(num) ? null : num;
}

function parseOutdated(stdout: string): FreshnessAggregate {
  const agg: FreshnessAggregate = { outdated_count: 0, major_gaps: [] };
  if (!stdout.trim()) return agg;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return agg;
  }

  if (!parsed || typeof parsed !== "object") return agg;

  const entries: OutdatedPackage[] = [];
  for (const [pkg, data] of Object.entries(parsed as Record<string, unknown>)) {
    if (!data || typeof data !== "object") continue;
    const entry = data as { current?: unknown; latest?: unknown };

    const current = typeof entry.current === "string" ? entry.current : "";
    const latest = typeof entry.latest === "string" ? entry.latest : "";
    if (!current || !latest) continue;

    const currMajor = parseMajor(current);
    const latestMajor = parseMajor(latest);
    const gap = currMajor !== null && latestMajor !== null
      ? Math.max(0, latestMajor - currMajor)
      : 0;

    entries.push({
      package: pkg,
      current,
      latest,
      major_gap: gap,
    });
  }

  agg.outdated_count = entries.length;
  entries.sort((a, b) => b.major_gap - a.major_gap || a.package.localeCompare(b.package));
  agg.major_gaps = entries.slice(0, TOP_N);
  return agg;
}

async function runOutdated(
  pm: PackageManager,
  workspace: string,
): Promise<FreshnessAggregate> {
  if (pm === "unknown") {
    throw new Error("cannot run outdated: unknown package manager");
  }

  // npm/pnpm/yarn/bun all accept `outdated --json`. Yarn Classic emits NDJSON
  // (different schema); we only support the modern JSON form here.
  const args = ["outdated", "--json"];

  try {
    const { stdout } = await execFileAsync(pm, args, {
      cwd: workspace,
      maxBuffer: MAX_BUFFER,
      timeout: CHECK_TIMEOUT_MS,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    });
    return parseOutdated(stdout);
  } catch (err: unknown) {
    // `npm outdated` exits 1 when outdated packages exist, but stdout still has JSON
    if (err && typeof err === "object" && "stdout" in err) {
      const stdout = (err as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.trim().length > 0) {
        return parseOutdated(stdout);
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sub-check 4: lockfile integrity
// ---------------------------------------------------------------------------

interface LockfileAggregate {
  present: boolean;
  issues: LockfileIssue[];
}

function cleanVersionRange(range: string): string {
  return range.replace(/^[\^~>=<v\s]+/, "").trim();
}

function versionSatisfiesManifest(manifestRange: string, installed: string): boolean {
  // Lightweight check: caret/tilde compatibility on the major.
  const cleaned = cleanVersionRange(manifestRange);
  const manifestMajor = parseMajor(cleaned);
  const installedMajor = parseMajor(installed);
  if (manifestMajor === null || installedMajor === null) return true;
  // Accept exact equality of major version as "in range" for drift detection
  return manifestMajor === installedMajor;
}

async function checkLockfile(
  workspace: string,
  pm: PackageManager,
): Promise<LockfileAggregate> {
  const agg: LockfileAggregate = { present: false, issues: [] };

  const lockName = lockfileName(pm);
  if (!lockName) {
    agg.issues.push({
      type: "missing",
      message: "No supported lockfile found",
    });
    return agg;
  }

  const lockPath = join(workspace, lockName);
  if (!(await fileExists(lockPath))) {
    agg.issues.push({
      type: "missing",
      message: `Lockfile ${lockName} is missing`,
    });
    return agg;
  }
  agg.present = true;

  // Only npm (package-lock.json v2+) is parsed in detail here; others just
  // report presence and skip deep drift/duplicate analysis.
  if (pm !== "npm") return agg;

  let manifest: Record<string, unknown> = {};
  try {
    const manifestSrc = await readFile(join(workspace, "package.json"), "utf-8");
    manifest = JSON.parse(manifestSrc) as Record<string, unknown>;
  } catch {
    agg.issues.push({
      type: "missing",
      message: "package.json could not be read",
    });
    return agg;
  }

  let lock: {
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string }>;
  } = {};
  try {
    const lockSrc = await readFile(lockPath, "utf-8");
    lock = JSON.parse(lockSrc);
  } catch {
    agg.issues.push({
      type: "missing",
      message: `Lockfile ${lockName} could not be parsed`,
    });
    return agg;
  }

  // Declared deps from manifest
  const declared: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const bag = manifest[field];
    if (bag && typeof bag === "object") {
      for (const [name, range] of Object.entries(bag as Record<string, unknown>)) {
        if (typeof range === "string") declared[name] = range;
      }
    }
  }

  // Walk installed versions from `packages` (v2+). Root entry has key "" —
  // every other key starts with "node_modules/".
  const installedVersions = new Map<string, Set<string>>();
  const packages = lock.packages ?? {};
  for (const [key, data] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/")) continue;
    const lastIdx = key.lastIndexOf("node_modules/");
    const tail = key.slice(lastIdx + "node_modules/".length);
    // Scoped names include a slash
    const parts = tail.split("/");
    let name: string;
    if (parts.length >= 2 && parts[0]!.startsWith("@")) {
      name = `${parts[0]}/${parts[1]}`;
    } else {
      name = parts[0]!;
    }
    if (!name) continue;
    const version = data && typeof data === "object" && "version" in data
      && typeof (data as { version?: unknown }).version === "string"
      ? (data as { version: string }).version
      : null;
    if (!version) continue;
    if (!installedVersions.has(name)) installedVersions.set(name, new Set());
    installedVersions.get(name)!.add(version);
  }

  // Detect drift: manifest says ^1.x but installed is 0.x
  for (const [name, range] of Object.entries(declared)) {
    const versions = installedVersions.get(name);
    if (!versions || versions.size === 0) {
      agg.issues.push({
        type: "missing",
        package: name,
        message: `${name} declared in package.json but not present in lockfile`,
      });
      continue;
    }
    for (const installed of versions) {
      if (!versionSatisfiesManifest(range, installed)) {
        agg.issues.push({
          type: "drift",
          package: name,
          message: `${name}: manifest range ${range} does not match installed ${installed}`,
        });
      }
    }
  }

  // Detect duplicates: same package name appearing with multiple versions in the tree
  for (const [name, versions] of installedVersions) {
    if (versions.size > 1) {
      agg.issues.push({
        type: "duplicate",
        package: name,
        message: `${name} installed with ${versions.size} different versions: ${[...versions].join(", ")}`,
      });
    }
  }

  return agg;
}

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

  const workspace = options?.workspace_path ?? index.root;
  const minRank = SEVERITY_RANK[options?.min_severity ?? "low"];
  const skipLicenses = options?.skip_licenses === true;

  const pm = await detectPackageManager(workspace);

  const errors: string[] = [];

  // Fan out 4 checks in parallel with per-check timeout
  const [vulnRes, licenseRes, freshRes, lockRes] = await Promise.allSettled([
    pm === "unknown"
      ? Promise.resolve<VulnAggregate>(emptyVulnAggregate())
      : withTimeout(runAudit(pm, workspace, minRank), CHECK_TIMEOUT_MS),
    skipLicenses
      ? Promise.resolve<LicenseAggregate>({ total: 0, problematic: [], distribution: {} })
      : withTimeout(scanLicenses(workspace, index.files), CHECK_TIMEOUT_MS),
    pm === "unknown"
      ? Promise.resolve<FreshnessAggregate>({ outdated_count: 0, major_gaps: [] })
      : withTimeout(runOutdated(pm, workspace), CHECK_TIMEOUT_MS),
    withTimeout(checkLockfile(workspace, pm), CHECK_TIMEOUT_MS),
  ]);

  // Extract results — any failure becomes an error[] entry, never crashes the audit
  let vulnerabilities: VulnAggregate = emptyVulnAggregate();
  if (vulnRes.status === "fulfilled") {
    if (isTimeout(vulnRes.value)) {
      errors.push("vulnerabilities: check timed out");
    } else {
      vulnerabilities = vulnRes.value as VulnAggregate;
    }
  } else {
    errors.push(`vulnerabilities: ${vulnRes.reason instanceof Error ? vulnRes.reason.message : String(vulnRes.reason)}`);
  }

  let licenses: LicenseAggregate = { total: 0, problematic: [], distribution: {} };
  if (licenseRes.status === "fulfilled") {
    if (isTimeout(licenseRes.value)) {
      errors.push("licenses: check timed out");
    } else {
      licenses = licenseRes.value as LicenseAggregate;
    }
  } else {
    errors.push(`licenses: ${licenseRes.reason instanceof Error ? licenseRes.reason.message : String(licenseRes.reason)}`);
  }

  let freshness: FreshnessAggregate = { outdated_count: 0, major_gaps: [] };
  if (freshRes.status === "fulfilled") {
    if (isTimeout(freshRes.value)) {
      errors.push("freshness: check timed out");
    } else {
      freshness = freshRes.value as FreshnessAggregate;
    }
  } else {
    errors.push(`freshness: ${freshRes.reason instanceof Error ? freshRes.reason.message : String(freshRes.reason)}`);
  }

  let lockfile: LockfileAggregate = { present: false, issues: [] };
  if (lockRes.status === "fulfilled") {
    if (isTimeout(lockRes.value)) {
      errors.push("lockfile: check timed out");
    } else {
      lockfile = lockRes.value as LockfileAggregate;
    }
  } else {
    errors.push(`lockfile: ${lockRes.reason instanceof Error ? lockRes.reason.message : String(lockRes.reason)}`);
  }

  if (pm === "unknown") {
    errors.push("package_manager: could not detect from lockfile");
  }

  return {
    workspace,
    package_manager: pm,
    vulnerabilities,
    licenses,
    freshness,
    lockfile,
    duration_ms: Date.now() - startMs,
    errors,
  };
}
