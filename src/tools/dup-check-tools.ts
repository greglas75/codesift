/**
 * `codesift dup-check` — is any function the branch adds or changes a near-copy of one that already
 * exists? Only symbols touched by ADDED lines are checked, so clones already in the repo are
 * grandfathered without a baseline file.
 *
 * The pieces below are pure (diff parsing, range intersection, the suppression marker, the matcher);
 * `runDupCheck` wires them to git, the parser and the index. Normalisation, hashing and similarity are
 * `find_clones`' own (clone-tools.ts), so the two tools can never disagree about what a clone is.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  ANALYZABLE_KINDS,
  MAX_LINE_RATIO,
  computeSimilarity,
  hashLines,
  normalizeSource,
} from "./clone-tools.js";
import { isTestFileStrict } from "../utils/test-file.js";
import type { CodeSymbol, SymbolKind } from "../types.js";
import {
  checkoutTopLevel,
  defaultBaseRef,
  diffAgainst,
  intersectsAddedLines,
  mainCheckoutRoot,
  mergeBaseWith,
  parseAddedLines,
  untrackedFiles,
  type LineRange,
} from "./dup-check-git.js";

export { DupCheckUsageError } from "./dup-check-git.js";

export const DEFAULT_DUP_THRESHOLD = 0.85;
export const DEFAULT_DUP_MIN_LINES = 8;
const MAX_MATCHES_PER_SYMBOL = 3;
const SUPPRESSION_LOOKBACK = 3;

// ---------------------------------------------------------------------------
// Suppression marker
// ---------------------------------------------------------------------------

const MARKER_RE = /codesift-dup-ok:(.*)$/;

/**
 * The reason given by a `codesift-dup-ok: <reason>` marker within three lines above the symbol or
 * inside its body, or null. A marker with no reason does not count — an unexplained exemption is
 * exactly the copy the gate exists to question.
 */
export function suppressionReason(fileLines: readonly string[], startLine: number, endLine: number): string | null {
  const from = Math.max(1, startLine - SUPPRESSION_LOOKBACK);
  for (let n = from; n <= Math.min(endLine, fileLines.length); n++) {
    const m = MARKER_RE.exec(fileLines[n - 1]!);
    if (!m) continue;
    const reason = m[1]!.replace(/(\*\/|-->|#\})\s*$/, "").trim();
    if (reason.length > 0) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface DupSymbolRef {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
}

export interface DupMatch {
  existing: DupSymbolRef;
  similarity: number;
  shared_lines: number;
  exact: boolean;
}

interface Prepared {
  ref: DupSymbolRef;
  lines: string[];
  hash: number;
  key: string;
}

export type SourceSymbol = DupSymbolRef & { source?: string | undefined };

function refOf(sym: SourceSymbol): DupSymbolRef {
  return { name: sym.name, kind: sym.kind, file: sym.file, start_line: sym.start_line, end_line: sym.end_line };
}

function keyOf(sym: DupSymbolRef): string {
  return `${sym.file}\0${sym.name}\0${sym.start_line}`;
}

/**
 * Compares every changed symbol with each symbol it is offered. A symbol is never compared with
 * its own previous version (same file AND same name). Two changed symbols that match are reported
 * from both sides here; `classifyMatches` keeps one.
 *
 * An offered symbol is first scored against an inverted index of the changed symbols' lines, so the
 * cost per candidate is its own line count plus the postings it hits — not one `computeSimilarity`
 * per changed symbol. That keeps a whole-index scan flat when a branch changes hundreds of
 * functions; `computeSimilarity` then confirms the few that share enough lines.
 */
export class DupMatcher {
  private readonly changed: Prepared[];
  private readonly matches = new Map<string, DupMatch[]>();
  private readonly postings = new Map<string, number[]>();
  private readonly sharedCounts: Int32Array;
  private readonly lineFloor: number;

  constructor(
    changedSymbols: readonly SourceSymbol[],
    private readonly threshold: number,
    private readonly minLines: number,
  ) {
    this.changed = [];
    for (const sym of changedSymbols) {
      if (!sym.source) continue;
      const lines = normalizeSource(sym.source);
      if (lines.length < minLines) continue;
      const index = this.changed.length;
      this.changed.push({ ref: refOf(sym), lines, hash: hashLines(lines), key: keyOf(sym) });
      for (const line of new Set(lines)) {
        const list = this.postings.get(line);
        if (list) list.push(index);
        else this.postings.set(line, [index]);
      }
    }
    this.sharedCounts = new Int32Array(this.changed.length);
    const shortest = this.changed.reduce((m, c) => Math.min(m, c.lines.length), Number.POSITIVE_INFINITY);
    this.lineFloor = Math.max(minLines, Math.ceil(shortest / MAX_LINE_RATIO));
  }

  /** Changed symbols long enough to be checked at all. */
  get checked(): DupSymbolRef[] {
    return this.changed.map((c) => c.ref);
  }

  /**
   * The fewest raw lines a candidate can span and still match: its normalised length must be at
   * least `minLines` and within MAX_LINE_RATIO of the shortest changed symbol, and normalising never
   * adds lines. Pushed down to the store, it drops most of a large index before any source is read.
   */
  get candidateLineFloor(): number {
    return this.lineFloor;
  }

  offer(sym: SourceSymbol): void {
    if (!sym.source || this.changed.length === 0) return;
    if (sym.end_line - sym.start_line + 1 < this.lineFloor) return;
    const lines = normalizeSource(sym.source);
    if (lines.length < this.minLines) return;

    const hit: number[] = [];
    for (const line of new Set(lines)) {
      const list = this.postings.get(line);
      if (!list) continue;
      for (const i of list) {
        const count = this.sharedCounts[i] ?? 0;
        if (count === 0) hit.push(i);
        this.sharedCounts[i] = count + 1;
      }
    }
    let hash: number | undefined;
    for (const i of hit) {
      const shared = this.sharedCounts[i] ?? 0;
      this.sharedCounts[i] = 0;
      if (shared < this.minLines) continue;
      const entry = this.changed[i]!;
      if (entry.ref.file === sym.file && entry.ref.name === sym.name) continue;
      const longer = Math.max(lines.length, entry.lines.length);
      const shorter = Math.min(lines.length, entry.lines.length);
      if (longer > shorter * MAX_LINE_RATIO) continue;
      const { similarity, sharedLines } = computeSimilarity(entry.lines, lines);
      if (similarity < this.threshold || sharedLines < this.minLines) continue;
      hash ??= hashLines(lines);
      const list = this.matches.get(entry.key) ?? [];
      list.push({ existing: refOf(sym), similarity, shared_lines: sharedLines, exact: hash === entry.hash });
      this.matches.set(entry.key, list);
    }
  }

  /** Every match per changed symbol, best first. */
  results(): DupResult[] {
    const out: DupResult[] = [];
    for (const entry of this.changed) {
      const list = this.matches.get(entry.key);
      if (!list || list.length === 0) continue;
      list.sort((a, b) => b.similarity - a.similarity || b.shared_lines - a.shared_lines);
      out.push({ symbol: entry.ref, matches: list });
    }
    return out;
  }
}

export interface DupResult {
  symbol: DupSymbolRef;
  matches: DupMatch[];
}

export interface DupFinding {
  new: DupSymbolRef;
  existing: DupSymbolRef;
  similarity: number;
  shared_lines: number;
  exact: boolean;
}

export interface DupAllowed extends DupFinding {
  reason: string;
}

/**
 * Split matches into findings and allowed (suppressed) ones. Each pair is reported once: when both
 * sides are new, the side WITHOUT a suppression marker becomes "new", so marking one copy as
 * intentional cannot hide the other. At most three matches per symbol, after `exists` drops
 * matches in files this checkout no longer has.
 */
export function classifyMatches(
  results: readonly DupResult[],
  reasonOf: (symbol: DupSymbolRef) => string | null,
  exists: (file: string) => boolean = () => true,
): { findings: DupFinding[]; allowed: DupAllowed[] } {
  const withReason = results.map((r) => ({ ...r, reason: reasonOf(r.symbol) }));
  withReason.sort((a, b) => Number(a.reason !== null) - Number(b.reason !== null));
  const seen = new Set<string>();
  const findings: DupFinding[] = [];
  const allowed: DupAllowed[] = [];
  for (const { symbol, matches, reason } of withReason) {
    let kept = 0;
    for (const m of matches) {
      if (kept >= MAX_MATCHES_PER_SYMBOL) break;
      if (!exists(m.existing.file)) continue;
      const pair = [keyOf(symbol), keyOf(m.existing)].sort().join("\n");
      if (seen.has(pair)) continue;
      seen.add(pair);
      kept++;
      const finding: DupFinding = { new: symbol, ...m };
      if (reason !== null) allowed.push({ ...finding, reason });
      else findings.push(finding);
    }
  }
  return { findings, allowed };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DupCheckOptions {
  cwd: string;
  base?: string | undefined;
  repo?: string | undefined;
  threshold?: number | undefined;
  minLines?: number | undefined;
}

export interface DupCheckResult {
  status: "clean" | "duplicates" | "not_indexed";
  repo: string | null;
  base: string;
  merge_base: string;
  threshold: number;
  min_lines: number;
  changed_files: number;
  checked_symbols: number;
  scanned_symbols: number;
  findings: DupFinding[];
  allowed: DupAllowed[];
}

/** Paths of `paths` (relative to `topLevel`) that live under the index root, made index-relative. */
function toIndexRelative(paths: Iterable<string>, topLevel: string, indexRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    const rel = relative(indexRoot, join(topLevel, p));
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    out.set(rel.split(sep).join("/"), p);
  }
  return out;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isTestPath(file: string): boolean {
  // Leading slash so a top-level `tests/` or `test/` directory matches the `/tests/` pattern.
  return isTestFileStrict(`/${file}`);
}

async function resolveIndex(
  topLevel: string,
  explicit: string | undefined,
): Promise<{ name: string; indexRootInCheckout: string } | null> {
  const { loadConfig } = await import("../config.js");
  const { getRepoName, resolveRegisteredRepoMeta } = await import("../storage/registry.js");
  const registryPath = loadConfig().registryPath;
  const mainRoot = mainCheckoutRoot(topLevel);

  const candidates: Array<{ input: string; checkoutRoot: string | null }> = explicit
    ? [{ input: explicit, checkoutRoot: null }]
    : [
        { input: getRepoName(topLevel), checkoutRoot: topLevel },
        ...(mainRoot ? [{ input: getRepoName(mainRoot), checkoutRoot: mainRoot }] : []),
      ];

  for (const { input, checkoutRoot } of candidates) {
    const resolved = await resolveRegisteredRepoMeta(registryPath, input);
    if (!resolved) continue;
    const root = realOrSelf(resolved.meta.root);
    // Where the index root sits inside the checkout. An explicit --repo may name the main checkout's
    // entry or another clone entirely; assume the index covers the checkout root when it is neither.
    const roots = checkoutRoot ? [checkoutRoot] : [topLevel, ...(mainRoot ? [mainRoot] : [])];
    let inner = "";
    for (const r of roots) {
      const rel = relative(realOrSelf(r), root);
      if (!rel.startsWith("..") && !isAbsolute(rel)) { inner = rel; break; }
    }
    return {
      name: resolved.resolvedName,
      indexRootInCheckout: join(topLevel, inner),
    };
  }
  return null;
}

export async function runDupCheck(options: DupCheckOptions): Promise<DupCheckResult> {
  const threshold = options.threshold ?? DEFAULT_DUP_THRESHOLD;
  const minLines = options.minLines ?? DEFAULT_DUP_MIN_LINES;
  const topLevel = realOrSelf(checkoutTopLevel(options.cwd));
  const base = options.base ?? defaultBaseRef(topLevel);
  const mergeBase = mergeBaseWith(topLevel, base);

  const result: DupCheckResult = {
    status: "clean", repo: null, base, merge_base: mergeBase, threshold, min_lines: minLines,
    changed_files: 0, checked_symbols: 0, scanned_symbols: 0, findings: [], allowed: [],
  };

  const index = await resolveIndex(topLevel, options.repo);
  const { getIndexSummary, streamRepoSymbols } = await import("./index-tools.js");
  if (!index || !(await getIndexSummary(index.name, { skipFreshness: true }))) {
    result.status = "not_indexed";
    return result;
  }
  result.repo = index.name;

  const { added, touched } = parseAddedLines(diffAgainst(topLevel, mergeBase));
  const untracked = untrackedFiles(topLevel);
  for (const f of untracked) touched.add(f);
  const workRoot = index.indexRootInCheckout;
  const touchedRel = toIndexRelative(touched, topLevel, workRoot);
  const addedRel = new Map<string, LineRange[] | "all">();
  const untrackedSet = new Set(untracked);
  for (const [rel, git] of touchedRel) {
    const ranges = untrackedSet.has(git) ? "all" : added.get(git);
    if (ranges) addedRel.set(rel, ranges);
  }

  // Parse every touched production file as it is NOW: its changed symbols are the ones to check,
  // and its other symbols replace the index's (possibly stale) copy of that file in the pool.
  const { parseOneFile } = await import("./index-tools/parse.js");
  const fresh: CodeSymbol[] = [];
  const changed: CodeSymbol[] = [];
  const fileLines = new Map<string, string[]>();
  for (const rel of touchedRel.keys()) {
    if (isTestPath(rel)) continue;
    const abs = join(workRoot, rel);
    if (!existsSync(abs)) continue;
    const parsed = await parseOneFile(abs, workRoot, index.name);
    if (!parsed) continue;
    const ranges = addedRel.get(rel);
    for (const sym of parsed.symbols) {
      if (!ANALYZABLE_KINDS.has(sym.kind) || !sym.source) continue;
      fresh.push(sym);
      if (ranges && (ranges === "all" || intersectsAddedLines(sym.start_line, sym.end_line, ranges))) {
        changed.push(sym);
      }
    }
    if (ranges) fileLines.set(rel, readFileSync(abs, "utf-8").split("\n"));
  }
  result.changed_files = addedRel.size;

  const matcher = new DupMatcher(changed, threshold, minLines);
  result.checked_symbols = matcher.checked.length;
  if (result.checked_symbols === 0) return result;

  for (const sym of fresh) matcher.offer(sym);
  let scanned = 0;
  await streamRepoSymbols(
    index.name,
    { withSource: true, kinds: [...ANALYZABLE_KINDS], minLines: matcher.candidateLineFloor },
    (batch) => {
      for (const sym of batch) {
        if (touchedRel.has(sym.file) || isTestPath(sym.file)) continue;
        scanned++;
        matcher.offer(sym);
      }
    },
    { skipFreshness: true },
  );
  result.scanned_symbols = scanned + fresh.length;

  // An index of another checkout (the main one, or a stale entry) can hold files this tree no
  // longer has; a "copy" of code that is not here is not a copy.
  const present = new Map<string, boolean>();
  const exists = (file: string): boolean => {
    let v = present.get(file);
    if (v === undefined) {
      v = existsSync(join(workRoot, file));
      present.set(file, v);
    }
    return v;
  };
  const reasonOf = (sym: DupSymbolRef): string | null =>
    suppressionReason(fileLines.get(sym.file) ?? [], sym.start_line, sym.end_line);

  const { findings, allowed } = classifyMatches(matcher.results(), reasonOf, exists);
  result.findings = findings;
  result.allowed = allowed;
  result.status = findings.length > 0 ? "duplicates" : "clean";
  return result;
}
