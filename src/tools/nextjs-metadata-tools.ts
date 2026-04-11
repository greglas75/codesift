/**
 * Next.js metadata audit (T1).
 *
 * Walks `app/**\/page.{tsx,jsx,ts,js}` files for `metadata` /
 * `generateMetadata` exports, scores each page using a weighted formula
 * (per design D4), and aggregates a per-route audit result with grade
 * distribution and top issues.
 */

import type { MetadataFields } from "../utils/nextjs.js";

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
// Stub orchestrator (Task 9 implements scoreMetadata, Task 10 wires this)
// ---------------------------------------------------------------------------

export async function nextjsMetadataAudit(
  _repo: string,
  _options?: NextjsMetadataAuditOptions,
): Promise<NextjsMetadataAuditResult> {
  throw new Error("not implemented");
}
