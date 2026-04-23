// ---------------------------------------------------------------------------
// CLI handlers for 7 journal subcommands (init, append, refresh-overview,
// regenerate, lint, migrate, stats). Kill switch, flag validation, and
// lazy tool imports live here; actual work lives in src/tools/journal-*.
// ---------------------------------------------------------------------------

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Flags } from "./args.js";
import { getFlag, getBoolFlag } from "./args.js";

const KILL_MSG =
  "journal disabled by CODESIFT_JOURNAL_ENABLED=false; set to 1 to enable\n";
const WIKI_DIR = ".codesift/wiki";
const JOURNAL_DIR = `${WIKI_DIR}/journal`;

/** CQ14: single gating site for CODESIFT_JOURNAL_ENABLED. Returns true when
 *  disabled — callers must early-return after writing stderr + exit(1). */
function killSwitchGated(): boolean {
  if (process.env["CODESIFT_JOURNAL_ENABLED"] === "false") {
    process.stderr.write(KILL_MSG);
    process.exit(1);
    return true;
  }
  return false;
}

function baseOpts(flags: Flags): { cwd: string; outputDir: string; force: boolean } {
  return { cwd: process.cwd(), outputDir: WIKI_DIR, force: !!getBoolFlag(flags, "force") };
}

export async function handleJournalInit(_args: string[], flags: Flags): Promise<void> {
  if (killSwitchGated()) return;
  const dryRun = !!getBoolFlag(flags, "dry-run");
  const bulkFill = !!getBoolFlag(flags, "bulk-fill");
  const { force, ...rest } = baseOpts(flags);
  // E8 / test (i): CI=true + ambiguous invocation → default to append for safety.
  if (process.env["CI"] === "true" && !force && !bulkFill && !dryRun) {
    process.stdout.write("CI=true: defaulting ambiguous invocation to append\n");
    const { runJournalAppend } = await import("../tools/journal-generator.js");
    const r = await runJournalAppend({ ...rest, force });
    process.stdout.write(`journal append: ${r.status} (${r.phases.length} phases)\n`);
    return;
  }
  const { runJournalInit } = await import("../tools/journal-generator.js");
  const r = await runJournalInit({ ...rest, force, dryRun, bulkFill });
  process.stdout.write(`journal init: ${r.status} (${r.phases.length} phases)\n`);
}

export async function handleJournalAppend(_args: string[], flags: Flags): Promise<void> {
  if (killSwitchGated()) return;
  const since = getFlag(flags, "since");
  if (!since) {
    process.stderr.write("journal append requires --since (e.g. --since='2 weeks ago')\n");
    process.exit(1);
    return;
  }
  const { runJournalAppend } = await import("../tools/journal-generator.js");
  const r = await runJournalAppend({ ...baseOpts(flags), since });
  process.stdout.write(`journal append: ${r.status} (${r.phases.length} phases)\n`);
}

export async function handleJournalRefreshOverview(_args: string[], flags: Flags): Promise<void> {
  if (killSwitchGated()) return;
  const { refreshOverviewAndRollup } = await import("../tools/journal-generator.js");
  const r = await refreshOverviewAndRollup(baseOpts(flags));
  process.stdout.write(`journal refresh-overview: ${r.status}\n`);
}

export async function handleJournalRegenerate(_args: string[], flags: Flags): Promise<void> {
  if (killSwitchGated()) return;
  const entry = getFlag(flags, "entry");
  const phase = getFlag(flags, "phase");
  if ((!entry && !phase) || (entry && phase)) {
    process.stderr.write("journal regenerate requires exactly one of --entry=<date> or --phase=<slug>\n");
    process.exit(1);
    return;
  }
  const { runJournalRegenerate } = await import("../tools/journal-generator.js");
  const extra: { entry?: string; phase?: string } = {};
  if (entry) extra.entry = entry;
  if (phase) extra.phase = phase;
  const r = await runJournalRegenerate({ ...baseOpts(flags), ...extra });
  if (r.status === "aborted") { process.exit(2); return; }
  process.stdout.write(`journal regenerate: ${r.status}\n`);
}

async function walkJournalMd(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  }
  await walk(root);
  return out;
}

export async function handleJournalLint(_args: string[], _flags: Flags): Promise<void> {
  if (killSwitchGated()) return;
  const { parseSentinelBlocks } = await import("../tools/journal-sentinel.js");
  const journalDir = join(WIKI_DIR, "journal");
  const files = await walkJournalMd(journalDir);
  if (files.length === 0) { process.stdout.write("journal lint: no journal directory\n"); return; }
  let issues = 0;
  for (const f of files) {
    try {
      const content = await readFile(f, "utf-8");
      parseSentinelBlocks(content);
    } catch (err) {
      issues++;
      process.stderr.write(`ERROR: ${f}: ${(err as Error).message}\n`);
    }
  }
  if (issues > 0) process.exitCode = 1;
  else process.stdout.write(`journal lint: ${files.length} file(s) OK\n`);
}

export async function handleJournalMigrate(_args: string[], flags: Flags): Promise<void> {
  if (killSwitchGated()) return;
  const dryRun = !!getBoolFlag(flags, "dry-run");
  const source = getFlag(flags, "source") ?? "docs/specs/wiki-prototype-history.md";
  const { runMigrate } = await import("../tools/journal-migrator.js");
  const r = await runMigrate({ source, repoRoot: process.cwd(), outputDir: WIKI_DIR, dryRun });
  process.stdout.write(`journal migrate: ${r.status} (${r.phaseCount} phases)\n`);
}

export async function handleJournalStats(_args: string[], _flags: Flags): Promise<void> {
  if (killSwitchGated()) return;
  const checkpointPath = join(JOURNAL_DIR, ".checkpoint.json");
  let raw: string;
  try { raw = await readFile(checkpointPath, "utf-8"); }
  catch { process.stdout.write("No journal run recorded yet\n"); return; }
  const cp = JSON.parse(raw) as { startedAt?: string; completed?: string[]; costUsd?: number };
  const completed = cp.completed?.length ?? 0;
  const cost = cp.costUsd ?? 0;
  const started = cp.startedAt ?? "(unknown)";
  process.stdout.write(
    `journal stats: completed=${completed}, cost=$${cost.toFixed(2)} USD, started-at=${started}\n`,
  );
}
