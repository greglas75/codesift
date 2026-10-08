/**
 * BM25 parity and cost of the native index against the TypeScript one, on a REAL index (ADR-006
 * stage 2).
 *
 *   node --expose-gc --max-old-space-size=12288 --import tsx scripts/native-bm25-parity.ts <db> [--queries N] [--seed S]
 *
 * Builds both from the same loaded symbols, runs a query set drawn from the index's own names,
 * signatures and docstrings, then edits a sample of files through `updateBM25ForFile` on both and
 * runs the queries again. Compared per result: the same symbol object in the same position, the same
 * matched tokens, scores equal to 1e-12 relative (a logarithm's last bit is the only allowed
 * difference). Also reports build time and the V8 heap each index retains — the number stage 2 is for.
 *
 * Exit 0 = identical, 1 = differences, 2 = usage / no native core. Point it at a COPY of an index.
 */
import { performance } from "node:perf_hooks";
import { loadIndexSqlite } from "../src/storage/sqlite/index-io.js";
import { closeAllIndexDbs } from "../src/storage/sqlite/connection.js";
import {
  bm25FootprintBytes,
  buildBM25IndexYielding,
  searchBM25,
  updateBM25ForFile,
  type BM25Index,
} from "../src/search/bm25.js";
import { getNativeCore, resetNativeForTesting } from "../src/native/index.js";
import type { CodeSymbol } from "../src/types.js";

const WEIGHTS = { name: 3, signature: 1.5, docstring: 1, body: 1, comments: 0.5 };
const gc = (globalThis as { gc?: () => void }).gc;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function heapMb(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed / 1024 ** 2;
}

async function build(engine: "0" | "1", symbols: CodeSymbol[]): Promise<{ index: BM25Index; ms: number; heapMb: number }> {
  process.env["CODESIFT_NATIVE_BM25"] = engine;
  resetNativeForTesting();
  const before = heapMb();
  const t = performance.now();
  const index = await buildBM25IndexYielding(symbols);
  const ms = performance.now() - t;
  return { index, ms: Math.round(ms), heapMb: Math.round(heapMb() - before) };
}

async function main(): Promise<void> {
  const db = process.argv[2];
  if (!db) {
    console.error("usage: native-bm25-parity.ts <db> [--queries N] [--seed S]");
    process.exit(2);
  }
  process.env["CODESIFT_NATIVE_BM25"] = "1";
  resetNativeForTesting();
  try {
    if (!getNativeCore("bm25")) throw new Error("not loaded");
  } catch (err) {
    console.error(`no native core: ${(err as Error).message}`);
    process.exit(2);
  }

  const code = await loadIndexSqlite(db);
  closeAllIndexDbs();
  if (!code) {
    console.error("no index in that database");
    process.exit(2);
  }
  const symbols = code.symbols;
  const rand = rng(arg("--seed", 1));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const words = (s: string | undefined) => (s ?? "").split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3);
  const queries: string[] = [];
  const n = arg("--queries", 300);
  for (let i = 0; i < n; i++) {
    const s = pick(symbols);
    const r = rand();
    if (r < 0.4) queries.push(s.name);
    else if (r < 0.7) queries.push([...words(s.signature), ...words(s.name)].slice(0, 2).join(" ") || s.name);
    else if (r < 0.9) queries.push(words(s.docstring).slice(0, 3).join(" ") || s.name);
    else queries.push(`${pick(symbols).name} ${pick(symbols).name}`);
  }

  const ts = await build("0", symbols);
  const rs = await build("1", symbols);

  let diffs = 0;
  let results = 0;
  const compare = (stage: string) => {
    for (const q of queries) {
      const a = searchBM25(ts.index, q, 50, WEIGHTS);
      const b = searchBM25(rs.index, q, 50, WEIGHTS);
      results += a.length;
      let bad = a.length === b.length ? -1 : Math.min(a.length, b.length);
      for (let i = 0; bad < 0 && i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        const close = Math.abs(x.score - y.score) <= 1e-12 * Math.max(1, Math.abs(x.score));
        if (x.symbol !== y.symbol || !close || JSON.stringify(x.matches) !== JSON.stringify(y.matches)) bad = i;
      }
      if (bad >= 0) {
        diffs++;
        if (diffs <= 5) {
          console.log(`DIFF ${stage} ${JSON.stringify(q)} at #${bad}`);
          console.log(`  ts: ${a.slice(bad, bad + 3).map((r) => `${r.symbol.id}=${r.score}`).join(" | ")}`);
          console.log(`  rs: ${b.slice(bad, bad + 3).map((r) => `${r.symbol.id}=${r.score}`).join(" | ")}`);
        }
      }
    }
  };

  compare("build");

  // Edits: re-ingest a sample of files (same symbols, shuffled order), and drop a few entirely.
  const byFile = new Map<string, CodeSymbol[]>();
  for (const s of symbols) {
    const l = byFile.get(s.file);
    if (l) l.push(s);
    else byFile.set(s.file, [s]);
  }
  const files = [...byFile.keys()];
  for (let i = 0; i < 25; i++) {
    const f = pick(files);
    const syms = i % 5 === 4 ? [] : [...(byFile.get(f) ?? [])].reverse();
    updateBM25ForFile(ts.index, f, syms);
    updateBM25ForFile(rs.index, f, syms);
  }
  compare("after 25 file updates");

  console.log(
    JSON.stringify({
      db,
      symbols: symbols.length,
      queries: queries.length * 2,
      results_compared: results,
      diffs,
      build_ms: { ts: ts.ms, native: rs.ms },
      v8_heap_retained_mb: { ts: ts.heapMb, native: rs.heapMb },
      footprint_mb: { ts: Math.round(bm25FootprintBytes(ts.index) / 1e6), native: Math.round(bm25FootprintBytes(rs.index) / 1e6) },
    }),
  );
  process.exit(diffs === 0 ? 0 : 1);
}

void main();
