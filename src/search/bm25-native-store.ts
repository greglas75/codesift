import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import type { NativeBm25Handle } from "../native/index.js";
import { cleanupOrphanTempFiles } from "../storage/_shared.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../types.js";
import { wrapNativeBM25, type NativeBM25Index } from "./bm25.js";

/**
 * Persistence for the native BM25 index (ADR-006 stage 9, reopened 2026-10-10).
 *
 * Stage 9 was declined on conversation indexes, where the parallel native build beat loading a file.
 * A 1.43M-symbol code index is the opposite case: the first search per index cost 6.4 s of loading
 * plus 13.9 s of build, and every worktree of that repo is its own index — 28 of 78 rdesigner
 * `search_symbols` calls on 2026-10-09..10 took over 5 s. The file holds the Rust index itself
 * (`crates/codesift-core/src/bm25.rs`, `to_bytes`), including each key's token list, so a loaded index
 * can still remove a file's symbols exactly.
 *
 * Staleness is judged per FILE, not per index: the header records every file's mtime and symbol
 * count, and on load the files that differ are re-applied with `updateFile` — the same call the live
 * daemon makes after an edit, with the same semantics (centrality is not recomputed). An index whose
 * files changed for more than half is rebuilt instead, and so is one written by another extractor or
 * another codesift version, whose tokens could differ while every mtime stays the same.
 */

const HEADER_FORMAT = 1;
/** Past this share of changed files, re-applying costs more than the build it saves (cf. the 50%
 *  amend bound measured for conversation indexes in CLAUDE.md). */
const MAX_CHANGED_SHARE = 0.5;

const PKG_VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

interface Header {
  format: number;
  codesift: string;
  extractor: string;
  /** `[path, fingerprint]` for every file the index held when it was saved. */
  files: Array<[string, string]>;
}

export function nativeBm25PathFor(indexPath: string): string {
  return `${indexPath.replace(/\.index\.json$/, "").replace(/\.index\.db$/, "")}.bm25n.bin`;
}

function fingerprint(file: FileEntry): string {
  return `${file.mtime_ms ?? file.last_modified}|${file.symbol_count}`;
}

function extractorKey(code: Pick<CodeIndex, "extractor_version">): string {
  return JSON.stringify(code.extractor_version ?? {});
}

function headerFor(code: Pick<CodeIndex, "files" | "extractor_version">): Header {
  return {
    format: HEADER_FORMAT,
    codesift: PKG_VERSION,
    extractor: extractorKey(code),
    files: code.files.map((f) => [f.path, fingerprint(f)]),
  };
}

/**
 * The files whose symbols must be re-applied to a loaded index, or null when it must be rebuilt
 * instead (other format, codesift version or extractor, or too much changed). Exported for tests.
 */
export function filesToReapply(saved: Header, code: Pick<CodeIndex, "files" | "extractor_version">): string[] | null {
  if (saved.format !== HEADER_FORMAT || saved.codesift !== PKG_VERSION) return null;
  if (saved.extractor !== extractorKey(code)) return null;
  const before = new Map(saved.files);
  const changed: string[] = [];
  const current = new Set<string>();
  for (const file of code.files) {
    current.add(file.path);
    if (before.get(file.path) !== fingerprint(file)) changed.push(file.path);
  }
  for (const path of before.keys()) if (!current.has(path)) changed.push(path);
  const total = Math.max(code.files.length, before.size, 1);
  return changed.length / total > MAX_CHANGED_SHARE ? null : changed;
}

function parseHeader(raw: string | null): Header | null {
  if (!raw) return null;
  try {
    const h = JSON.parse(raw) as Partial<Header>;
    if (typeof h.format !== "number" || typeof h.codesift !== "string" || typeof h.extractor !== "string") return null;
    if (!Array.isArray(h.files)) return null;
    return h as Header;
  } catch {
    return null;
  }
}

/**
 * The persisted index for `code`, brought up to date, or null when there is none or it must be
 * rebuilt. A damaged or foreign file is simply not used — the caller builds, and the next save
 * replaces it.
 */
export async function loadNativeBM25(
  core: { loadBm25(path: string): Promise<NativeBm25Handle> },
  indexPath: string,
  code: CodeIndex,
): Promise<NativeBM25Index | null> {
  const path = nativeBm25PathFor(indexPath);
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch {
    return null;
  }
  let native: NativeBm25Handle;
  try {
    native = await core.loadBm25(path);
  } catch {
    return null;
  }
  const saved = parseHeader(native.loadedHeader);
  const changed = saved ? filesToReapply(saved, code) : null;
  if (!changed) return null;

  if (changed.length > 0) {
    // One pass groups the symbols of the changed files; updateBM25ForFile would walk every symbol per file.
    const wanted = new Set(changed);
    const byFile = new Map<string, CodeSymbol[]>();
    for (const symbol of code.symbols) {
      if (!wanted.has(symbol.file)) continue;
      const list = byFile.get(symbol.file);
      if (list) list.push(symbol);
      else byFile.set(symbol.file, [symbol]);
    }
    for (const file of changed) native.updateFile(file, byFile.get(file) ?? []);
  }
  const symbols = new Map<string, CodeSymbol>();
  for (const symbol of code.symbols) symbols.set(symbol.id, symbol);
  return wrapNativeBM25(native, symbols);
}

/** Write `index` beside `indexPath` in the background. Failure leaves the next start to rebuild. */
export async function saveNativeBM25(
  index: NativeBM25Index,
  indexPath: string,
  code: Pick<CodeIndex, "files" | "extractor_version">,
): Promise<void> {
  const path = nativeBm25PathFor(indexPath);
  // Halves of a save killed mid-write (`<path>.tmp.<pid>`) are reclaimed like every other artifact's.
  await cleanupOrphanTempFiles(path);
  await index.native.saveAsync(path, JSON.stringify(headerFor(code)));
}
