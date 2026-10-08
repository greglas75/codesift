import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol, SymbolKind } from "../types.js";
import {
  findRepoSymbols,
  findRepoSymbolsByRequestedIds,
  getIndexSummary,
  streamRepoSymbols,
} from "./index-tools.js";
import { requireIndexSummary } from "./symbol-tool-internals.js";

/*
 * Every lookup here reads the rows it needs instead of materialising the index (ADR-004 stage 2):
 * an id probe, a `WHERE name = ?`, a `WHERE parent = ?`. Each first fetches the summary, which is
 * what carries `getCodeIndex`'s null semantics — an unknown repo and a STALE one both read as "not
 * found" — and only then asks for symbols with `skipFreshness`, so freshness runs once, as before.
 * The symbol accessors alone would answer a stale index with rows, which the old path never did.
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

  const summary = await getIndexSummary(repo, { skipFreshness: true });
  if (!summary) return null;

  // Two rows are enough to decide: one is a unique match, a second makes it ambiguous.
  const named = await findRepoSymbols(
    repo,
    { name: nameGuess, withSource: false, limit: 2 },
    { skipFreshness: true },
  );
  if (named.length !== 1) return null; // none, or ambiguous — let the caller show suggestions
  return named[0]!.id;
}

export async function findSimilarSymbols(
  repo: string,
  requestedId: string,
  limit = 3,
): Promise<Array<{ id: string; name: string; kind: string; file: string; start_line: number }>> {
  const summary = await getIndexSummary(repo, { skipFreshness: true });
  if (!summary) return [];

  const nameGuess = extractSymbolNameGuess(requestedId);
  if (!nameGuess) return [];
  const lower = nameGuess.toLowerCase();

  const exact: CodeSymbol[] = [];
  const prefix: CodeSymbol[] = [];
  const substr: CodeSymbol[] = [];

  // A case-insensitive substring match in both directions has no index, so this folds over pages
  // in index order — the order the old loop walked — and stops at the same point it broke. The
  // early stop is per symbol, inside the page, so the buckets are filled exactly as before.
  await streamRepoSymbols(repo, { withSource: false }, (batch) => {
    for (const s of batch) {
      const sn = s.name.toLowerCase();
      if (sn === lower) exact.push(s);
      else if (sn.startsWith(lower) || lower.startsWith(sn)) prefix.push(s);
      else if (sn.includes(lower) || lower.includes(sn)) substr.push(s);
      if (exact.length >= limit) return false;
    }
    return true;
  }, { skipFreshness: true });

  const ranked = [...exact, ...prefix, ...substr].slice(0, limit);
  return ranked.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    file: s.file,
    start_line: s.start_line,
  }));
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
        let total = 0;
        while (total < length) {
          const { bytesRead } = await fh.read(buf, total, length - total, startByte + total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        if (total === length) return buf.toString("utf-8");
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

export async function resolveSearchHit(
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
    await requireIndexSummary(repo);
    // Exact id equality, as before — not the short-id rule: the hit carries the full id.
    const sharing = await findRepoSymbols(
      repo,
      { ids: [hit.id], withSource: false },
      { skipFreshness: true },
    );
    const candidates = sharing
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
  const summary = await requireIndexSummary(repo);
  const includeRelated = options?.include_related ?? true;

  // `repo:file:name:line` is NOT unique — a minified bundle puts many symbols on line 1, and
  // PHPDoc synthesis emits a field and a method at the same line (73,165 collisions measured
  // across 16 indexes). `.find` would hand back whichever happened to load first, with no
  // signal: the caller then reads source for a symbol it did not ask for. This file already
  // states the rule for names ("two symbols named `handler` must stay ambiguous — silently
  // picking one is worse than the miss it replaces"); it was never applied to ids because they
  // were assumed unique.
  //
  // An id probe, not a filter over every symbol. `source` is requested because the result falls
  // back to the STORED source when the file cannot be read from disk below — dropping it here would
  // turn "file unreadable" into "this symbol has no body".
  const matches = await findRepoSymbolsByRequestedIds(repo, [symbolId], {
    withSource: true,
    skipFreshness: true,
  });
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
    summary.root,
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
    // `WHERE parent = ? LIMIT 20` in index order: the first twenty the old filter would have kept.
    // With source, because `stripSymbol` keeps it and the related entries have always carried it.
    const children = await findRepoSymbols(
      repo,
      { parent: symbol.id, withSource: true, limit: 20 },
      { skipFreshness: true },
    );
    for (const child of children) {
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
  const summary = await requireIndexSummary(repo);

  // Build lookup map for requested symbols.
  //
  // A colliding id must be refused here for the same reason `getSymbol` refuses it: ids are
  // `repo:file:name:line` and that is not unique, so `.set()` on a repeated id was last-write-wins
  // — the caller asked for one symbol and silently received whichever happened to come later in
  // the array. Leaving the batch path permissive would have meant two entry points in this file
  // disagreeing about the same input, one throwing and one substituting, which is worse than
  // either rule applied consistently.
  //
  // The loop below is unchanged; only its input is narrowed, from every symbol to the ones that
  // answer to a requested id (in index order, collisions included) — the only ones it could ever
  // have kept. With source, for the same stored-source fallback as getSymbol when a file is gone.
  const requestedIds = new Set(symbolIds);
  const symbolMap = new Map<string, CodeSymbol>();
  const collisions = new Map<string, CodeSymbol[]>();
  const answering = await findRepoSymbolsByRequestedIds(repo, symbolIds, {
    withSource: true,
    skipFreshness: true,
  });
  for (const sym of answering) {
    const separator = sym.id.indexOf(":");
    const candidates = separator >= 0 ? [sym.id, sym.id.slice(separator + 1)] : [sym.id];
    for (const requestedId of new Set(candidates)) {
      if (!requestedIds.has(requestedId)) continue;
      const seen = symbolMap.get(requestedId);
      if (seen === undefined) {
        symbolMap.set(requestedId, sym);
        continue;
      }
      const group = collisions.get(requestedId) ?? [seen];
      group.push(sym);
      collisions.set(requestedId, group);
    }
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
  const byFile = new Map<string, Array<{ requestedId: string; symbol: CodeSymbol }>>();
  for (const id of symbolIds) {
    const sym = symbolMap.get(id);
    if (!sym) continue;

    let group = byFile.get(sym.file);
    if (!group) {
      group = [];
      byFile.set(sym.file, group);
    }
    group.push({ requestedId: id, symbol: sym });
  }

  // Read all files in parallel, extract source for all symbols in each file
  const results = new Map<string, CodeSymbol>();

  const fileEntries = [...byFile.entries()];
  const fileContents = await Promise.all(
    fileEntries.map(([file]) =>
      readFile(join(summary.root, file), "utf-8").catch(() => undefined),
    ),
  );

  for (let i = 0; i < fileEntries.length; i++) {
    const [, symbols] = fileEntries[i]!;
    const lines = fileContents[i]?.split("\n");

    for (const { requestedId, symbol: sym } of symbols) {
      const result = { ...sym };
      if (lines) {
        result.source = lines.slice(sym.start_line - 1, sym.end_line).join("\n");
      }
      results.set(requestedId, result);
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
