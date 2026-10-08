/**
 * Store read-path benchmark — the baseline ADR-006 stage 1 is gated against.
 *
 *   node --expose-gc --import tsx scripts/bench-store.ts <db> [--runs N] [--json]
 *
 * Which implementation serves `findSymbolsSqlite` / `streamSymbolsSqlite` / `getIndexMetaSqlite`
 * is decided by CODESIFT_NATIVE_STORE (0 = TypeScript, 1 = Rust), so the same script measures both.
 * `loadIndexSqlite` is the whole-index load ADR-004 measured, kept as the reference cost.
 *
 * Three numbers per operation, because the faults this targets show up in different ones:
 *   wall_ms      — how long the caller waits;
 *   block_ms     — the longest the event loop went without running a timer during the call, i.e.
 *                  how long every OTHER client of the daemon waited. A synchronous read blocks for
 *                  its whole wall time; an off-thread one should block for the JSON.parse only;
 *   retained_mb  — heap still held by the result after a forced GC (needs --expose-gc).
 *
 * Point it at a COPY of a real index (`sqlite3 <db> ".backup copy.db"`): the TypeScript path runs
 * `CREATE INDEX IF NOT EXISTS` on open, and a benchmark should not write to a live daemon's file.
 */
import { performance } from "node:perf_hooks";
import { findSymbolsSqlite, getIndexMetaSqlite, streamSymbolsSqlite } from "../src/storage/sqlite/queries.js";
import { loadIndexSqlite } from "../src/storage/sqlite/index-io.js";
import { closeAllIndexDbs } from "../src/storage/sqlite/connection.js";
import { nativeMode, nativeStatus } from "../src/native/index.js";

interface Sample {
  op: string;
  results: number;
  wall_ms: number;
  block_ms: number;
  retained_mb: number;
}

const gc = (globalThis as { gc?: () => void }).gc;

function heapMb(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed / 1024 ** 2;
}

async function measure(op: string, run: () => Promise<number | { count: number; hold: unknown }>): Promise<Sample> {
  let last = performance.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 1);
  await new Promise((r) => setTimeout(r, 5));
  maxGap = 0;
  last = performance.now();

  const before = heapMb();
  const t0 = performance.now();
  const out = await run();
  const wall = performance.now() - t0;
  // Let the ticker observe the gap a synchronous call left behind.
  await new Promise((r) => setTimeout(r, 3));
  maxGap = Math.max(maxGap, performance.now() - last);
  clearInterval(ticker);

  const count = typeof out === "number" ? out : out.count;
  const retained = heapMb() - before;
  // Keep the result reachable until after the second heap reading.
  if (typeof out !== "number") void (out.hold as unknown[] | null)?.length;
  return { op, results: count, wall_ms: round(wall), block_ms: round(maxGap), retained_mb: round(retained) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function main(): Promise<void> {
  const db = process.argv[2];
  if (!db) {
    console.error("usage: bench-store.ts <db> [--runs N] [--json]");
    process.exit(2);
  }
  const runsArg = process.argv.indexOf("--runs");
  const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 3;
  if (!gc) console.error("warning: run with --expose-gc, retained_mb is meaningless without it");

  const ops: Array<[string, () => Promise<number | { count: number; hold: unknown }>]> = [
    ["meta", async () => ((await getIndexMetaSqlite(db)) ? 1 : 0)],
    ["name=i", async () => { const r = await findSymbolsSqlite(db, { withSource: false, name: "i" }); return { count: r.length, hold: r }; }],
    ["prefix=get", async () => { const r = await findSymbolsSqlite(db, { withSource: false, namePrefix: "get" }); return { count: r.length, hold: r }; }],
    ["kind=function", async () => { const r = await findSymbolsSqlite(db, { withSource: false, kind: "function" }); return { count: r.length, hold: r }; }],
    ["kind=function+src", async () => { const r = await findSymbolsSqlite(db, { withSource: true, kind: "function" }); return { count: r.length, hold: r }; }],
    ["kind=variable", async () => { const r = await findSymbolsSqlite(db, { withSource: false, kind: "variable" }); return { count: r.length, hold: r }; }],
    ["stream all+src", async () => {
      let n = 0;
      await streamSymbolsSqlite(db, { withSource: true }, (b) => { n += b.length; });
      return n;
    }],
    ["loadIndex (TS)", async () => { const idx = await loadIndexSqlite(db); return { count: idx?.symbols.length ?? 0, hold: idx?.symbols }; }],
  ];

  const table: Sample[] = [];
  for (const [op, run] of ops) {
    const samples: Sample[] = [];
    for (let i = 0; i < runs; i++) samples.push(await measure(op, run));
    table.push({
      op,
      results: samples[0]!.results,
      wall_ms: median(samples.map((s) => s.wall_ms)),
      block_ms: median(samples.map((s) => s.block_ms)),
      retained_mb: median(samples.map((s) => s.retained_mb)),
    });
  }
  closeAllIndexDbs();

  const header = { store: nativeMode("store"), native: nativeStatus(), node: process.version, runs, db };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...header, table }, null, 2));
  } else {
    console.log(JSON.stringify(header));
    console.table(table);
  }
}

void main();
