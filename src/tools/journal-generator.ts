import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitLog, type GitCommit } from "./journal-git-client.js";
import { detectPhases, type PhasePlan } from "./journal-phase-detector.js";
import { selectProvider, CostCapExceededError } from "./journal-llm-client.js";
import { buildScaffoldResponse, renderPhaseSummaryPrompt, validateLlmResponse } from "./journal-templates.js";
import { computeBlockHash } from "./journal-sentinel.js";
import {
  BlockChangedError, acquireLock, releaseLock, readCheckpoint, writeCheckpoint,
  enforceBudgets, anyFileHasTodo, readPhaseBlockHash, writePhaseAtomic, assertSafeSlug,
  filterPhasesBySince, filterPhasesByScope,
  buildJournalManifestEntries, mergeJournalIntoManifest, renderJournalSectionMd,
  insertJournalSectionIntoIndex, readManifestIfExists, shouldSkipPhaseByHash,
  extractPhaseTitle, rewriteOverviewPhasesList,
  type JournalPhaseWrite,
} from "./journal-generator-helpers.js";

type PhaseFilter =
  | { kind: "since"; value: string }
  | { kind: "entry"; value: string }
  | { kind: "phase"; value: string };

export interface JournalRunOptions {
  cwd: string;
  outputDir: string;
  dryRun?: boolean;
  force?: boolean;
  bulkFill?: boolean;
  checkpointPath?: string;
  lockPath?: string;
  /** gitLog filter — git-relative string like "2 weeks ago" or ISO date. */
  since?: string;
  /** Regenerate only this entry date (YYYY-MM-DD); mutually exclusive with phase. */
  entry?: string;
  /** Regenerate only this phase slug; mutually exclusive with entry. */
  phase?: string;
}

export interface JournalRunResult {
  status: "ok" | "planned" | "locked" | "aborted" | "capped" | "skipped";
  phases: Array<{ slug: string; file: string; costUsd: number }>;
  reason?: string;
}

export interface ProcessContext {
  provider: ReturnType<typeof selectProvider>;
  outputDir: string;
  force: boolean;
}

export interface PhaseWriteResult {
  slug: string;
  content: string;
  hash: string;
  costUsd: number;
}

interface RunConfig { force: boolean; bulkFill: boolean; allowNonEmpty: boolean; filter?: PhaseFilter }

function applyFilter(phases: PhasePlan[], filter: PhaseFilter | undefined, cwd: string): PhasePlan[] {
  if (!filter) return phases;
  if (filter.kind === "since") return filterPhasesBySince(phases, filter.value, cwd);
  return filterPhasesByScope(phases,
    filter.kind === "entry" ? { entry: filter.value } : { phase: filter.value });
}

/** Seam: per-phase LLM + validation (no fs). Exported for tests. */
export async function processPhase(
  phase: PhasePlan, ctx: ProcessContext,
): Promise<PhaseWriteResult> {
  const prompt = renderPhaseSummaryPrompt(phase);
  const model = process.env["CODESIFT_JOURNAL_MODEL"] ?? "claude-sonnet-4-6";
  const r = await ctx.provider.generate(prompt, { model });
  const content = validateLlmResponse(r.content).ok ? r.content : buildScaffoldResponse(phase);
  return { slug: phase.slug, content, hash: computeBlockHash(content), costUsd: r.costUsd };
}

const PLACEHOLDER_COMMIT: GitCommit = {
  sha: "0".repeat(40), date: "2026-04-01T00:00:00Z", authorName: "",
  subject: "feat(init): init", parentShas: [], refs: [],
};

async function guardE8(phasesDir: string, cfg: RunConfig): Promise<string | null> {
  let existing: string[] = [];
  try { existing = await readdir(phasesDir); } catch { /* not created yet */ }
  if (existing.length === 0 || cfg.allowNonEmpty || cfg.bulkFill) return null;
  if (await anyFileHasTodo(phasesDir, existing)) return null;
  return "phases/ is non-empty — use 'journal append' instead, or pass --bulk-fill";
}

async function runPipeline(opts: JournalRunOptions, cfg: RunConfig): Promise<JournalRunResult> {
  const journalDir = join(opts.outputDir, "journal");
  const phasesDir = join(journalDir, "phases");
  const lockPath = opts.lockPath ?? join(journalDir, ".init-lock");
  const checkpointPath = opts.checkpointPath ?? join(journalDir, ".checkpoint.json");

  try { await acquireLock(lockPath); }
  catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { status: "locked", phases: [], reason: "journal operation already in progress" };
    throw err;
  }

  try {
    const commits = gitLog({ cwd: opts.cwd });
    const allPhases = detectPhases(
      commits.length > 0 ? commits : [PLACEHOLDER_COMMIT],
      undefined,
      { minUnclassifiedCommits: 3 },
    );
    const phases = applyFilter(allPhases, cfg.filter, opts.cwd);

    if (opts.dryRun) {
      return {
        status: "planned",
        phases: phases.map((p) => {
          assertSafeSlug(p.slug);
          return { slug: p.slug, file: join(phasesDir, `${p.slug}.md`), costUsd: 0 };
        }),
      };
    }

    const abortReason = await guardE8(phasesDir, cfg);
    if (abortReason) return { status: "aborted", phases: [], reason: abortReason };

    const cp = await readCheckpoint(checkpointPath);
    const completed = new Set(cp?.completed ?? []);
    let runningCost = cp?.costUsd ?? 0;
    const startedAt = cp?.startedAt ?? new Date().toISOString();
    const maxCost = Number(process.env["CODESIFT_JOURNAL_MAX_USD"] ?? 2.0);
    const provider = selectProvider();
    const results: Array<{ slug: string; file: string; costUsd: number }> = [];
    const phaseWrites: JournalPhaseWrite[] = [];
    const manifestPath = join(opts.outputDir, "wiki-manifest.json");
    const existingManifest = await readManifestIfExists(manifestPath);

    for (const phase of phases) {
      assertSafeSlug(phase.slug);
      if (completed.has(phase.slug)) continue;
      const filePath = join(phasesDir, `${phase.slug}.md`);
      const preHash = await readPhaseBlockHash(filePath, "phase-summary");
      if (preHash !== undefined &&
          shouldSkipPhaseByHash(phase.slug, preHash, { force: cfg.force, manifest: existingManifest })) {
        continue;
      }
      try {
        const r = await processPhase(phase, { provider, outputDir: opts.outputDir, force: cfg.force });
        runningCost += r.costUsd;
        if (runningCost > maxCost) throw new CostCapExceededError(runningCost, maxCost);
        enforceBudgets({ [`${phase.slug}.md`]: r.content });
        await writePhaseAtomic(filePath, r.content, preHash, cfg.force);
        completed.add(phase.slug);
        await writeCheckpoint(checkpointPath, { startedAt, completed: [...completed], costUsd: runningCost });
        results.push({ slug: phase.slug, file: filePath, costUsd: r.costUsd });
        phaseWrites.push({
          slug: phase.slug, title: phase.title,
          file: `journal/phases/${phase.slug}.md`, hash: r.hash,
        });
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          await writeCheckpoint(checkpointPath, { startedAt, completed: [...completed], costUsd: runningCost });
          return { status: "capped", phases: results, reason: err.message };
        }
        if (err instanceof BlockChangedError) {
          return { status: "aborted", phases: results, reason: err.message };
        }
        throw err;
      }
    }
    if (phaseWrites.length > 0) {
      await updateManifestAndIndex(opts.outputDir, phaseWrites, journalDir);
    }
    return { status: "ok", phases: results };
  } finally {
    await releaseLock(lockPath);
  }
}

/** Best-effort manifest + index register; failures WARN only (CQ8). */
async function updateManifestAndIndex(
  outputDir: string, phaseWrites: JournalPhaseWrite[], journalDir: string,
): Promise<void> {
  const manifestPath = join(outputDir, "wiki-manifest.json");
  const indexPath = join(outputDir, "index.md");
  const overviewPresent = await readFile(join(journalDir, "overview.md"), "utf-8").then(() => true).catch(() => false);
  const entries = buildJournalManifestEntries(phaseWrites, overviewPresent);
  try {
    const merged = mergeJournalIntoManifest(await readManifestIfExists(manifestPath), entries);
    await writeFile(manifestPath, JSON.stringify(merged, null, 2), "utf-8");
  } catch (err) { console.warn(`WARN journal: could not update wiki-manifest.json (${(err as Error).message})`); return; }
  try {
    const existingIndex = await readFile(indexPath, "utf-8").catch(() => "");
    await writeFile(indexPath, insertJournalSectionIntoIndex(existingIndex, renderJournalSectionMd(entries)), "utf-8");
  } catch (err) { console.warn(`WARN journal: could not update index.md (${(err as Error).message})`); }
}

export async function runJournalInit(opts: JournalRunOptions): Promise<JournalRunResult> {
  return runPipeline(opts, { force: !!opts.force, bulkFill: !!opts.bulkFill, allowNonEmpty: false });
}

export async function runJournalAppend(opts: JournalRunOptions): Promise<JournalRunResult> {
  if (!opts.since) return { status: "aborted", phases: [], reason: "runJournalAppend requires options.since" };
  return runPipeline(opts, {
    force: !!opts.force, bulkFill: true, allowNonEmpty: true,
    filter: { kind: "since", value: opts.since },
  });
}

export async function runJournalRegenerate(opts: JournalRunOptions): Promise<JournalRunResult> {
  if (!opts.entry && !opts.phase) {
    return { status: "aborted", phases: [], reason: "runJournalRegenerate requires entry or phase" };
  }
  const filter: PhaseFilter = opts.entry
    ? { kind: "entry", value: opts.entry }
    : { kind: "phase", value: opts.phase! };
  return runPipeline(opts, { force: !!opts.force, bulkFill: true, allowNonEmpty: true, filter });
}

/** Rewrite overview.md / index.md journal section from the current phase files
 *  on disk — no LLM, no credentials needed. Preserves the
 *  `<!-- manual:begin migrated-overview -->` block in overview.md verbatim,
 *  regenerates the Phases list below it from the files in phases/. */
export async function refreshOverviewAndRollup(opts: JournalRunOptions): Promise<JournalRunResult> {
  const journalDir = join(opts.outputDir, "journal");
  const phasesDir = join(journalDir, "phases");
  const overviewPath = join(journalDir, "overview.md");

  let phaseFiles: string[] = [];
  try { phaseFiles = (await readdir(phasesDir)).filter((f) => f.endsWith(".md")).sort(); }
  catch { return { status: "aborted", phases: [], reason: "no phases/ directory" }; }

  const phaseWrites: JournalPhaseWrite[] = [];
  for (const f of phaseFiles) {
    const slug = f.slice(0, -3);  // strip .md
    assertSafeSlug(slug);
    const filePath = join(phasesDir, f);
    const hash = (await readPhaseBlockHash(filePath, "phase-summary")) ?? "";
    const title = await extractPhaseTitle(filePath, slug);
    phaseWrites.push({ slug, title, file: `journal/phases/${f}`, hash });
  }

  // Rewrite overview.md preserving the manual block; append/replace the Phases list.
  const existingOverview = await readFile(overviewPath, "utf-8").catch(() => "");
  const updatedOverview = rewriteOverviewPhasesList(existingOverview, phaseWrites);
  try { await writeFile(overviewPath, updatedOverview, "utf-8"); }
  catch (err) { console.warn(`WARN journal: could not write overview.md (${(err as Error).message})`); }

  await updateManifestAndIndex(opts.outputDir, phaseWrites, journalDir);
  return { status: "ok", phases: phaseWrites.map((p) => ({ slug: p.slug, file: join(phasesDir, `${p.slug}.md`), costUsd: 0 })) };
}

