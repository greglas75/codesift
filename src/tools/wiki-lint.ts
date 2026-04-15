import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WikiManifest } from "./wiki-manifest.js";

export interface LintIssue {
  type: "broken-link" | "orphan-page" | "stale-hash";
  severity: "error" | "warning";
  source?: string;
  target?: string;
  message: string;
}

export interface LintResult {
  issues: LintIssue[];
  warnings: LintIssue[];
}

const LINK_RE = /\[\[([^\]]+)\]\]/g;

export async function lintWiki(
  wikiDir: string,
  currentIndexHash?: string,
): Promise<LintResult> {
  const manifestPath = join(wikiDir, "wiki-manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    throw new Error(`Wiki manifest not found at ${manifestPath}`);
  }

  const manifest: WikiManifest = JSON.parse(raw) as WikiManifest;
  const knownSlugs = new Set(manifest.pages.map((p) => p.slug));
  const knownFiles = new Set(manifest.pages.map((p) => p.file));

  const issues: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  // Check links in each page
  for (const page of manifest.pages) {
    let content: string;
    try {
      content = await readFile(join(wikiDir, page.file), "utf-8");
    } catch {
      issues.push({
        type: "broken-link",
        severity: "error",
        source: page.slug,
        message: `Page file ${page.file} listed in manifest but not found on disk`,
      });
      continue;
    }

    let match: RegExpExecArray | null;
    while ((match = LINK_RE.exec(content)) !== null) {
      const target = match[1]!;
      if (!knownSlugs.has(target)) {
        issues.push({
          type: "broken-link",
          severity: "error",
          source: page.slug,
          target,
          message: `Broken link [[${target}]] in ${page.slug}`,
        });
      }
    }
    LINK_RE.lastIndex = 0;
  }

  // Check for orphan pages
  const entries = await readdir(wikiDir);
  for (const entry of entries) {
    if (entry.endsWith(".md") && !knownFiles.has(entry)) {
      issues.push({
        type: "orphan-page",
        severity: "error",
        target: entry,
        message: `Orphan page ${entry} not listed in manifest`,
      });
    }
  }

  // Check index hash staleness
  if (currentIndexHash !== undefined && currentIndexHash !== manifest.index_hash) {
    warnings.push({
      type: "stale-hash",
      severity: "warning",
      message: `Wiki index hash (${manifest.index_hash}) differs from current (${currentIndexHash}) — regenerate with codesift wiki-generate`,
    });
  }

  return { issues, warnings };
}
