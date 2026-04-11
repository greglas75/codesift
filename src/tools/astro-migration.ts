/**
 * astro_migration_check — Astro v5 → v6 breaking change detector.
 *
 * Scans a project for 10 known breaking changes (AM01–AM10) and emits a
 * structured migration report with per-issue effort estimates.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MigrationIssue {
  code: string;
  category: string;
  severity: "error" | "warning" | "info";
  message: string;
  files: string[];
  count: number;
  effort: "trivial" | "low" | "medium" | "high";
  migration_guide?: string;
}

export interface MigrationCheckResult {
  current_version: string | null;
  target_version: string;
  breaking_changes: MigrationIssue[];
  summary: {
    total_issues: number;
    by_effort: Record<string, number>;
    estimated_migration_hours: string;
  };
}

// ---------------------------------------------------------------------------
// Effort → hours map
// ---------------------------------------------------------------------------

const EFFORT_HOURS: Record<string, number> = {
  trivial: 0.1,
  low: 0.5,
  medium: 2,
  high: 4,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a file, returning null on any error. */
async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Parse package.json and return it, or null. */
async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  const content = await safeReadFile(join(root, "package.json"));
  if (!content) return null;
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract semver string from a version range like "^4.0.0" → "4.0.0". */
function parseVersion(raw: string): string {
  return raw.replace(/^[^0-9]*/, "").split("-")[0] ?? raw;
}

/**
 * Simple grep over a list of source files.
 * Returns { files: string[], count: number } for matches.
 */
function grepFiles(
  files: Array<{ path: string; content: string }>,
  pattern: RegExp,
): { files: string[]; count: number } {
  const hitFiles: string[] = [];
  let count = 0;
  for (const { path, content } of files) {
    const matches = content.match(new RegExp(pattern.source, `${pattern.flags.includes("g") ? "" : "g"}${pattern.flags.replace("g", "")}`));
    if (matches && matches.length > 0) {
      hitFiles.push(path);
      count += matches.length;
    }
  }
  return { files: hitFiles, count };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Extensions to scan for source-level checks. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".astro", ".md", ".mdx",
]);

/** Walk the project collecting relevant source files (capped for performance). */
async function collectSourceFiles(
  root: string,
  maxFiles = 5000,
): Promise<Array<{ path: string; content: string }>> {
  const { walkDirectory } = await import("../utils/walk.js");
  let paths: string[];
  try {
    paths = await walkDirectory(root, {
      fileFilter: (ext) => SOURCE_EXTENSIONS.has(ext),
      maxFiles,
      relative: true,
    });
  } catch {
    return [];
  }

  const results: Array<{ path: string; content: string }> = [];
  for (const relPath of paths) {
    const content = await safeReadFile(join(root, relPath));
    if (content !== null) results.push({ path: relPath, content });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Individual detectors
// ---------------------------------------------------------------------------

/**
 * AM01 — Astro.glob() usage
 * Replace with getCollection() or import.meta.glob()
 */
function detectAM01(files: Array<{ path: string; content: string }>): MigrationIssue | null {
  const { files: hitFiles, count } = grepFiles(files, /Astro\.glob\s*\(/);
  if (count === 0) return null;
  return {
    code: "AM01",
    category: "API removal",
    severity: "error",
    message: "Astro.glob() has been removed. Replace with getCollection() for content collections or import.meta.glob() for file imports.",
    files: hitFiles,
    count,
    effort: "low",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#removed-astroglob",
  };
}

/**
 * AM02 — emitESMImage() usage
 */
function detectAM02(files: Array<{ path: string; content: string }>): MigrationIssue | null {
  const { files: hitFiles, count } = grepFiles(files, /emitESMImage\s*\(/);
  if (count === 0) return null;
  return {
    code: "AM02",
    category: "API removal",
    severity: "error",
    message: "emitESMImage() has been removed. Use the new image optimization API instead.",
    files: hitFiles,
    count,
    effort: "low",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#removed-emitesmimage",
  };
}

/**
 * AM03 — <ViewTransitions /> component rename → <ClientRouter />
 */
function detectAM03(files: Array<{ path: string; content: string }>): MigrationIssue | null {
  const { files: hitFiles, count } = grepFiles(files, /<ViewTransitions\s*\/?>/);
  if (count === 0) return null;
  return {
    code: "AM03",
    category: "component rename",
    severity: "error",
    message: "<ViewTransitions /> has been renamed to <ClientRouter />. Update all usages and imports.",
    files: hitFiles,
    count,
    effort: "trivial",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#renamed-viewtransitions-to-clientrouter",
  };
}

/**
 * AM04 — Legacy content config path: src/content/config.ts
 * Should be moved to src/content.config.ts
 */
function detectAM04(root: string): MigrationIssue | null {
  const legacyPath = join(root, "src", "content", "config.ts");
  if (!existsSync(legacyPath)) return null;
  return {
    code: "AM04",
    category: "content collections",
    severity: "warning",
    message: "Legacy content config found at src/content/config.ts. Move to src/content.config.ts (project root) for Astro v6.",
    files: ["src/content/config.ts"],
    count: 1,
    effort: "medium",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#new-content-collections-config-location",
  };
}

/**
 * AM05 — type: "content" or type: "data" in defineCollection (v5 syntax)
 * Astro v6 uses a different collection type declaration.
 */
function detectAM05(files: Array<{ path: string; content: string }>): MigrationIssue | null {
  const configFiles = files.filter(
    (f) => f.path.includes("content.config") || f.path.includes("content/config"),
  );
  if (configFiles.length === 0) return null;
  const { files: hitFiles, count } = grepFiles(configFiles, /type\s*:\s*["'](content|data)["']/);
  if (count === 0) return null;
  return {
    code: "AM05",
    category: "content collections",
    severity: "warning",
    message: "defineCollection with type: 'content' or type: 'data' uses v5 syntax. Update to v6 collection type API.",
    files: hitFiles,
    count,
    effort: "medium",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#content-collections-api-changes",
  };
}

/**
 * AM06 — engines.node < 22 in package.json
 */
function detectAM06(pkg: Record<string, unknown> | null): MigrationIssue | null {
  if (!pkg) return null;
  const engines = pkg["engines"] as Record<string, string> | undefined;
  if (!engines?.node) return null;

  // Extract minimum version number from range like ">=18", "^18", "18", ">=18.0.0"
  const nodeRange = engines.node;
  const match = nodeRange.match(/(\d+)/);
  if (!match) return null;
  const minVersion = parseInt(match[1] ?? "0", 10);

  if (minVersion >= 22) return null;
  return {
    code: "AM06",
    category: "node version",
    severity: "error",
    message: `engines.node is "${nodeRange}" but Astro v6 requires Node.js >= 22. Update your package.json and CI configuration.`,
    files: ["package.json"],
    count: 1,
    effort: "low",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#nodejs-22-minimum",
  };
}

/**
 * AM07 — .refine() usage (may need updates for Zod 4 compatibility)
 */
function detectAM07(files: Array<{ path: string; content: string }>): MigrationIssue | null {
  const { files: hitFiles, count } = grepFiles(files, /\.refine\s*\(/);
  if (count === 0) return null;
  return {
    code: "AM07",
    category: "Zod 3",
    severity: "warning",
    message: ".refine() usage detected. Review for Zod 4 compatibility — the API may have changed for complex refinements.",
    files: hitFiles,
    count,
    effort: "medium",
    migration_guide: "https://zod.dev/v4",
  };
}

/**
 * AM08 — .nonempty() deprecated → .min(1)
 */
function detectAM08(files: Array<{ path: string; content: string }>): MigrationIssue | null {
  const { files: hitFiles, count } = grepFiles(files, /\.nonempty\s*\(/);
  if (count === 0) return null;
  return {
    code: "AM08",
    category: "Zod 3",
    severity: "warning",
    message: ".nonempty() is deprecated in Zod 4. Replace with .min(1).",
    files: hitFiles,
    count,
    effort: "low",
    migration_guide: "https://zod.dev/v4#nonempty-deprecated",
  };
}

/**
 * AM09 — output: "hybrid" in astro.config.* (now the default, no longer needed)
 */
function detectAM09(files: Array<{ path: string; content: string }>): MigrationIssue | null {
  const configFiles = files.filter((f) => /astro\.config\.(mjs|ts|cjs|js)$/.test(f.path));
  const { files: hitFiles, count } = grepFiles(configFiles, /output\s*:\s*["']hybrid["']/);
  if (count === 0) return null;
  return {
    code: "AM09",
    category: "output mode",
    severity: "info",
    message: "output: 'hybrid' is now the default in Astro v6. You can remove this explicit setting.",
    files: hitFiles,
    count,
    effort: "low",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#hybrid-output-is-now-default",
  };
}

/**
 * AM10 — @astrojs/lit imported (integration removed in v6)
 */
function detectAM10(pkg: Record<string, unknown> | null): MigrationIssue | null {
  if (!pkg) return null;
  const deps = {
    ...((pkg["dependencies"] as Record<string, string> | undefined) ?? {}),
    ...((pkg["devDependencies"] as Record<string, string> | undefined) ?? {}),
    ...((pkg["peerDependencies"] as Record<string, string> | undefined) ?? {}),
  };
  if (!deps["@astrojs/lit"]) return null;
  return {
    code: "AM10",
    category: "integration",
    severity: "error",
    message: "@astrojs/lit has been removed in Astro v6. Use Lit directly without the integration, or migrate to another component framework.",
    files: ["package.json"],
    count: 1,
    effort: "medium",
    migration_guide: "https://docs.astro.build/en/guides/upgrade-to/v6/#removed-astrjslit",
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function astroMigrationCheck(args: {
  repo?: string;
  target_version?: "6";
}): Promise<MigrationCheckResult> {
  // Resolve project root from repo identifier or from CWD via index.
  let root: string;

  if (args.repo) {
    // Try to resolve via CodeIndex
    const { getCodeIndex } = await import("./index-tools.js");
    const index = await getCodeIndex(args.repo);
    if (!index) throw new Error(`Repository "${args.repo}" not found. Run index_folder first.`);
    root = index.root;
  } else {
    // Fallback: use CWD
    root = process.cwd();
    // Try to auto-detect via index
    try {
      const { getCodeIndex } = await import("./index-tools.js");
      const index = await getCodeIndex(undefined as unknown as string);
      if (index) root = index.root;
    } catch {
      // Use CWD
    }
  }

  const targetVersion = args.target_version ?? "6";

  // 1. Read package.json
  const pkg = await readPackageJson(root);
  let currentVersion: string | null = null;
  if (pkg) {
    const deps = {
      ...((pkg["dependencies"] as Record<string, string> | undefined) ?? {}),
      ...((pkg["devDependencies"] as Record<string, string> | undefined) ?? {}),
    };
    const astroPkg = deps["astro"] ?? deps["astro-cdn"];
    if (astroPkg) currentVersion = parseVersion(astroPkg);
  }

  // 2. Collect source files for grep-based checks
  const sourceFiles = await collectSourceFiles(root);

  // 3. Run all detectors
  const detectors: Array<MigrationIssue | null> = [
    detectAM01(sourceFiles),
    detectAM02(sourceFiles),
    detectAM03(sourceFiles),
    detectAM04(root),
    detectAM05(sourceFiles),
    detectAM06(pkg),
    detectAM07(sourceFiles),
    detectAM08(sourceFiles),
    detectAM09(sourceFiles),
    detectAM10(pkg),
  ];

  const breakingChanges = detectors.filter((d): d is MigrationIssue => d !== null);

  // 4. Compute summary
  const byEffort: Record<string, number> = {};
  let totalHours = 0;
  for (const issue of breakingChanges) {
    byEffort[issue.effort] = (byEffort[issue.effort] ?? 0) + 1;
    totalHours += (EFFORT_HOURS[issue.effort] ?? 0) * issue.count;
  }

  // Round to 1 decimal place for display
  const hoursDisplay = totalHours < 0.5
    ? "< 0.5h"
    : `~${Math.round(totalHours * 10) / 10}h`;

  return {
    current_version: currentVersion,
    target_version: targetVersion,
    breaking_changes: breakingChanges,
    summary: {
      total_issues: breakingChanges.length,
      by_effort: byEffort,
      estimated_migration_hours: hoursDisplay,
    },
  };
}
