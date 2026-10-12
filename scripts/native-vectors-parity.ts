/**
 * Semantic-search parity and load cost of the native vector set against the TypeScript one, on a REAL
 * vector file (ADR-006 stage 11, `docs/specs/2026-10-12-native-vectors-plan.md`).
 *
 *   node --max-old-space-size=12288 --import tsx scripts/native-vectors-parity.ts <embeddings.ndjson|.vec> <index.db copy> [--queries N] [--seed S]
 *
 * Loads the file both ways (the id rewrite in its meta applied by both), compares the counts (the
 * vectors themselves are compared through the rankings: a differing bit moves a score), then ranks a query set — stored vectors with seeded noise — through
 * `filterEmbeddingsByFile` + `searchSemantic` and through the native `search`, without a filter,
 * without tests, and restricted to a directory. Compared per result: the same id in the same position
 * and the same score bits.
 *
 * Exit 0 = identical, 1 = differences, 2 = usage / no native core. Point it at a COPY of an index.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { loadIndexSqlite } from "../src/storage/sqlite/index-io.js";
import { closeAllIndexDbs } from "../src/storage/sqlite/connection.js";
import { loadEmbeddings } from "../src/storage/embedding-store.js";
import { readVectorFile } from "../src/storage/vector-file.js";
import { searchSemantic } from "../src/search/semantic.js";
import { filterEmbeddingsByFile } from "../src/retrieval/retrieval-utils.js";
import { getNativeCore } from "../src/native/index.js";
import type { CodeSymbol } from "../src/types.js";

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

function rebaseOf(vectorPath: string): { from: string; to: string } | null {
  try {
    const meta = JSON.parse(readFileSync(vectorPath.replace(/\.embeddings\.ndjson$/, ".embeddings.meta.json"), "utf-8")) as {
      id_rebase?: { from?: string; to?: string };
    };
    const { from, to } = meta.id_rebase ?? {};
    return from && to ? { from, to } : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [vectorPath, dbPath] = process.argv.slice(2);
  if (!vectorPath || !dbPath) {
    console.error("usage: native-vectors-parity.ts <embeddings.ndjson> <index.db copy> [--queries N] [--seed S]");
    process.exit(2);
  }
  const core = getNativeCore("vectors");
  if (!core) {
    console.error("no native core");
    process.exit(2);
  }
  const queries = arg("--queries", 30);
  const random = rng(arg("--seed", 1));

  const index = await loadIndexSqlite(dbPath);
  if (!index) throw new Error(`no index in ${dbPath}`);
  const symbols = new Map<string, CodeSymbol>(index.symbols.map((s) => [s.id, s]));
  const fileOf = new Map([...symbols].map(([id, s]) => [id, s.file]));
  closeAllIndexDbs();

  let t = performance.now();
  // A `.vec` given directly (e.g. a converted copy) is read as-is; ids are whatever it holds.
  const ts = vectorPath.endsWith(".vec") ? (await readVectorFile(vectorPath)).embeddings : await loadEmbeddings(vectorPath);
  const tsMs = Math.round(performance.now() - t);
  const rebase = vectorPath.endsWith(".vec") ? null : rebaseOf(vectorPath);
  t = performance.now();
  const native = await core.loadVectors(vectorPath, rebase?.from ?? null, rebase?.to ?? null);
  const nativeMs = Math.round(performance.now() - t);
  console.log(`load: ts ${tsMs} ms, native ${nativeMs} ms (${(tsMs / Math.max(nativeMs, 1)).toFixed(1)}x); ${ts.size} vectors, native ${native.count}`);

  let diffs = 0;
  if (ts.size !== native.count) {
    console.log(`DIFF count ts=${ts.size} native=${native.count}`);
    diffs++;
  }

  t = performance.now();
  const idsJoined = [...fileOf.keys()].join("\0");
  const filesJoined = [...fileOf.values()].join("\0");
  const joinMs = Math.round(performance.now() - t);
  t = performance.now();
  await native.attachFilesAsync(idsJoined, filesJoined);
  console.log(`attachFiles: join ${joinMs} ms on the main thread, attach ${Math.round(performance.now() - t)} ms off it, ${fileOf.size} symbols`);
  const ids = [...ts.keys()].filter((id) => fileOf.has(id));
  if (ids.length === 0) {
    // Nothing to compare would read as "0 diffs".
    console.error("no vector id is in the index copy — wrong pair of files?");
    process.exit(2);
  }
  const filters: Array<[string | undefined, boolean]> = [[undefined, false], [undefined, true], ["src/", true]];
  let tsSearchMs = 0;
  let nativeSearchMs = 0;
  for (let q = 0; q < queries; q++) {
    const base = ts.get(ids[Math.floor(random() * ids.length)]!)!;
    const query = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) query[i] = base[i]! + (random() - 0.5) * 0.05;
    for (const [contains, excludeTests] of filters) {
      const topK = 1 + Math.floor(random() * 20);
      t = performance.now();
      const filtered = filterEmbeddingsByFile(ts, fileOf, contains, excludeTests);
      const want = searchSemantic(query, filtered, symbols, topK);
      tsSearchMs += performance.now() - t;
      t = performance.now();
      const got = await native.searchAsync(query, topK, contains ?? null, excludeTests);
      nativeSearchMs += performance.now() - t;
      const same =
        want.length === got.length &&
        want.every((w, i) => w.symbol.id === got[i]!.id && Object.is(w.score, got[i]!.score));
      if (!same) {
        diffs++;
        if (diffs <= 5) {
          console.log(`DIFF query ${q} filter=${contains ?? "-"}/${excludeTests} k=${topK}`);
          console.log("  ts    ", want.map((w) => `${w.symbol.id}@${w.score}`).slice(0, 5));
          console.log("  native", got.map((g) => `${g.id}@${g.score}`).slice(0, 5));
        }
      }
    }
  }
  const n = queries * filters.length;
  console.log(`search: ts ${(tsSearchMs / n).toFixed(1)} ms, native ${(nativeSearchMs / n).toFixed(1)} ms per query (${n} queries)`);
  console.log(diffs === 0 ? "PARITY: 0 diffs" : `PARITY: ${diffs} diffs`);
  native.release();
  process.exit(diffs === 0 ? 0 : 1);
}

void main();
