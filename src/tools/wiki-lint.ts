import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WikiManifest, JournalPageEntry } from "./wiki-manifest.js";
import { parseSentinelBlocks, SentinelIntegrityError } from "./journal-sentinel.js";

export interface LintIssue {
  type:
    | "broken-link"
    | "orphan-page"
    | "stale-hash"
    | "sentinel-integrity"
    | "citation-ungrounded"
    | "journal-hash-drift";
  severity: "error" | "warning";
  source?: string;
  target?: string;
  line?: number;
  message: string;
}

export interface LintResult {
  issues: LintIssue[];
  warnings: LintIssue[];
}

export interface LintOptions {
  strict?: boolean;
  citationThreshold?: number;
}

const LINK_RE = /\[\[([^\]]+)\]\]/g;

async function checkJournalSentinels(
  manifest: WikiManifest,
  wikiDir: string,
): Promise<{ issues: LintIssue[]; warnings: LintIssue[] }> {
  const issues: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  for (const page of manifest.pages) {
    if (!page.type.startsWith("journal-")) continue;
    const journalPage = page as JournalPageEntry;

    let content: string;
    try { content = await readFile(join(wikiDir, page.file), "utf-8"); }
    catch { continue; }  // missing file already reported by broken-link scan

    let blocks;
    try { blocks = parseSentinelBlocks(content); }
    catch (err) {
      if (err instanceof SentinelIntegrityError) {
        issues.push({ type: "sentinel-integrity", severity: "error", target: page.file, line: err.line, message: err.message });
      }
      continue;
    }

    const recorded = journalPage.journal_content_hashes;
    if (recorded === undefined) continue;
    for (const block of blocks) {
      const rh = recorded[block.kind];
      if (rh !== undefined && rh !== block.hash) {
        warnings.push({
          type: "journal-hash-drift", severity: "warning", target: page.file,
          message: `Block ${block.kind} hash drifted (recorded ${rh.slice(0, 8)} vs current ${block.hash.slice(0, 8)})`,
        });
      }
    }
  }

  return { issues, warnings };
}

// scripts/ sits outside rootDir — resolve via a variable so tsc doesn't chase it statically (TS6059).
type CitationCheckFn = (phaseFile: string, threshold: number) => Promise<{ total: number; grounded: number; percentage: number }>;
const CITATION_CHECK_MODULE = "../../scripts/journal-citation-check.js";

async function checkCitations(manifest: WikiManifest, wikiDir: string, threshold: number): Promise<LintIssue[]> {
  const mod = await import(CITATION_CHECK_MODULE) as { runCitationCheck: CitationCheckFn };
  const warnings: LintIssue[] = [];
  for (const page of manifest.pages) {
    if (page.type !== "journal-phase") continue;
    const result = await mod.runCitationCheck(join(wikiDir, page.file), threshold);
    if (result.percentage < threshold) {
      warnings.push({
        type: "citation-ungrounded", severity: "warning", target: page.file,
        message: `Only ${result.grounded}/${result.total} citations grounded (${result.percentage.toFixed(1)}%)`,
      });
    }
  }
  return warnings;
}

export async function lintWiki(
  wikiDir: string,
  currentIndexHash?: string,
  options?: LintOptions,
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

  // Journal sentinel integrity + hash-drift checks
  const journalChecks = await checkJournalSentinels(manifest, wikiDir);
  issues.push(...journalChecks.issues);
  warnings.push(...journalChecks.warnings);

  // --strict: citation grounding check per journal-phase page
  if (options?.strict === true) {
    const threshold = options.citationThreshold ?? 95;
    const citationWarnings = await checkCitations(manifest, wikiDir, threshold);
    warnings.push(...citationWarnings);
  }

  // Check for orphan pages
  const entries = await readdir(wikiDir);
  for (const entry of entries) {
    // Journal files are cleaned up by pruneStaleWikiFiles with an explicit
    // protected prefix (see src/tools/wiki-tools.ts Task 1). The manifest
    // tracks them as journal-* page types; do NOT flag as orphans.
    if (entry === "journal" || entry.startsWith("journal/")) continue;
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
