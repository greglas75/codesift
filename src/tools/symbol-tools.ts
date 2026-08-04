import { readFile, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { searchBM25, type BM25Index } from "../search/bm25.js";
import { findReferencesLsp } from "../lsp/lsp-tools.js";
import { loadConfig } from "../config.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import { detectFrameworks, isFrameworkEntryPoint } from "../utils/framework-detect.js";
import { getCodeIndex, getBM25Index } from "./index-tools.js";
import { REACT_STDLIB_HOOKS, extractHookNames } from "./react-tools.js";
import type { CodeIndex, CodeSymbol, Reference, SymbolKind } from "../types.js";

const MAX_REFERENCES = 100;
const MAX_DEAD_CODE_RESULTS = 100;
const MAX_CONTEXT_LENGTH = 200; // Truncate context lines to prevent huge output from minified files

/** Skip build artifacts and binary files — docs/audits are intentionally kept */
const NOISE_PATH_PREFIXES = [".next/", "dist/", "build/", "coverage/", "node_modules/", "__snapshots__/"];
const NOISE_EXTENSIONS = new Set([".snap", ".lock", ".map", ".svg", ".png", ".jpg", ".ico", ".woff", ".woff2"]);

function isNoisePath(filePath: string): boolean {
  if (NOISE_PATH_PREFIXES.some((p) => filePath.startsWith(p))) return true;
  const dot = filePath.lastIndexOf(".");
  if (dot >= 0 && NOISE_EXTENSIONS.has(filePath.slice(dot))) return true;
  return false;
}

/**
 * Find symbols with names similar to the requested ID. Used to recover from
 * hallucinated symbol IDs (telemetry shows 24-26% of get_symbol/get_symbols
 * calls return zero results). Extracts a name candidate from the requested
 * ID and returns up to `limit` symbols whose name matches case-insensitively.
 */
/**
 * Resolve a non-canonical symbol reference to a real symbol ID when it is
 * UNAMBIGUOUS.
 *
 * Symbol IDs are `repo:file:name:line` — they embed the declaration line, so no
 * caller can construct one by hand. Agents therefore pass a bare name
 * ("getOptions") or a half-remembered path, and the lookup returns null; the
 * measured miss rate was 24% of get_symbol calls and 26% of get_symbols. The old
 * behaviour answered with a suggestion list, which is a second round trip for a
 * question we can already answer.
 *
 * Only an EXACT, SINGLE name match resolves. Two symbols named `handler` must
 * stay ambiguous — silently picking one would return the wrong source with no
 * signal, which is worse than the miss it replaces.
 */
/**
 * Best-effort symbol NAME out of whatever the caller passed.
 *
 * Symbol IDs end in the declaration line (`repo:file:name:LINE`), so naively
 * taking the last segment yields "42" and matches nothing — every suggestion for
 * a well-formed-but-stale id was silently useless. Skip trailing numeric
 * segments, then fall back to the last non-empty one.
 */
export function extractSymbolNameGuess(requestedId: string): string {
  const parts = requestedId.split(/[:#/.]/).map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as string;
    if (!/^\d+$/.test(p)) return p;
  }
  return requestedId.trim();
}

export async function resolveSymbolIdExact(
  repo: string,
  requestedId: string,
): Promise<string | null> {
  const nameGuess = extractSymbolNameGuess(requestedId);
  if (!nameGuess) return null;

  const index = await getCodeIndex(repo, { skipFreshness: true });
  if (!index) return null;

  let match: string | null = null;
  for (const s of index.symbols) {
    if (s.name !== nameGuess) continue;
    if (match) return null; // ambiguous — let the caller show suggestions
    match = s.id;
  }
  return match;
}

export async function findSimilarSymbols(
  repo: string,
  requestedId: string,
  limit = 3,
): Promise<Array<{ id: string; name: string; kind: string; file: string; start_line: number }>> {
  const index = await getCodeIndex(repo, { skipFreshness: true });
  if (!index) return [];

  const nameGuess = extractSymbolNameGuess(requestedId);
  if (!nameGuess) return [];
  const lower = nameGuess.toLowerCase();

  const exact: typeof index.symbols = [];
  const prefix: typeof index.symbols = [];
  const substr: typeof index.symbols = [];

  for (const s of index.symbols) {
    const sn = s.name.toLowerCase();
    if (sn === lower) exact.push(s);
    else if (sn.startsWith(lower) || lower.startsWith(sn)) prefix.push(s);
    else if (sn.includes(lower) || lower.includes(sn)) substr.push(s);
    if (exact.length >= limit) break;
  }

  const ranked = [...exact, ...prefix, ...substr].slice(0, limit);
  return ranked.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    file: s.file,
    start_line: s.start_line,
  }));
}

async function requireCodeIndex(repo: string): Promise<CodeIndex> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }
  return index;
}

async function requireBM25Index(repo: string): Promise<BM25Index> {
  const index = await getBM25Index(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }
  return index;
}

function wordBoundaryPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`);
}

/**
 * Strip internal/BM25 fields from CodeSymbol for leaner output.
 * Removes: repo, tokens, start_col, end_col. Shortens id (strips repo prefix).
 */
function stripSymbol(sym: CodeSymbol): Omit<CodeSymbol, "repo" | "tokens" | "start_col" | "end_col" | "start_byte" | "end_byte"> {
  const { repo: _repo, tokens: _tokens, start_col: _sc, end_col: _ec, start_byte: _sb, end_byte: _eb, id, ...rest } = sym;
  // Strip "local/reponame:" prefix from id
  const shortId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return { ...rest, id: shortId };
}

/**
 * Read a source file and extract lines for a symbol (1-based, inclusive).
 * Uses byte offsets when available for precise reads without loading full file.
 * Returns undefined if the file cannot be read.
 */
async function extractSource(
  repoRoot: string,
  file: string,
  startLine: number,
  endLine: number,
  startByte?: number,
  endByte?: number,
): Promise<string | undefined> {
  const filePath = join(repoRoot, file);

  // Fast path: use byte offsets to read exact range
  if (startByte != null && endByte != null && endByte > startByte) {
    try {
      const fh = await open(filePath, "r");
      try {
        const length = endByte - startByte;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, startByte);
        return buf.toString("utf-8");
      } finally {
        await fh.close();
      }
    } catch {
      // Fall through to line-based extraction
    }
  }

  // Fallback: line-based extraction
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(startLine - 1, endLine).join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Retrieve a single symbol by ID with fresh source from disk.
 * When include_related is true (default), auto-prefetches:
 *  - children (for classes/interfaces) — saves follow-up get_symbols call
 *  - symbols in the same file that reference this symbol — saves find_references call
 */
/**
 * Raised when one id maps to several distinct symbols.
 *
 * A named type rather than a bare `Error` because two callers must tell this apart from a real
 * failure, and matching on message text would break the moment the wording changes. Structural
 * check, not `instanceof`: a duplicated module instance across a worker or bundler boundary makes
 * `instanceof` false for an object that is in every observable way the right error — the same
 * trap `isIndexStorageError` documents in the storage layer.
 */
export class AmbiguousSymbolIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousSymbolIdError";
  }
}

export function isAmbiguousSymbolIdError(err: unknown): err is AmbiguousSymbolIdError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AmbiguousSymbolIdError"
  );
}

/**
 * Resolve a search hit to its full symbol, tolerating an ambiguous id.
 *
 * `getSymbol` throwing on a colliding id is right when a caller supplies one: it named a specific
 * symbol and must not silently receive a different one. Here nobody supplied it — the id was read
 * back off a BM25 hit whose symbol this function already holds. Failing an entire search because
 * its top hit happens to sit in a minified bundle would make the collision a worse answer than the
 * silent substitution it replaced, and it would hit `find_and_show` and `get_context_bundle`, the
 * two tools the H7/H8 hints steer agents toward. Falling back to the hit is not a guess: it is the
 * result the search actually returned.
 */
export interface SymbolIdAmbiguity {
  /** Always present. `ambiguous` means the answer is the search's top hit, not a unique resolution. */
  status: "unique" | "ambiguous";
  /** Set only when ambiguous: how many distinct symbols share the id. */
  shared_by?: number;
  /** Set only when ambiguous: the other candidates, so the caller can pick deliberately. */
  candidates?: Array<{ name: string; kind: SymbolKind; file: string; start_line: number }>;
}

async function resolveSearchHit(
  repo: string,
  hit: CodeSymbol,
): Promise<{ symbol: CodeSymbol; ambiguity: SymbolIdAmbiguity } | null> {
  try {
    const full = await getSymbol(repo, hit.id, { include_related: false });
    return full ? { symbol: full.symbol, ambiguity: { status: "unique" } } : null;
  } catch (err) {
    if (!isAmbiguousSymbolIdError(err)) throw err;
    // Falling back is defensible; falling back SILENTLY is not. The caller is being handed one of
    // several symbols and has no way to tell from the result — which is the same silence the
    // `lossy_migration` marker was added to remove one layer down.
    const index = await requireCodeIndex(repo);
    const candidates = index.symbols
      .filter((s) => s.id === hit.id)
      .map((s) => ({ name: s.name, kind: s.kind, file: s.file, start_line: s.start_line }));
    return {
      symbol: hit,
      ambiguity: { status: "ambiguous", shared_by: candidates.length, candidates: candidates.slice(0, 5) },
    };
  }
}

export async function getSymbol(
  repo: string,
  symbolId: string,
  options?: { include_related?: boolean },
): Promise<{ symbol: CodeSymbol; related?: CodeSymbol[] } | null> {
  const index = await requireCodeIndex(repo);
  const includeRelated = options?.include_related ?? true;

  // `repo:file:name:line` is NOT unique — a minified bundle puts many symbols on line 1, and
  // PHPDoc synthesis emits a field and a method at the same line (73,165 collisions measured
  // across 16 indexes). `.find` would hand back whichever happened to load first, with no
  // signal: the caller then reads source for a symbol it did not ask for. This file already
  // states the rule for names ("two symbols named `handler` must stay ambiguous — silently
  // picking one is worse than the miss it replaces"); it was never applied to ids because they
  // were assumed unique.
  const matches = index.symbols.filter((s) => s.id === symbolId);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const where = matches
      .map((s) => `${s.kind} ${s.name} @ ${s.file}:${s.start_line}`)
      .slice(0, 5)
      .join("; ");
    throw new AmbiguousSymbolIdError(
      `Symbol id "${symbolId}" is ambiguous — ${matches.length} distinct symbols share it: ${where}. ` +
        `Ids embed only file, name and line, which collide in generated or synthesised code. ` +
        `Use search_symbols to pick the one you mean.`,
    );
  }
  const symbol = matches[0]!;

  const source = await extractSource(
    index.root,
    symbol.file,
    symbol.start_line,
    symbol.end_line,
    symbol.start_byte,
    symbol.end_byte,
  );

  const result = { ...symbol };
  if (source !== undefined) {
    result.source = source;
  }

  const stripped = stripSymbol(result) as CodeSymbol;

  if (!includeRelated) {
    return { symbol: stripped };
  }

  // Prefetch children for classes/interfaces
  const related: CodeSymbol[] = [];
  if (symbol.kind === "class" || symbol.kind === "interface") {
    const children = index.symbols.filter((s) => s.parent === symbol.id);
    for (const child of children.slice(0, 20)) {
      related.push(stripSymbol(child) as CodeSymbol);
    }
  }

  const out: { symbol: CodeSymbol; related?: CodeSymbol[] } = { symbol: stripped };
  if (related.length > 0) out.related = related;
  return out;
}

/**
 * Retrieve multiple symbols by ID with fresh source from disk.
 * Groups reads by file to minimize disk I/O.
 */
export async function getSymbols(
  repo: string,
  symbolIds: string[],
): Promise<CodeSymbol[]> {
  const index = await requireCodeIndex(repo);

  // Build lookup map for requested symbols.
  //
  // A colliding id must be refused here for the same reason `getSymbol` refuses it: ids are
  // `repo:file:name:line` and that is not unique, so `.set()` on a repeated id was last-write-wins
  // — the caller asked for one symbol and silently received whichever happened to come later in
  // the array. Leaving the batch path permissive would have meant two entry points in this file
  // disagreeing about the same input, one throwing and one substituting, which is worse than
  // either rule applied consistently.
  const requestedIds = new Set(symbolIds);
  const symbolMap = new Map<string, CodeSymbol>();
  const collisions = new Map<string, CodeSymbol[]>();
  for (const sym of index.symbols) {
    if (!requestedIds.has(sym.id)) continue;
    const seen = symbolMap.get(sym.id);
    if (seen === undefined) {
      symbolMap.set(sym.id, sym);
      continue;
    }
    const group = collisions.get(sym.id) ?? [seen];
    group.push(sym);
    collisions.set(sym.id, group);
  }
  if (collisions.size > 0) {
    const detail = [...collisions.entries()]
      .slice(0, 3)
      .map(([id, group]) => {
        const where = group
          .slice(0, 5)
          .map((s) => `${s.kind} ${s.name} @ ${s.file}:${s.start_line}`)
          .join("; ");
        return `"${id}" -> ${group.length} symbols: ${where}`;
      })
      .join(" | ");
    throw new AmbiguousSymbolIdError(
      `${collisions.size} of the requested ids are ambiguous — ${detail}. ` +
        `Ids embed only file, name and line, which collide in generated or synthesised code. ` +
        `Use search_symbols to pick the ones you mean.`,
    );
  }

  // Group symbols by file to read each file only once
  const byFile = new Map<string, CodeSymbol[]>();
  for (const id of symbolIds) {
    const sym = symbolMap.get(id);
    if (!sym) continue;

    let group = byFile.get(sym.file);
    if (!group) {
      group = [];
      byFile.set(sym.file, group);
    }
    group.push(sym);
  }

  // Read all files in parallel, extract source for all symbols in each file
  const results = new Map<string, CodeSymbol>();

  const fileEntries = [...byFile.entries()];
  const fileContents = await Promise.all(
    fileEntries.map(([file]) =>
      readFile(join(index.root, file), "utf-8").catch(() => undefined),
    ),
  );

  for (let i = 0; i < fileEntries.length; i++) {
    const [, symbols] = fileEntries[i]!;
    const lines = fileContents[i]?.split("\n");

    for (const sym of symbols) {
      const result = { ...sym };
      if (lines) {
        result.source = lines.slice(sym.start_line - 1, sym.end_line).join("\n");
      }
      results.set(sym.id, result);
    }
  }

  // Return in the same order as requested, skipping missing IDs
  const ordered: CodeSymbol[] = [];
  for (const id of symbolIds) {
    const sym = results.get(id);
    if (sym) ordered.push(stripSymbol(sym) as CodeSymbol);
  }

  return ordered;
}

/**
 * Find references to a symbol name across indexed files.
 * Matches whole words only using word-boundary regex.
 */
/**
 * Batch find references for multiple symbols in one pass.
 * Reads each file once instead of N times — critical for large repos.
 */
/**
 * What a reference scan actually looked at.
 *
 * `find_references` returning `[]` is the input to "nobody uses this, safe to rename or delete".
 * That inference is only valid if the scan saw everywhere a reference could be. It routinely does
 * not: generated and vendored paths are skipped by default, files can be unreadable, and per
 * symbol the collection stops at MAX_REFERENCES. None of that was visible in the result.
 *
 * Filled through a caller-supplied sink so the `Record<string, Reference[]>` return shape — which
 * several call sites slice and re-key — stays untouched.
 */
export interface ReferenceScanCoverage {
  /** `unknown` is the honest default when the scan did not report — never assume `complete`. */
  status: "complete" | "partial" | "unknown";
  files_indexed: number;
  files_scanned: number;
  /** Generated/vendored paths skipped because no file_pattern was given. */
  files_skipped_noise?: number;
  files_unreadable?: number;
  /** Symbols whose reference list hit MAX_REFERENCES — their counts are floors, not totals. */
  capped_symbols?: string[];
  detail?: string;
}

export interface ReferenceScanSink {
  coverage?: ReferenceScanCoverage;
}

export async function findReferencesBatch(
  repo: string,
  symbolNames: string[],
  filePattern?: string,
  sink?: ReferenceScanSink,
): Promise<Record<string, Reference[]>> {
  const index = await requireCodeIndex(repo);
  const patterns = symbolNames.map((name) => ({
    name,
    regex: wordBoundaryPattern(name),
  }));

  const fileFilter = filePattern
    ? new RegExp(filePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"))
    : null;

  const result: Record<string, Reference[]> = {};
  for (const name of symbolNames) result[name] = [];

  let filesScanned = 0;
  let filesSkippedNoise = 0;
  let filesUnreadable = 0;

  for (const fileEntry of index.files) {
    if (fileFilter && !fileFilter.test(fileEntry.path)) continue;
    if (!filePattern && isNoisePath(fileEntry.path)) {
      // Sensible default — but it means "no references" really means "none outside generated
      // and vendored code", and the caller could not tell that scoping had happened.
      filesSkippedNoise++;
      continue;
    }

    let content: string;
    try {
      content = await readFile(join(index.root, fileEntry.path), "utf-8");
      filesScanned++;
    } catch {
      // A reference living only in a file we could not read is invisible here, and the symbol
      // then looks unused.
      filesUnreadable++;
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      for (const { name, regex } of patterns) {
        const refs = result[name]!;
        if (refs.length >= MAX_REFERENCES) continue;
        const match = regex.exec(line);
        if (match) {
          const rawContext = line.trimEnd();
          refs.push({
            file: fileEntry.path,
            line: i + 1,
            col: match.index + 1,
            context: rawContext.length > MAX_CONTEXT_LENGTH
              ? rawContext.slice(0, MAX_CONTEXT_LENGTH) + "..."
              : rawContext,
          });
        }
      }
    }
  }

  if (sink) {
    const capped = symbolNames.filter((n) => (result[n]?.length ?? 0) >= MAX_REFERENCES);
    const complete = filesSkippedNoise === 0 && filesUnreadable === 0 && capped.length === 0;
    const reasons: string[] = [];
    if (filesSkippedNoise > 0) {
      reasons.push(`${filesSkippedNoise} generated/vendored files skipped (pass file_pattern to include them)`);
    }
    if (filesUnreadable > 0) reasons.push(`${filesUnreadable} files could not be read`);
    if (capped.length > 0) reasons.push(`${capped.length} symbol(s) hit the ${MAX_REFERENCES}-reference cap`);
    sink.coverage = {
      status: complete ? "complete" : "partial",
      files_indexed: index.files.length,
      files_scanned: filesScanned,
      ...(filesSkippedNoise > 0 ? { files_skipped_noise: filesSkippedNoise } : {}),
      ...(filesUnreadable > 0 ? { files_unreadable: filesUnreadable } : {}),
      ...(capped.length > 0 ? { capped_symbols: capped } : {}),
      ...(complete
        ? {}
        : {
            detail:
              `${reasons.join("; ")} — an empty or short result is about what was scanned, ` +
              `not proof the symbol is unused`,
          }),
    };
  }

  return result;
}

const SEARCH_TIMEOUT_MS = 30_000;

/** Directories to exclude from ripgrep reference search */
const RG_EXCLUDE_DIRS = [
  "node_modules", ".git", ".next", "dist", ".codesift", "coverage",
  ".playwright-mcp", "__pycache__", "__snapshots__",
];

/** Detect whether `rg` (ripgrep) is available. Cached at module level. */
let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 2000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/**
 * Find references using ripgrep with word-boundary matching.
 * Returns compact `file:line: context` string when results ≤ threshold.
 */
function findReferencesWithRipgrep(
  root: string,
  symbolName: string,
  maxResults: number,
  filePattern?: string,
): Reference[] | string {
  const args: string[] = [
    "-n", "--no-heading", "-w",
    "--max-columns", String(MAX_CONTEXT_LENGTH),
    "--max-columns-preview",
    "--max-count", String(Math.min(maxResults * 2, 5000)),
  ];

  // Exclude noise dirs
  for (const dir of RG_EXCLUDE_DIRS) {
    args.push("--glob", `!${dir}`);
  }
  // Exclude noise extensions
  for (const ext of [".snap", ".lock", ".map", ".svg", ".png", ".jpg", ".ico", ".woff", ".woff2", ".md", ".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".html"]) {
    args.push("--glob", `!*${ext}`);
  }

  if (filePattern) {
    args.push("--glob", filePattern);
  } else {
    // Default to code files only (matches what agent would grep for)
    args.push("--type-add", "code:*.{ts,tsx,js,jsx,py,go,rs,java,kt,kts,rb,php,vue,svelte}");
    args.push("--type", "code");
  }

  args.push("--", symbolName, root);

  let stdout: string;
  try {
    stdout = execFileSync("rg", args, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: SEARCH_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      if ((err as { status: number }).status === 1) return []; // no matches
      if ("stdout" in err && typeof (err as { stdout: unknown }).stdout === "string") {
        stdout = (err as { stdout: string }).stdout;
        if (!stdout) return [];
      } else {
        return [];
      }
    } else {
      return [];
    }
  }

  const rootPrefix = root.endsWith("/") ? root : root + "/";
  const lines = stdout.split("\n").filter(Boolean);
  const refs: Reference[] = [];

  for (const rawLine of lines) {
    if (refs.length >= maxResults) break;

    const match = rawLine.match(/^(.+?):(\d+):(.*)/);
    if (!match || !match[1] || !match[2] || match[3] === undefined) continue;

    const absPath = match[1];
    const relPath = absPath.startsWith(rootPrefix) ? absPath.slice(rootPrefix.length) : absPath;
    if (isNoisePath(relPath)) continue;

    refs.push({
      file: relPath,
      line: parseInt(match[2], 10),
      context: match[3].length > MAX_CONTEXT_LENGTH ? match[3].slice(0, MAX_CONTEXT_LENGTH) + "..." : match[3],
    });
  }

  return refs;
}

export async function findReferences(
  repo: string,
  symbolName: string,
  filePattern?: string,
): Promise<Reference[]> {
  // Try LSP first (type-safe, no false positives)
  const lspRefs = await findReferencesLsp(repo, symbolName);
  if (lspRefs !== null) return lspRefs;

  // Use ripgrep when available (10x+ faster than Node.js file walk)
  if (hasRipgrep()) {
    const index = await requireCodeIndex(repo);
    const result = findReferencesWithRipgrep(index.root, symbolName, MAX_REFERENCES, filePattern);
    // ripgrep helper may return compact string; convert back to Reference[]
    if (typeof result === "string") {
      return result.split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^(.+?):(\d+): (.*)/);
        return m ? { file: m[1]!, line: parseInt(m[2]!, 10), context: m[3]! } : { file: "", line: 0, context: line };
      });
    }
    return result;
  }

  // Node.js fallback
  const index = await requireCodeIndex(repo);
  const pattern = wordBoundaryPattern(symbolName);
  const searchStart = Date.now();

  const fileFilter = filePattern
    ? new RegExp(filePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"))
    : null;

  const refs: Reference[] = [];

  for (const fileEntry of index.files) {
    if (refs.length >= MAX_REFERENCES) break;
    if (Date.now() - searchStart > SEARCH_TIMEOUT_MS) break;

    if (fileFilter && !fileFilter.test(fileEntry.path)) continue;
    if (!filePattern && isNoisePath(fileEntry.path)) continue;

    let content: string;
    try {
      content = await readFile(join(index.root, fileEntry.path), "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (refs.length >= MAX_REFERENCES) break;

      const line = lines[i];
      if (line === undefined) continue;
      const match = pattern.exec(line);
      if (match) {
        const rawContext = line.trimEnd();
        refs.push({
          file: fileEntry.path,
          line: i + 1,
          context: rawContext.length > MAX_CONTEXT_LENGTH
            ? rawContext.slice(0, MAX_CONTEXT_LENGTH) + "..."
            : rawContext,
        });
      }
    }
  }

  return refs;
}

/** Format references as compact string for MCP output. Groups by file to avoid repeating paths. */
export function formatRefsCompact(refs: Reference[]): string {
  if (refs.length === 0) return "";
  // Group by file
  const groups = new Map<string, string[]>();
  for (const r of refs) {
    let g = groups.get(r.file);
    if (!g) { g = []; groups.set(r.file, g); }
    g.push(`  ${r.line}: ${r.context}`);
  }
  if (groups.size === refs.length) {
    // Each file has 1 ref — flat is fine
    return refs.map((r) => `${r.file}:${r.line}: ${r.context}`).join("\n");
  }
  const parts: string[] = [];
  for (const [file, lines] of groups) {
    parts.push(`${file}\n${lines.join("\n")}`);
  }
  return parts.join("\n");
}

/** Format a CodeSymbol as compact text: header line + source. ~70% less tokens than JSON. */
export function formatSymbolCompact(sym: CodeSymbol): string {
  const loc = `${sym.file}:${sym.start_line}-${sym.end_line}`;
  const sig = sym.signature ? ` ${sym.signature}` : "";
  const header = `${loc} ${sym.kind} ${sym.name}${sig}`;
  if (!sym.source) return header;
  return `${header}\n${sym.source}`;
}

/** Format multiple CodeSymbols as compact text, separated by blank lines. */
export function formatSymbolsCompact(syms: CodeSymbol[]): string {
  return syms.map(formatSymbolCompact).join("\n\n");
}

/** Format ContextBundle as compact text. */
export function formatBundleCompact(bundle: { symbol: CodeSymbol; imports: string[]; siblings: Array<{ name: string; kind: string; start_line: number; end_line: number }>; types_used: string[] }): string {
  const parts: string[] = [];
  parts.push(formatSymbolCompact(bundle.symbol as CodeSymbol));
  if (bundle.imports.length > 0) {
    parts.push(`\n--- imports ---\n${bundle.imports.join("\n")}`);
  }
  if (bundle.siblings.length > 0) {
    const sibLines = bundle.siblings.map((s) => `  ${s.kind} ${s.name} :${s.start_line}-${s.end_line}`);
    parts.push(`\n--- siblings ---\n${sibLines.join("\n")}`);
  }
  if (bundle.types_used.length > 0) {
    parts.push(`\n--- types used ---\n${bundle.types_used.join(", ")}`);
  }
  return parts.join("");
}

/**
 * Search for a symbol by query and return it with full source.
 * Optionally includes references across the codebase.
 */
export async function findAndShow(
  repo: string,
  query: string,
  includeRefs?: boolean,
): Promise<
  { symbol: CodeSymbol; references?: Reference[]; id_ambiguity: SymbolIdAmbiguity } | null
> {
  const bm25Index = await requireBM25Index(repo);
  const config = loadConfig();
  const results = searchBM25(bm25Index, query, 1, config.bm25FieldWeights);

  const topResult = results[0];
  if (!topResult) return null;

  const resolved = await resolveSearchHit(repo, topResult.symbol);
  if (!resolved) return null;
  const { symbol: fullSymbol, ambiguity } = resolved;

  if (includeRefs) {
    const references = await findReferences(repo, fullSymbol.name as string);
    return { symbol: fullSymbol, references, id_ambiguity: ambiguity };
  }

  return { symbol: fullSymbol, id_ambiguity: ambiguity };
}

/**
 * Extract full import lines from file source.
 */
function extractImportLines(source: string): string[] {
  const lines = source.split("\n");
  return lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("import ") || (trimmed.startsWith("const ") && trimmed.includes("require("));
  });
}

export interface ReactContext {
  /** Props type name extracted from the component's parameter type annotation */
  props_type: string | null;
  /** Source of the props interface/type declaration when found in the index (Tier 4 — Item 16) */
  props_interface_source: string | null;
  /** React hooks called inside this component (use*() patterns) */
  hooks_used: Array<{ name: string; is_stdlib: boolean }>;
  /** Child components rendered via JSX (<PascalCase>) */
  child_components: string[];
  /** Parent components that render this one via JSX */
  parent_components: string[];
  /** Detected wrapper pattern (memo, forwardRef, lazy) or null */
  wrapper: "memo" | "forwardRef" | "lazy" | null;
}

export interface ContextBundle {
  symbol: CodeSymbol;
  imports: string[];
  siblings: Array<{ name: string; kind: SymbolKind; start_line: number; end_line: number }>;
  types_used: string[];  // type/interface names referenced in the symbol's source
  /** Only populated when symbol.kind === "component" */
  react_context?: ReactContext;
  /** Always present. Says whether `symbol` is a unique resolution or the search's top hit among
   *  several sharing one id — a distinction the caller cannot otherwise make from the result. */
  id_ambiguity: SymbolIdAmbiguity;
}

/**
 * Get a symbol with its file's imports and sibling symbols in one call.
 * Saves 2-3 round-trips vs get_symbol + search_text(imports) + get_file_outline.
 */
export async function getContextBundle(
  repo: string,
  symbolName: string,
): Promise<ContextBundle | null> {
  const bm25Index = await requireBM25Index(repo);
  const config = loadConfig();
  const results = searchBM25(bm25Index, symbolName, 1, config.bm25FieldWeights);
  const topResult = results[0];
  if (!topResult) return null;

  const index = await requireCodeIndex(repo);

  // Get full symbol with source
  const resolved = await resolveSearchHit(repo, topResult.symbol);
  if (!resolved) return null;
  const { symbol: fullSymbol, ambiguity } = resolved;

  // Read the file to extract imports
  let fileSource: string;
  try {
    fileSource = await readFile(join(index.root, fullSymbol.file), "utf-8");
  } catch {
    return {
      symbol: fullSymbol,
      imports: [],
      siblings: [],
      types_used: [],
      id_ambiguity: ambiguity,
    };
  }

  const imports = extractImportLines(fileSource);

  // Get sibling symbols (other symbols in the same file)
  const siblings = index.symbols
    .filter((s) => s.file === fullSymbol.file && s.id !== fullSymbol.id)
    .map((s) => ({
      name: s.name,
      kind: s.kind,
      start_line: s.start_line,
      end_line: s.end_line,
    }));

  // Extract type names used in the symbol's source
  const typesUsed = extractTypesUsed(fullSymbol.source ?? "", index.symbols);

  // React-specific enrichment for components
  const bundle: ContextBundle = {
    symbol: fullSymbol,
    imports,
    siblings,
    types_used: typesUsed,
    id_ambiguity: ambiguity,
  };
  if (fullSymbol.kind === "component") {
    bundle.react_context = buildReactContext(fullSymbol, index.symbols);
  }

  return bundle;
}

/**
 * Build React-specific context for a component symbol:
 * hooks used, child/parent components via JSX, wrapper pattern.
 *
 * Uses REACT_STDLIB_HOOKS imported from react-tools.js as the single source
 * of truth for stdlib hook detection (CQ14 — no duplication).
 */
function buildReactContext(
  component: CodeSymbol,
  allSymbols: CodeSymbol[],
): ReactContext {
  const source = component.source ?? "";

  // Extract hooks used (uses shared extractHookNames from react-tools.ts — CQ14)
  const hooks_used = [...extractHookNames(source)].map((name) => ({
    name,
    is_stdlib: REACT_STDLIB_HOOKS.has(name),
  }));

  // Extract child components from JSX (<PascalCase>)
  const childSet = new Set<string>();
  const jsxPattern = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = jsxPattern.exec(source)) !== null) {
    const name = m[1]!;
    if (name !== component.name) childSet.add(name);
  }
  const child_components = [...childSet].sort();

  // Extract parent components: find other components whose source uses <ThisComponent>
  const ownPattern = new RegExp(`<${component.name}\\b`);
  const parent_components = allSymbols
    .filter(
      (s) =>
        s.kind === "component" &&
        s.id !== component.id &&
        s.name !== component.name &&
        s.source &&
        ownPattern.test(s.source),
    )
    .map((s) => s.name);

  // Detect wrapper pattern from source — supports TypeScript generics:
  // forwardRef<HTMLDivElement, Props>(...), memo<Props>(...) (Item 9)
  let wrapper: "memo" | "forwardRef" | "lazy" | null = null;
  if (/\b(?:React\.)?memo\s*(?:<[^>]+>)?\s*\(/.test(source)) wrapper = "memo";
  else if (/\b(?:React\.)?forwardRef\s*(?:<[^>]+>)?\s*\(/.test(source)) wrapper = "forwardRef";
  else if (/\b(?:React\.)?lazy\s*(?:<[^>]+>)?\s*\(/.test(source)) wrapper = "lazy";

  // Extract props type from signature: (props: MyProps) or ({ a, b }: Props)
  let props_type: string | null = null;
  const sig = component.signature ?? "";
  // Pattern: (props: TypeName) or (arg: TypeName) or ({ ... }: TypeName)
  const propsMatch = sig.match(/\(\s*(?:\{[^}]*\}|\w+)\s*:\s*([A-Z]\w*)/);
  if (propsMatch) {
    props_type = propsMatch[1]!;
  }

  // Resolve props interface body when type name found in the index (Tier 4 — Item 16).
  // Look for an interface or type alias with the same name as props_type.
  let props_interface_source: string | null = null;
  if (props_type) {
    const decl = allSymbols.find(
      (s) => (s.kind === "interface" || s.kind === "type") && s.name === props_type,
    );
    if (decl?.source) {
      // Cap to 800 chars to keep bundle compact
      props_interface_source = decl.source.length > 800
        ? decl.source.slice(0, 800) + "..."
        : decl.source;
    }
  }

  return { props_type, props_interface_source, hooks_used, child_components, parent_components, wrapper };
}

/**
 * Extract type/interface names referenced in source by matching against known symbols.
 */
function extractTypesUsed(source: string, allSymbols: CodeSymbol[]): string[] {
  const typeNames = allSymbols
    .filter((s) => (s.kind === "interface" || s.kind === "type" || s.kind === "enum") && s.name.length >= 3)
    .map((s) => s.name);

  if (typeNames.length === 0) return [];

  // Single combined regex instead of N separate tests (O(n) vs O(n*m))
  const escaped = typeNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const combined = new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
  const used = new Set<string>();
  let m;
  while ((m = combined.exec(source)) !== null) {
    used.add(m[1]!);
  }

  return [...used].sort();
}

export interface DeadCodeCandidate {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  reason: string;
}

export interface DeadCodeResult {
  candidates: DeadCodeCandidate[];
  scanned_symbols: number;
  scanned_files: number;
  /**
   * The RESULT LIST was cut short — there are more dead-looking symbols than are shown.
   * The listed candidates are still as trustworthy as `coverage` says; there are just more.
   */
  truncated?: boolean;
  /**
   * Whether the reference scan actually saw the whole repository.
   *
   * This is the field that decides whether a candidate may be deleted. "Dead" here means
   * "no reference found in the files I read" — if some files were never read, a symbol used
   * only from those files looks exactly like a genuinely unused one. `truncated` used to carry
   * this meaning as well as the list-length one; an agent reading a single boolean naturally
   * takes the harmless reading ("the list is cut off") and acts on the candidates, which is
   * the wrong call precisely when the scan was short.
   *
   * `complete` is the only status under which an empty or short candidate list is evidence
   * about the code rather than about the scan.
   */
  coverage: {
    status: "complete" | "partial";
    files_indexed: number;
    files_read: number;
    /** Files the scan stopped before reaching (MAX_SCAN_FILES cap). */
    files_skipped_by_cap?: number;
    /** Files that were indexed but could not be read now (deleted, permissions, races). */
    files_unreadable?: number;
    detail?: string;
  };
}

// Kinds that are typically exported and should have external references
const EXPORTABLE_KINDS = new Set<SymbolKind>([
  "function", "class", "interface", "type", "variable", "constant", "enum",
  "component", "hook",
]);

/**
 * Collect top-level symbols of exportable kinds, filtered by test/pattern options.
 */
function collectExportedSymbols(
  symbols: CodeSymbol[],
  options: { includeTests: boolean; filePattern?: string | undefined },
): CodeSymbol[] {
  return symbols.filter((s) => {
    if (!EXPORTABLE_KINDS.has(s.kind)) return false;
    if (s.parent) return false;
    if (!options.includeTests && isTestFile(s.file)) return false;
    if (options.filePattern && !s.file.includes(options.filePattern)) return false;
    if (s.name.length < 3) return false;
    if (s.kind === "variable" && s.name === "default") return false;
    return true;
  });
}

// Bumped from 2000 → 5000 (F14: prior cap silently dropped references in
// medium-large repos, producing false-positive dead-code candidates whose
// real callers lived in unscanned files). Memory cost: roughly one file
// content string per entry — at 5K average-sized source files this is on
// the order of 50–200 MB peak, well within limits for analysis flows.
const MAX_SCAN_FILES = 5000;

/**
 * Resolve a relative import path against a source file's directory. Handles
 * the standard TS/Node extensions plus barrel-style `index` resolution.
 * Returns the candidate file path that exists in `allFiles`, or null.
 *
 * Intentionally narrow: only resolves `./` and `../` paths. Aliased imports
 * (tsconfig paths, package-json `imports`) are out of scope here — they show
 * up textually in scanned content anyway, so they don't drive false positives.
 */
function resolveRelativeImport(
  fromFile: string,
  importPath: string,
  allFiles: Set<string>,
): string | null {
  if (!importPath.startsWith(".")) return null;
  const lastSlash = fromFile.lastIndexOf("/");
  const fromDir = lastSlash >= 0 ? fromFile.slice(0, lastSlash) : "";
  const segments = (fromDir + "/" + importPath).split("/");
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  const base = stack.join("/");
  if (allFiles.has(base)) return base;
  // TS allows `import './x.js'` to resolve to `x.ts` — strip then re-extend.
  const stripped = base.replace(/\.(m?js|jsx)$/, "");
  const candidates = [
    stripped + ".ts",
    stripped + ".tsx",
    stripped + ".mjs",
    stripped + ".js",
    stripped + ".jsx",
    stripped + "/index.ts",
    stripped + "/index.tsx",
    stripped + "/index.js",
    stripped + "/index.jsx",
  ];
  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return null;
}

/**
 * Pre-scan content for re-export edges. A symbol re-exported from another
 * file isn't textually referenced in the barrel — without this pass barrel
 * patterns like `export * from './foo'` cause every symbol in `./foo` to be
 * misclassified as dead.
 *
 * Returns a set of file paths that are reached via at least one re-export
 * (named or star). Callers treat any candidate whose defining file lands in
 * this set as live.
 */
function collectReExportedFiles(
  fileContents: Map<string, string>,
  allFiles: Set<string>,
): Set<string> {
  const reExported = new Set<string>();
  // Matches:  export * from "./x";   export { A, B } from "./x";   export type { T } from "./x";
  // Anchor dropped (`^\s*` removed) so block-comment-prefixed exports
  // (`/** doc */ export { Y } from "./x"`) and continuation-line exports
  // (`...; export * from "./x"`) are detected too.
  const RE = /\bexport\s+(?:\*|type\s+\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;
  for (const [filePath, content] of fileContents) {
    RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(content)) !== null) {
      const target = resolveRelativeImport(filePath, m[1]!, allFiles);
      if (target) reExported.add(target);
    }
  }
  return reExported;
}

/**
 * Find potentially dead code: exported symbols with 0 references outside their own file.
 * Scans all indexed files for word-boundary matches of each exported symbol name.
 *
 * F14 fixes (2026-05-05):
 *   - Test files are now ALWAYS scanned for references regardless of
 *     `include_tests`. The flag now gates only candidate selection (whether
 *     test-internal exports can themselves be flagged dead). Symbols used
 *     only in tests are no longer false-positive dead.
 *   - Re-exports via `export * from './x'` and `export { Y } from './x'`
 *     now mark `./x` as live; previously the lack of textual mention in the
 *     barrel made every barrel-forwarded symbol look dead.
 *   - MAX_SCAN_FILES raised 2000 → 5000; truncation now surfaces in the
 *     `truncated` field so callers can react.
 */
export async function findDeadCode(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
  },
): Promise<DeadCodeResult> {
  const index = await requireCodeIndex(repo);
  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  const exportedSymbols = collectExportedSymbols(index.symbols, { includeTests, filePattern });
  const frameworks = detectFrameworks(index);

  // Read EVERY indexed file (incl. tests) for reference scanning. The previous
  // version honored `includeTests` here, which meant a symbol referenced only
  // from tests was misclassified as dead. Candidate selection still uses
  // `includeTests` (above) so test-only helpers don't appear in the result list.
  const fileContents = new Map<string, string>();
  let scanTruncated = false;
  let filesSkippedByCap = 0;
  let filesUnreadable = 0;
  for (const file of index.files) {
    if (fileContents.size >= MAX_SCAN_FILES) {
      scanTruncated = true;
      filesSkippedByCap = index.files.length - fileContents.size - filesUnreadable;
      break;
    }
    try {
      fileContents.set(file.path, await readFile(join(index.root, file.path), "utf-8"));
    } catch {
      // Deleted, unreadable, or raced with a write. Counted rather than merely skipped: a
      // reference living only in a file we could not read is invisible to the scan below, and
      // the symbol it points at then looks dead.
      filesUnreadable++;
    }
  }

  // Build set of files that are forwarded via re-exports (barrel chains).
  // Symbols defined in such files are reachable even without textual mention.
  const allFilePaths = new Set(fileContents.keys());
  const reExportedFiles = collectReExportedFiles(fileContents, allFilePaths);

  // Reference index, built in ONE pass over file contents. Previously this scan
  // was O(exportedSymbols x files): a `\b<name>\b` regex over every file's full
  // text for every exported symbol. On a healthy repo (few dead symbols) the
  // early-exit never fires, so the full product ran — telemetry (2026-07-20)
  // measured a 1,066,401 ms (~17.8 min) p95 for find_dead_code.
  //
  // Tokenising on [^A-Za-z0-9_]+ mirrors the \b\w boundary semantics of the old
  // regex. Per token we only need "is it mentioned outside its defining file",
  // so we keep the first file that mentioned it plus a multi-file flag — O(1)
  // memory per unique token instead of a file set, and O(1) lookup per symbol.
  const tokenIndex = new Map<string, { first: string; multi: boolean }>();
  for (const [filePath, content] of fileContents) {
    for (const token of new Set(content.split(/[^A-Za-z0-9_]+/))) {
      if (!token) continue;
      const entry = tokenIndex.get(token);
      if (!entry) tokenIndex.set(token, { first: filePath, multi: false });
      else if (!entry.multi && entry.first !== filePath) entry.multi = true;
    }
  }

  const candidates: DeadCodeCandidate[] = [];

  for (const sym of exportedSymbols) {
    if (candidates.length >= MAX_DEAD_CODE_RESULTS) break;
    if (isFrameworkEntryPoint(sym, frameworks)) continue;
    // Re-export reachability — barrel forwards skip the textual-mention check.
    if (reExportedFiles.has(sym.file)) continue;

    // Mentioned in any file other than the one defining it => not dead.
    const seen = tokenIndex.get(sym.name);
    const hasExternalRef = !!seen && (seen.multi || seen.first !== sym.file);

    if (!hasExternalRef) {
      candidates.push({
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        start_line: sym.start_line,
        end_line: sym.end_line,
        reason: "exported but no references found outside defining file",
      });
    }
  }

  const scanComplete = !scanTruncated && filesUnreadable === 0;
  const coverage: DeadCodeResult["coverage"] = {
    status: scanComplete ? "complete" : "partial",
    files_indexed: index.files.length,
    files_read: fileContents.size,
    ...(filesSkippedByCap > 0 ? { files_skipped_by_cap: filesSkippedByCap } : {}),
    ...(filesUnreadable > 0 ? { files_unreadable: filesUnreadable } : {}),
    ...(scanComplete
      ? {}
      : {
          detail:
            `reference scan read ${fileContents.size} of ${index.files.length} indexed files` +
            (filesSkippedByCap > 0 ? ` (${filesSkippedByCap} beyond the ${MAX_SCAN_FILES}-file cap)` : "") +
            (filesUnreadable > 0 ? ` (${filesUnreadable} unreadable)` : "") +
            " — a symbol referenced only from an unread file is indistinguishable from a dead one," +
            " so do NOT delete on this result alone; narrow with file_pattern to get a complete scan",
        }),
  };

  return {
    candidates,
    scanned_symbols: exportedSymbols.length,
    scanned_files: fileContents.size,
    // Deliberately ONLY about list length now. Scan completeness lives in `coverage`, because
    // the two have opposite implications: a cut-off list means "there are more", a short scan
    // means "these may be wrong".
    ...(candidates.length >= MAX_DEAD_CODE_RESULTS ? { truncated: true } : {}),
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Unused import detection
// ---------------------------------------------------------------------------

const MAX_UNUSED_IMPORTS = 200;

export interface UnusedImport {
  file: string;
  line: number;
  import_text: string;
  imported_name: string;
}

export interface UnusedImportsResult {
  unused: UnusedImport[];
  scanned_files: number;
  truncated?: boolean;
}

/**
 * Find imports whose imported names are never referenced in the file body.
 * Supports ES module named imports: import { A, B } from '...'
 */
export async function findUnusedImports(
  repo: string,
  options?: { file_pattern?: string; include_tests?: boolean },
): Promise<UnusedImportsResult> {
  const index = await requireCodeIndex(repo);
  const includeTests = options?.include_tests ?? false;

  const unused: UnusedImport[] = [];
  let scannedFiles = 0;

  for (const file of index.files) {
    if (unused.length >= MAX_UNUSED_IMPORTS) break;
    if (!includeTests && isTestFile(file.path)) continue;
    if (options?.file_pattern && !file.path.includes(options.file_pattern)) continue;

    // Only analyze JS/TS/Kotlin files
    if (!/\.(ts|tsx|js|jsx|mjs|kt|kts)$/.test(file.path)) continue;

    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }
    scannedFiles++;

    const lines = source.split("\n");

    // Find named import lines: import { A, B, C } from '...'
    // Also: import A from '...'  and  import * as A from '...'
    const importRegex = /^import\s+(?:type\s+)?(?:\{([^}]+)\}|(\*\s+as\s+\w+)|(\w+)).*from\s+['"][^'"]+['"]/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line.startsWith("import ")) continue;
      // Stop scanning imports when we hit non-import code
      if (i > 0 && !line.startsWith("import") && !line.startsWith("//") && !line.startsWith("/*") && line.length > 0 && !lines[i]!.trim().startsWith("*") && !lines[i]!.trim().startsWith("}")) {
        // Could be multi-line import continuation, keep going
      }

      const match = importRegex.exec(line);
      if (!match) continue;

      const names: string[] = [];
      if (match[1]) {
        // Named imports: { A, B as C, type D }
        for (const part of match[1].split(",")) {
          const trimmed = part.trim().replace(/^type\s+/, "");
          if (!trimmed) continue;
          // Handle "A as B" — the local name is B
          const asMatch = /(\w+)\s+as\s+(\w+)/.exec(trimmed);
          names.push(asMatch ? asMatch[2]! : trimmed);
        }
      } else if (match[2]) {
        // Namespace import: * as A
        const nsMatch = /\*\s+as\s+(\w+)/.exec(match[2]);
        if (nsMatch) names.push(nsMatch[1]!);
      } else if (match[3]) {
        // Default import: import A
        names.push(match[3]);
      }

      // Check each imported name against rest of file
      const bodyAfterImports = lines.slice(i + 1).join("\n");
      for (const name of names) {
        if (name.length < 2) continue;
        const nameRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!nameRegex.test(bodyAfterImports)) {
          unused.push({
            file: file.path,
            line: i + 1,
            import_text: line,
            imported_name: name,
          });
          if (unused.length >= MAX_UNUSED_IMPORTS) break;
        }
      }
    }
  }

  return {
    unused,
    scanned_files: scannedFiles,
    ...(unused.length >= MAX_UNUSED_IMPORTS ? { truncated: true } : {}),
  };
}
