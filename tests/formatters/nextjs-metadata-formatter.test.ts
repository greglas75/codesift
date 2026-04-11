import { describe, it, expect } from "vitest";
import { formatNextjsMetadataAudit } from "../../src/formatters.js";
import { formatNextjsMetadataAuditCompact } from "../../src/formatters-shortening.js";
import { getToolDefinitions } from "../../src/register-tools.js";
import type { NextjsMetadataAuditResult } from "../../src/tools/nextjs-metadata-tools.js";

const sample = (): NextjsMetadataAuditResult => ({
  total_pages: 3,
  scores: [
    {
      url_path: "/",
      file_path: "app/page.tsx",
      score: 100,
      grade: "excellent",
      violations: [],
      missing_fields: [],
    },
    {
      url_path: "/about",
      file_path: "app/about/page.tsx",
      score: 45,
      grade: "needs_work",
      violations: ["og_image_placeholder"],
      missing_fields: ["canonical", "twitter", "json_ld"],
    },
    {
      url_path: "/blog",
      file_path: "app/blog/page.tsx",
      score: 0,
      grade: "poor",
      violations: ["title_too_short"],
      missing_fields: ["title", "description", "og_image", "canonical", "twitter", "json_ld"],
    },
  ],
  counts: { excellent: 1, good: 0, needs_work: 1, poor: 1 },
  top_issues: ["og_image_placeholder (1)", "title_too_short (1)"],
  workspaces_scanned: ["/tmp/fixture"],
  parse_failures: [],
  scan_errors: [],
  limitations: ["does not check remote Open Graph image resolution"],
});

describe("formatNextjsMetadataAudit", () => {
  it("renders a table with URL, Score, Grade, and Missing Fields columns", () => {
    const out = formatNextjsMetadataAudit(sample());
    expect(out).toContain("URL");
    expect(out).toContain("Score");
    expect(out).toContain("Grade");
    expect(out).toContain("Missing");
    // At least one row from each grade
    expect(out).toContain("excellent");
    expect(out).toContain("poor");
  });
});

describe("formatNextjsMetadataAuditCompact", () => {
  it("renders a counts summary plus top 5 issues under 500 chars", () => {
    const out = formatNextjsMetadataAuditCompact(sample());
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("3 pages");
    expect(out).toContain("excellent");
    expect(out).toContain("og_image_placeholder");
  });
});

describe("nextjs_metadata_audit registration", () => {
  it("registers as analysis category in TOOL_DEFINITIONS", () => {
    const def = getToolDefinitions().find((t) => t.name === "nextjs_metadata_audit");
    expect(def).toBeDefined();
    expect(def!.category).toBe("analysis");
  });
});
