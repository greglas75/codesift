import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseSentinelBlocks } from "./journal-sentinel.js";
import type { PhasePlan } from "./journal-phase-detector.js";
import type { WikiManifest, JournalPageEntry, PageEntry } from "./wiki-manifest.js";

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG_RE.test(slug)) throw new Error(`Unsafe journal slug "${slug}" (must match ${SAFE_SLUG_RE.source})`);
}

export interface CheckpointState { startedAt: string; completed: string[]; costUsd: number }

export class BlockChangedError extends Error {
  readonly blockKind: string;
  constructor(kind: string) {
    super(`Block ${kind} changed since read`); this.name = "BlockChangedError"; this.blockKind = kind;
  }
}

export class BudgetExceededError extends Error {
  readonly file: string; readonly sizeBytes: number; readonly limit: number;
  constructor(file: string, sizeBytes: number, limit: number) {
    super(`${file} is ${sizeBytes} bytes, exceeds ${limit}`);
    this.name = "BudgetExceededError";
    this.file = file; this.sizeBytes = sizeBytes; this.limit = limit;
  }
}

export const BUDGETS: Readonly<Record<string, number>> = { "rollup.md": 12_000, "overview.md": 6_000 };

export function assertBlockUnchanged(fileContent: string, blockKind: string, preHash: string): void {
  const block = parseSentinelBlocks(fileContent).find((b) => b.kind === blockKind);
  if (!block || block.hash !== preHash) throw new BlockChangedError(blockKind);
}

export async function acquireLock(lockPath: string): Promise<void> {
  await writeFile(lockPath, String(process.pid), { flag: "wx" });
}
export async function releaseLock(lockPath: string): Promise<void> {
  try { await unlink(lockPath); } catch { /* best-effort */ }
}
export async function readCheckpoint(path: string): Promise<CheckpointState | null> {
  try { return JSON.parse(await readFile(path, "utf-8")) as CheckpointState; } catch { return null; }
}
export async function writeCheckpoint(path: string, state: CheckpointState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

export function enforceBudgets(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const limit = BUDGETS[name];
    if (limit === undefined) continue;
    const size = Buffer.byteLength(content, "utf-8");
    if (size > limit) throw new BudgetExceededError(name, size, limit);
  }
}

export async function anyFileHasTodo(dir: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try { if ((await readFile(join(dir, f), "utf-8")).includes("TODO:")) return true; } catch { /* ignore */ }
  }
  return false;
}

export async function readPhaseBlockHash(filePath: string, kind: string): Promise<string | undefined> {
  try { return parseSentinelBlocks(await readFile(filePath, "utf-8")).find((b) => b.kind === kind)?.hash; }
  catch { return undefined; }
}

// ─── Delta filtering (Phase A) ──────────────────────────────────────────────
function resolveSinceCutoff(since: string, cwd: string): number {
  const direct = Date.parse(since);
  if (!Number.isNaN(direct)) return direct;
  try {
    const raw = execFileSync("git", ["log", "-1", "--format=%aI", "--since", since],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  } catch { /* fall through */ }
  return Number.NEGATIVE_INFINITY;
}

export function filterPhasesBySince(phases: PhasePlan[], since: string, cwd = process.cwd()): PhasePlan[] {
  const cutoff = resolveSinceCutoff(since, cwd);
  if (cutoff === Number.NEGATIVE_INFINITY) return phases;
  return phases.filter((p) => { const t = Date.parse(p.endDate); return !Number.isNaN(t) && t >= cutoff; });
}

export type PhaseScope = { entry?: string; phase?: string };
export function filterPhasesByScope(phases: PhasePlan[], scope: PhaseScope): PhasePlan[] {
  if (scope.phase) return phases.filter((p) => p.slug === scope.phase);
  if (!scope.entry) throw new Error("filterPhasesByScope requires entry or phase");
  const e = scope.entry;
  return phases.filter((p) =>
    p.commits.some((c) => c.date.startsWith(e)) || (e >= p.startDate && e <= p.endDate));
}

const JOURNAL_KINDS: ReadonlyArray<PageEntry["type"]> = ["journal-phase", "journal-overview", "journal-rollup"];
const isJournalPage = (p: PageEntry): boolean => (JOURNAL_KINDS as string[]).includes(p.type);

/** True when !force AND manifest has a journal-* page w/ matching slug whose
 *  journal_content_hashes["phase-summary"] equals currentHash. */
export function shouldSkipPhaseByHash(
  slug: string, currentHash: string,
  opts: { force?: boolean; manifest?: WikiManifest | null } = {},
): boolean {
  if (opts.force || !opts.manifest) return false;
  const p = opts.manifest.pages.find((x) => x.slug === slug && isJournalPage(x));
  return (p as JournalPageEntry | undefined)?.journal_content_hashes?.["phase-summary"] === currentHash;
}

// ─── Phase C: manifest + index wiring ───────────────────────────────────────

export interface JournalPhaseWrite { slug: string; title: string; file: string; hash: string }

export function buildJournalManifestEntries(
  phaseWrites: JournalPhaseWrite[], overviewPresent: boolean,
): JournalPageEntry[] {
  const entries: JournalPageEntry[] = [];
  if (overviewPresent) entries.push({
    slug: "journal-overview", title: "Journal — Overview", type: "journal-overview",
    file: "journal/overview.md", outbound_links: [], source: "generated",
  });
  for (const w of phaseWrites) entries.push({
    slug: w.slug, title: w.title, type: "journal-phase",
    file: w.file, outbound_links: [], source: "generated",
    journal_content_hashes: { "phase-summary": w.hash },
  });
  return entries;
}

export function mergeJournalIntoManifest(
  existing: WikiManifest | null, journalEntries: JournalPageEntry[],
): WikiManifest {
  const base: WikiManifest = existing ?? {
    manifest_schema_version: "2.1.0", generated_at: new Date().toISOString(),
    index_hash: "", git_commit: "", pages: [], slug_redirects: {},
    token_estimates: {}, file_to_community: {}, degraded: false,
  };
  const kept = base.pages.filter((p) => !isJournalPage(p));
  return { ...base, pages: [...kept, ...journalEntries], generated_at: new Date().toISOString() };
}

export function renderJournalSectionMd(entries: JournalPageEntry[]): string {
  const overview = entries.find((e) => e.type === "journal-overview");
  const phases = entries.filter((e) => e.type === "journal-phase").slice()
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const lines = ["## journal", "",
    "Weekly phase narratives auto-registered from journal-init / journal-append.", ""];
  const bullet = (e: JournalPageEntry, tail: string): string =>
    `- [${e.file.replace(/\.md$/, "")}](${e.file}) — ${tail}`;
  if (overview) lines.push(bullet(overview, "At a glance / Themes / Sources"));
  for (const p of phases) lines.push(bullet(p, p.title));
  lines.push("");
  return lines.join("\n");
}

export function insertJournalSectionIntoIndex(indexMd: string, sectionMd: string): string {
  const section = sectionMd.endsWith("\n") ? sectionMd : sectionMd + "\n";
  const lines = indexMd.split("\n");
  const sandwich = (startIdx: number, endIdx: number): string => {
    const before = lines.slice(0, startIdx).join("\n").replace(/\n+$/, "");
    const after = lines.slice(endIdx).join("\n").replace(/^\n+/, "");
    return (before.length > 0 ? before + "\n\n" : "") + section + (after.length > 0 ? "\n" + after : "");
  };
  const jIdx = lines.findIndex((l) => /^## journal\s*$/.test(l));
  if (jIdx >= 0) {
    let end = lines.length;
    for (let i = jIdx + 1; i < lines.length; i++) if (/^## /.test(lines[i]!)) { end = i; break; }
    return sandwich(jIdx, end);
  }
  const hubsIdx = lines.findIndex((l) => /^## hubs\s*$/.test(l));
  if (hubsIdx >= 0) return sandwich(hubsIdx, hubsIdx);
  const trimmed = indexMd.replace(/\n+$/, "");
  return (trimmed.length > 0 ? trimmed + "\n\n" : "") + section;
}

export async function readManifestIfExists(path: string): Promise<WikiManifest | null> {
  try { return JSON.parse(await readFile(path, "utf-8")) as WikiManifest; }
  catch { return null; }
}

/** Atomic write with TOCTOU guard: re-read + hash-check before tmp→rename. */
export async function writePhaseAtomic(
  filePath: string, content: string, preHash: string | undefined, force: boolean,
): Promise<void> {
  if (preHash !== undefined) {
    let latest = "";
    try { latest = await readFile(filePath, "utf-8"); } catch { /* new file */ }
    try { assertBlockUnchanged(latest, "phase-summary", preHash); }
    catch (err) {
      if (!(err instanceof BlockChangedError)) throw err;
      if (!force) throw err;
      console.warn("WARN journal: forced overwrite");
    }
  }
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
  await rename(tmp, filePath);
}
