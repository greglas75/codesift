/**
 * analyze_python_deps — Python dependency freshness and vulnerability check.
 *
 * Parses pyproject.toml (via parsePyproject) and optionally requirements.txt,
 * then queries PyPI JSON API for latest versions to flag outdated packages.
 * Optionally queries OSV.dev for known vulnerabilities.
 *
 * Runs offline-safe: if PyPI/OSV unreachable, returns what's in the manifest
 * without upstream data (marked as "check_skipped").
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { parsePyproject } from "./pyproject-tools.js";

export interface DependencyStatus {
  name: string;
  declared_version: string;    // version constraint from manifest
  latest_version?: string;     // latest on PyPI, if fetched
  status: "current" | "outdated" | "major-outdated" | "unknown" | "unpinned";
  severity?: "info" | "warning" | "error";
  reason?: string;
  vulnerabilities?: Array<{ id: string; summary: string; severity?: string }>;
}

export interface DepsAnalysisResult {
  source: string;              // pyproject.toml or requirements.txt
  total: number;
  pypi_checked: boolean;
  vuln_checked: boolean;
  dependencies: DependencyStatus[];
  outdated_count: number;
  unpinned_count: number;
  vulnerable_count: number;
}

/**
 * Analyze Python dependencies from pyproject.toml or requirements.txt.
 */
export async function analyzePythonDeps(
  repo: string,
  options?: {
    check_pypi?: boolean;      // default false — opt-in network
    check_vulns?: boolean;     // default false — opt-in network
    file_pattern?: string;
  },
): Promise<DepsAnalysisResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const checkPypi = options?.check_pypi ?? false;
  const checkVulns = options?.check_vulns ?? false;

  // First try pyproject.toml
  let deps: Array<{ name: string; version: string }> = [];
  let source = "pyproject.toml";

  try {
    const info = await parsePyproject(repo);
    if (info && info.dependencies.length > 0) {
      deps = info.dependencies;
    }
  } catch {
    // Fall through to requirements.txt
  }

  // Fall back to requirements.txt
  if (deps.length === 0) {
    try {
      const content = await readFile(join(index.root, "requirements.txt"), "utf-8");
      deps = parseRequirementsTxt(content);
      source = "requirements.txt";
    } catch {
      return {
        source: "none",
        total: 0,
        pypi_checked: false,
        vuln_checked: false,
        dependencies: [],
        outdated_count: 0,
        unpinned_count: 0,
        vulnerable_count: 0,
      };
    }
  }

  // Analyze each dependency
  const statuses: DependencyStatus[] = [];
  let pypiChecked = false;
  let vulnChecked = false;

  for (const dep of deps) {
    const status: DependencyStatus = {
      name: dep.name,
      declared_version: dep.version,
      status: "unknown",
    };

    // Classify pin status
    if (dep.version === "*" || dep.version === "") {
      status.status = "unpinned";
      status.severity = "warning";
      status.reason = "No version constraint — any version allowed";
    }

    // Optional PyPI check
    if (checkPypi) {
      try {
        const latest = await fetchLatestPypiVersion(dep.name);
        if (latest) {
          status.latest_version = latest;
          pypiChecked = true;
          const compared = compareVersions(dep.version, latest);
          if (compared === "outdated-major") {
            status.status = "major-outdated";
            status.severity = "error";
            status.reason = `Major version behind: ${dep.version} vs ${latest}`;
          } else if (compared === "outdated-minor") {
            status.status = "outdated";
            status.severity = "warning";
            status.reason = `Minor/patch behind: ${dep.version} vs ${latest}`;
          } else if (compared === "current") {
            status.status = "current";
          }
        }
      } catch {
        // Network/API failure — leave as unknown
      }
    }

    // Optional OSV vulnerability check
    if (checkVulns) {
      try {
        const vulns = await fetchOsvVulnerabilities(dep.name, dep.version);
        if (vulns.length > 0) {
          status.vulnerabilities = vulns;
          status.severity = "error";
          vulnChecked = true;
        }
      } catch {
        // Leave empty
      }
    }

    statuses.push(status);
  }

  const outdated_count = statuses.filter(
    (s) => s.status === "outdated" || s.status === "major-outdated",
  ).length;
  const unpinned_count = statuses.filter((s) => s.status === "unpinned").length;
  const vulnerable_count = statuses.filter(
    (s) => s.vulnerabilities && s.vulnerabilities.length > 0,
  ).length;

  return {
    source,
    total: statuses.length,
    pypi_checked: pypiChecked,
    vuln_checked: vulnChecked,
    dependencies: statuses,
    outdated_count,
    unpinned_count,
    vulnerable_count,
  };
}

/**
 * Parse a requirements.txt file into name/version pairs.
 * Exported for testing.
 */
export function parseRequirementsTxt(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("-") || line.startsWith("git+") || line.startsWith("http")) continue;

    // Parse: `package==1.2.3`, `package>=1.2`, `package[extra]>=1.0`, `package`
    const match = line.match(/^([a-zA-Z0-9][\w.-]*)(?:\[[\w,]+\])?\s*(.*?)(?:\s*(?:#.*)?)?$/);
    if (!match) continue;
    const name = match[1]!;
    const version = match[2]?.trim() || "*";
    deps.push({ name, version });
  }
  return deps;
}

/**
 * Fetch the latest version of a package from PyPI.
 */
async function fetchLatestPypiVersion(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { info?: { version?: string } };
    return data.info?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch known vulnerabilities for a package/version from OSV.dev.
 */
async function fetchOsvVulnerabilities(
  name: string,
  version: string,
): Promise<Array<{ id: string; summary: string; severity?: string }>> {
  // Strip constraint operators (>=, ~=, etc.) to get a concrete version
  const versionOnly = version.replace(/^[><=~!^]+\s*/, "").split(/[,;]/)[0]!.trim();
  if (!versionOnly) return [];

  try {
    const res = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        package: { name, ecosystem: "PyPI" },
        version: versionOnly,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      vulns?: Array<{ id: string; summary?: string; database_specific?: { severity?: string } }>;
    };
    return (data.vulns ?? []).map((v) => {
      const vuln: { id: string; summary: string; severity?: string } = {
        id: v.id,
        summary: v.summary ?? "",
      };
      if (v.database_specific?.severity) vuln.severity = v.database_specific.severity;
      return vuln;
    });
  } catch {
    return [];
  }
}

/**
 * Compare a version constraint to the latest version.
 * Returns: "current", "outdated-minor", "outdated-major", or "unknown".
 * Exported for testing.
 */
export function compareVersions(
  constraint: string,
  latest: string,
): "current" | "outdated-minor" | "outdated-major" | "unknown" {
  // Extract the minimum version from the constraint
  const versionMatch = constraint.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!versionMatch) return "unknown";
  const declaredMajor = Number(versionMatch[1]);
  const declaredMinor = Number(versionMatch[2]);

  const latestMatch = latest.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!latestMatch) return "unknown";
  const latestMajor = Number(latestMatch[1]);
  const latestMinor = Number(latestMatch[2]);

  if (latestMajor > declaredMajor) return "outdated-major";
  if (latestMajor === declaredMajor && latestMinor > declaredMinor) return "outdated-minor";
  return "current";
}
