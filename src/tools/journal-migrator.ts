import { createHash } from "node:crypto";
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Typed errors (CQ8)
export class NoPhasesError extends Error {
  constructor() { super("no `### Week` headings found in source; NoPhasesError"); this.name = "NoPhasesError"; }
}
export class SlugCollisionError extends Error {
  constructor(slug: string) {
    super(`slug collision: two weeks resolve to "${slug}". Disambiguate titles or date ranges. SlugCollisionError`);
    this.name = "SlugCollisionError";
  }
}
export class SourceDriftError extends Error {
  constructor(newSha: string, recordedSha: string) {
    super(`source file changed since dry-run (sha ${newSha} ≠ ${recordedSha}), aborting`);
    this.name = "SourceDriftError";
  }
}

export interface MigrateOptions {
  source: string;
  repoRoot: string;
  outputDir: string;
  dryRun: boolean;
}
export interface MigrateResult {
  status: "planned" | "ok" | "aborted";
  phaseCount: number;
  reason?: string;
}

// Constants + path helpers (CQ14 single-site path construction)
const SCHEMA_VERSION = "1";
const GITIGNORE_ENTRY_REL = ".codesift/wiki/journal/.migrate-state.json";
const NO_PLAN_MSG =
  "No migration plan found. Run 'codesift journal migrate --dry-run' first to generate a migration plan, then run without --dry-run to execute.";

const journalDir = (outputDir: string): string => join(outputDir, "journal");
const phasesDir = (outputDir: string): string => join(journalDir(outputDir), "phases");
const phasePath = (outputDir: string, slug: string): string => join(phasesDir(outputDir), `${slug}.md`);
const overviewPath = (outputDir: string): string => join(journalDir(outputDir), "overview.md");
const statePath = (outputDir: string): string => join(journalDir(outputDir), ".migrate-state.json");
const gitignorePath = (repoRoot: string): string => join(repoRoot, ".gitignore");

// AST
interface EntryBlock { startDate: string; titleLine: string; bodyLines: string[]; }
interface WeekBlock { headingLine: string; title: string; entries: EntryBlock[]; preamble: string[]; }
interface OverviewSection { headingLine: string; bodyLines: string[]; }
interface Parsed { weeks: WeekBlock[]; overviewSections: OverviewSection[]; }

const RE_H2 = /^## (.+)$/;
const RE_TIMELINE = /^## Timeline\s*$/;
const RE_WEEK = /^### Week (\d+) — (.+)$/;
const RE_ENTRY_SINGLE = /^#### (\d{4}-\d{2}-\d{2}) — /;
const RE_ENTRY_RANGE = /^#### (\d{4}-\d{2}-\d{2}) [–-] (\d{4}-\d{2}-\d{2}) — /;

function parse(source: string): Parsed {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const weeks: WeekBlock[] = [];
  const overviewSections: OverviewSection[] = [];
  type Mode =
    | { kind: "none" }
    | { kind: "overview"; sec: OverviewSection }
    | { kind: "week"; week: WeekBlock; currentEntry: EntryBlock | null };
  let mode: Mode = { kind: "none" };

  for (const line of lines) {
    if (RE_TIMELINE.test(line)) { mode = { kind: "none" }; continue; }

    const weekMatch = RE_WEEK.exec(line);
    if (weekMatch) {
      const week: WeekBlock = { headingLine: line, title: weekMatch[2]!, entries: [], preamble: [] };
      weeks.push(week);
      mode = { kind: "week", week, currentEntry: null };
      continue;
    }

    // Any ## heading ends week/overview mode and starts a new overview section.
    if (RE_H2.test(line)) {
      const sec: OverviewSection = { headingLine: line, bodyLines: [] };
      overviewSections.push(sec);
      mode = { kind: "overview", sec };
      continue;
    }

    if (mode.kind === "week") {
      const rangeMatch = RE_ENTRY_RANGE.exec(line);
      const singleMatch = rangeMatch ? null : RE_ENTRY_SINGLE.exec(line);
      if (rangeMatch || singleMatch) {
        const startDate = (rangeMatch ? rangeMatch[1] : singleMatch![1])!;
        const entry: EntryBlock = { startDate, titleLine: line, bodyLines: [] };
        mode.week.entries.push(entry);
        mode.currentEntry = entry;
        continue;
      }
      if (mode.currentEntry) mode.currentEntry.bodyLines.push(line);
      else mode.week.preamble.push(line);
    } else if (mode.kind === "overview") {
      mode.sec.bodyLines.push(line);
    }
  }
  return { weeks, overviewSections };
}

const slugifyTitle = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const deriveSlug = (week: WeekBlock): string => {
  const month = week.entries[0]?.startDate.slice(0, 7) ?? "0000-00";
  return `${month}-${slugifyTitle(week.title)}`;
};

function renderPhaseFile(week: WeekBlock): string {
  const lines: string[] = [
    `## ${week.title}`,
    "",
    "<!-- auto:begin phase-summary -->",
    "<!-- TODO: generate phase summary via `codesift journal init` -->",
    "<!-- auto:end phase-summary -->",
    "",
    "## My notes",
    week.headingLine,
    ...week.preamble,
  ];
  for (const entry of week.entries) {
    lines.push(entry.titleLine, ...entry.bodyLines);
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function renderOverviewFile(sections: OverviewSection[]): string {
  const lines: string[] = ["# Overview", "", "<!-- manual:begin migrated-overview -->"];
  for (const sec of sections) {
    lines.push(sec.headingLine, ...sec.bodyLines);
  }
  lines.push("<!-- manual:end migrated-overview -->", "");
  return lines.join("\n");
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function ensureGitignoreEntry(repoRoot: string, entry: string): Promise<void> {
  const path = gitignorePath(repoRoot);
  try {
    let existing = "";
    try { existing = await readFile(path, "utf-8"); } catch { /* create */ }
    if (existing.split("\n").includes(entry)) return;
    const suffix = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(path, existing + suffix + entry + "\n", "utf-8");
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`WARN journal: could not update .gitignore (${msg}); add ${entry} manually.`);
  }
}

export async function runMigrate(opts: MigrateOptions): Promise<MigrateResult> {
  const { source, repoRoot, outputDir, dryRun } = opts;

  const sourceContent = await readFile(source, "utf-8");
  const parsed = parse(sourceContent);
  if (parsed.weeks.length === 0) throw new NoPhasesError();

  const slugs = parsed.weeks.map(deriveSlug);
  const seen = new Set<string>();
  for (const s of slugs) {
    if (seen.has(s)) throw new SlugCollisionError(s);
    seen.add(s);
  }

  const sourceSha = sha256(sourceContent);
  await mkdir(journalDir(outputDir), { recursive: true });

  if (dryRun) {
    const state = { source_sha256: sourceSha, planned_phase_slugs: slugs, schema_version: SCHEMA_VERSION };
    await writeFile(statePath(outputDir), JSON.stringify(state, null, 2), "utf-8");
    await ensureGitignoreEntry(repoRoot, GITIGNORE_ENTRY_REL);
    return { status: "planned", phaseCount: parsed.weeks.length };
  }

  // Live run: require plan, validate SHA.
  let stateRaw: string;
  try { stateRaw = await readFile(statePath(outputDir), "utf-8"); }
  catch { throw new Error(NO_PLAN_MSG); }
  const state = JSON.parse(stateRaw) as { source_sha256: string };
  if (state.source_sha256 !== sourceSha) throw new SourceDriftError(sourceSha, state.source_sha256);

  // .bak MUST precede any phase writes (test i).
  await copyFile(source, source + ".bak");

  await mkdir(phasesDir(outputDir), { recursive: true });
  const wx = { encoding: "utf-8" as const, flag: "wx" as const };  // no-clobber; hand-edits require .bak rollback
  for (let i = 0; i < parsed.weeks.length; i++) {
    await writeFile(phasePath(outputDir, slugs[i]!), renderPhaseFile(parsed.weeks[i]!), wx);
  }
  await writeFile(overviewPath(outputDir), renderOverviewFile(parsed.overviewSections), wx);

  return { status: "ok", phaseCount: parsed.weeks.length };
}
