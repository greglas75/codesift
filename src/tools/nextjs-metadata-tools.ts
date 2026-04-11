/**
 * Next.js metadata audit (T1).
 *
 * Walks `app/**\/page.{tsx,jsx,ts,js}` files for `metadata` /
 * `generateMetadata` exports, scores each page using a weighted formula
 * (per design D4), and aggregates a per-route audit result with grade
 * distribution and top issues.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  deriveUrlPath,
  discoverWorkspaces,
  parseMetadataExport,
  type MetadataFields,
} from "../utils/nextjs.js";
import { parseFile } from "../parser/parser-manager.js";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetadataGrade = "poor" | "needs_work" | "good" | "excellent";

export interface MetadataField {
  name: string;
  present: boolean;
  weight: number;
}

export interface MetadataScore {
  score: number;
  grade: MetadataGrade;
  violations: string[];
}

export interface NextjsMetadataAuditEntry {
  url_path: string;
  file_path: string;
  score: number;
  grade: MetadataGrade;
  violations: string[];
  missing_fields: string[];
}

export interface NextjsMetadataAuditCounts {
  excellent: number;
  good: number;
  needs_work: number;
  poor: number;
}

export interface NextjsMetadataAuditResult {
  total_pages: number;
  scores: NextjsMetadataAuditEntry[];
  counts: NextjsMetadataAuditCounts;
  top_issues: string[];
  workspaces_scanned: string[];
  parse_failures: string[];
  scan_errors: string[];
  limitations: string[];
}

export interface NextjsMetadataAuditOptions {
  workspace?: string | undefined;
  max_routes?: number | undefined;
}

// Re-export for downstream consumers
export type { MetadataFields };

// ---------------------------------------------------------------------------
// Pure scoring function (Task 9)
// ---------------------------------------------------------------------------

/** Field weights per design D4. Sum = 100. */
export const METADATA_WEIGHTS = {
  title: 25,
  description: 20,
  og_image: 20,
  canonical: 15,
  twitter: 10,
  json_ld: 10,
} as const;

const TITLE_MIN_LENGTH = 10;
const DESCRIPTION_MIN_LENGTH = 50;

/** Substrings that mark an OG image as a placeholder, not a real per-route asset. */
const PLACEHOLDER_OG_IMAGES = ["/og-image.png", "/favicon.ico", ""];

function isPlaceholderOgImage(url: string): boolean {
  if (!url || url.trim() === "") return true;
  return PLACEHOLDER_OG_IMAGES.includes(url);
}

function gradeFromScore(score: number): MetadataGrade {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 40) return "needs_work";
  return "poor";
}

/**
 * Score a `MetadataFields` object against the weighted rubric (D4).
 *
 * Pure function — no I/O, no AST. Returns a numeric score 0-100, a grade
 * bucket, and a list of violation tags. Length gates zero out title/desc
 * scores when below thresholds. Placeholder OG images zero out the OG image
 * score and flag a violation.
 */
export function scoreMetadata(fields: MetadataFields): MetadataScore {
  let score = 0;
  const violations: string[] = [];

  // Title (weight 25, length gate)
  if (fields.title) {
    if (fields.title.length >= TITLE_MIN_LENGTH) {
      score += METADATA_WEIGHTS.title;
    } else {
      violations.push("title_too_short");
    }
  }

  // Description (weight 20, length gate)
  if (fields.description) {
    if (fields.description.length >= DESCRIPTION_MIN_LENGTH) {
      score += METADATA_WEIGHTS.description;
    } else {
      violations.push("description_too_short");
    }
  }

  // Open Graph image (weight 20, placeholder check)
  const ogImage = fields.openGraph?.images?.[0];
  if (ogImage) {
    if (isPlaceholderOgImage(ogImage)) {
      violations.push("og_image_placeholder");
    } else {
      score += METADATA_WEIGHTS.og_image;
    }
  }

  // Canonical (weight 15)
  if (fields.alternates?.canonical) {
    score += METADATA_WEIGHTS.canonical;
  }

  // Twitter card (weight 10)
  if (fields.twitter?.card) {
    score += METADATA_WEIGHTS.twitter;
  }

  // JSON-LD (weight 10) — detected via the `other` catch-all
  if (fields.other && Object.keys(fields.other).length > 0) {
    score += METADATA_WEIGHTS.json_ld;
  }

  return {
    score,
    grade: gradeFromScore(score),
    violations,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator (Task 10)
// ---------------------------------------------------------------------------

const PAGE_FILENAME_RE = /(^|\/)page\.(tsx|jsx|ts|js)$/;
const PAGE_EXTS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const DEFAULT_MAX_ROUTES = 1000;
const PARSE_CONCURRENCY = 10;
const MAX_FILE_SIZE_BYTES = 2_097_152;

/** Compute the union of present-but-zero / missing fields per the scorer rubric. */
function missingFieldsFor(fields: MetadataFields, score: MetadataScore): string[] {
  const missing: string[] = [];
  if (!fields.title) missing.push("title");
  if (!fields.description) missing.push("description");
  if (!fields.openGraph?.images?.[0]) missing.push("og_image");
  if (!fields.alternates?.canonical) missing.push("canonical");
  if (!fields.twitter?.card) missing.push("twitter");
  if (!fields.other || Object.keys(fields.other).length === 0) missing.push("json_ld");
  // Length-gate violations also count as missing for reporter purposes.
  if (score.violations.includes("title_too_short") && !missing.includes("title")) {
    missing.push("title");
  }
  if (score.violations.includes("description_too_short") && !missing.includes("description")) {
    missing.push("description");
  }
  return missing;
}

/**
 * Audit a Next.js project's metadata coverage. Walks app/page.* files,
 * extracts metadata via tree-sitter, scores each page, and returns a per-route
 * + aggregate report.
 */
export async function nextjsMetadataAudit(
  repo: string,
  options?: NextjsMetadataAuditOptions,
): Promise<NextjsMetadataAuditResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_metadata_audit")) {
    throw new Error("nextjs_metadata_audit is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  // Resolve workspaces
  let workspaces: string[];
  if (options?.workspace) {
    workspaces = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaces = discovered.length > 0 ? discovered.map((w) => w.root) : [projectRoot];
  }

  const maxRoutes = options?.max_routes ?? DEFAULT_MAX_ROUTES;
  const scores: NextjsMetadataAuditEntry[] = [];
  const parse_failures: string[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];
  const top_issues_counter = new Map<string, number>();

  for (const workspace of workspaces) {
    workspaces_scanned.push(workspace);

    const candidates: string[] = [];
    for (const appDir of ["app", "src/app"]) {
      const fullAppDir = join(workspace, appDir);
      try {
        const walked = await walkDirectory(fullAppDir, {
          followSymlinks: true,
          fileFilter: (ext) => PAGE_EXTS.has(ext),
          maxFileSize: MAX_FILE_SIZE_BYTES,
        });
        for (const f of walked) {
          if (PAGE_FILENAME_RE.test(f)) candidates.push(f);
        }
      } catch (err) {
        scan_errors.push(`${fullAppDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const remaining = maxRoutes - scores.length;
    const toProcess = candidates.slice(0, Math.max(0, remaining));

    for (let i = 0; i < toProcess.length; i += PARSE_CONCURRENCY) {
      const chunk = toProcess.slice(i, i + PARSE_CONCURRENCY);
      const entries = await Promise.all(
        chunk.map(async (filePath) => {
          try {
            const rel = relative(projectRoot, filePath);
            const source = await readFile(filePath, "utf8");
            const tree = await parseFile(filePath, source);
            if (!tree) {
              parse_failures.push(rel);
              return null;
            }
            const fields = parseMetadataExport(tree, source);
            const score = scoreMetadata(fields);
            const missing_fields = missingFieldsFor(fields, score);
            const url_path = deriveUrlPath(rel, "app");
            const entry: NextjsMetadataAuditEntry = {
              url_path,
              file_path: rel,
              score: score.score,
              grade: score.grade,
              violations: score.violations,
              missing_fields,
            };
            return entry;
          } catch (err) {
            const rel = relative(projectRoot, filePath);
            parse_failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      for (const e of entries) {
        if (!e) continue;
        scores.push(e);
        for (const v of e.violations) {
          top_issues_counter.set(v, (top_issues_counter.get(v) ?? 0) + 1);
        }
      }
    }
  }

  // Aggregate counts by grade
  const counts: NextjsMetadataAuditCounts = {
    excellent: 0,
    good: 0,
    needs_work: 0,
    poor: 0,
  };
  for (const s of scores) {
    counts[s.grade]++;
  }

  // Sort top issues by frequency desc, take top 5
  const top_issues = [...top_issues_counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([violation, count]) => `${violation} (${count})`);

  return {
    total_pages: scores.length,
    scores,
    counts,
    top_issues,
    workspaces_scanned,
    parse_failures,
    scan_errors,
    limitations: ["does not check remote Open Graph image resolution"],
  };
}
