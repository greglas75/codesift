/**
 * Parity of the Rust read path against the TypeScript one, on a REAL index (ADR-006 rule 3).
 *
 *   node --max-old-space-size=12288 --import tsx scripts/native-parity.ts <db> [--sample N] [--seed S]
 *
 * The heap flag matters on large indexes: the "all + source" query holds both implementations'
 * full results at once.
 *
 * tests/native/store-parity.test.ts proves the mapping on hand-picked rows; this proves it on
 * whatever a real repo put in its index — vendored bundles, minified files, CJK comments, PHPDoc
 * synthesis, id collisions. The query matrix is drawn from the database's own values, so every
 * query has answers. Compared byte for byte after JSON.stringify: same symbols, same order, same
 * keys in the same order.
 *
 * Exit 0 = no differences, 1 = differences (the first few are printed), 2 = usage / no native core.
 * Point it at a COPY of a live index, like bench-store.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { findSymbolsSqlite, getIndexMetaSqlite, streamSymbolsSqlite, type SymbolQuery } from "../src/storage/sqlite/queries.js";
import { closeAllIndexDbs } from "../src/storage/sqlite/connection.js";
import { getNativeCore, resetNativeForTesting } from "../src/native/index.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

/** Deterministic, so a reported difference can be reproduced with the same --seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function column(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ v: string | null }>).map((r) => r.v).filter((v): v is string => v !== null);
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("usage: native-parity.ts <db> [--sample N] [--seed S]");
    process.exit(2);
  }
  process.env["CODESIFT_NATIVE_STORE"] = "1";
  resetNativeForTesting();
  try {
    getNativeCore("store");
  } catch (err) {
    console.error(`no native core: ${(err as Error).message}`);
    process.exit(2);
  }

  const sample = arg("--sample", 25);
  const rand = rng(arg("--seed", 1));
  const pick = <T>(xs: T[], n: number): T[] => Array.from({ length: Math.min(n, xs.length) }, () => xs[Math.floor(rand() * xs.length)]!);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = column(db, "SELECT DISTINCT name AS v FROM symbols");
  const files = column(db, "SELECT DISTINCT file AS v FROM symbols");
  const kinds = column(db, "SELECT DISTINCT kind AS v FROM symbols");
  const parents = column(db, "SELECT DISTINCT parent AS v FROM symbols WHERE parent IS NOT NULL");
  const ids = column(db, "SELECT id AS v FROM symbols");
  db.close();

  const queries: Array<[string, SymbolQuery]> = [];
  for (const k of kinds) queries.push([`kind=${k}`, { withSource: false, kind: k }]);
  for (const n of pick(names, sample)) queries.push([`name=${n}`, { withSource: true, name: n }]);
  for (const f of pick(files, sample)) queries.push([`file=${f}`, { withSource: true, file: f }]);
  for (const p of pick(parents, sample)) queries.push([`parent=${p}`, { withSource: false, parent: p }]);
  for (const n of pick(names, sample)) queries.push([`prefix=${n.slice(0, 3)}`, { withSource: false, namePrefix: n.slice(0, 3) }]);
  queries.push(["ids x2000", { withSource: true, ids: pick(ids, 2000) }]);
  queries.push(["ids x2000 limit 1000", { withSource: false, ids: pick(ids, 2000), limit: 1000 }]);
  queries.push(["all + source", { withSource: true }]);

  let diffs = 0;
  let rows = 0;
  for (const [label, q] of queries) {
    process.env["CODESIFT_NATIVE_STORE"] = "0";
    const ts = await findSymbolsSqlite(dbPath, q);
    process.env["CODESIFT_NATIVE_STORE"] = "1";
    const rs = await findSymbolsSqlite(dbPath, q);
    rows += ts.length;
    // Element by element: one JSON.stringify of a whole large result can exceed V8's string limit,
    // which is the very reason the native side returns chunks.
    let bad = ts.length === rs.length ? -1 : Math.min(ts.length, rs.length);
    for (let i = 0; bad < 0 && i < ts.length; i++) {
      if (JSON.stringify(ts[i]) !== JSON.stringify(rs[i])) bad = i;
    }
    if (bad >= 0) {
      diffs++;
      if (diffs <= 5) {
        console.log(`DIFF ${label}: lengths ts=${ts.length} rs=${rs.length}, first differing element #${bad}`);
        console.log(`  ts: ${JSON.stringify(ts[bad])?.slice(0, 300)}`);
        console.log(`  rs: ${JSON.stringify(rs[bad])?.slice(0, 300)}`);
      }
    }
  }

  // The stream: same flattened sequence (batch boundaries follow a time budget and may differ).
  const streamed: Array<[string, SymbolQuery]> = [
    ...kinds.slice(0, 5).map((k): [string, SymbolQuery] => [`stream kind=${k}`, { withSource: true, kind: k }]),
    ["stream all", { withSource: false }],
    ["stream ids x2000", { withSource: true, ids: pick(ids, 2000) }],
  ];
  for (const [label, q] of streamed) {
    const collect = async (flag: string): Promise<unknown[]> => {
      process.env["CODESIFT_NATIVE_STORE"] = flag;
      const all: unknown[] = [];
      await streamSymbolsSqlite(dbPath, q, (b) => {
        for (const x of b) all.push(x);
      });
      return all;
    };
    const ts = await collect("0");
    const rs = await collect("1");
    rows += ts.length;
    let bad = ts.length === rs.length ? -1 : Math.min(ts.length, rs.length);
    for (let i = 0; bad < 0 && i < ts.length; i++) {
      if (JSON.stringify(ts[i]) !== JSON.stringify(rs[i])) bad = i;
    }
    if (bad >= 0) {
      diffs++;
      console.log(`DIFF ${label}: lengths ts=${ts.length} rs=${rs.length}, first differing element #${bad}`);
    }
  }
  queries.push(...streamed);

  process.env["CODESIFT_NATIVE_STORE"] = "0";
  const metaTs = JSON.stringify(await getIndexMetaSqlite(dbPath));
  process.env["CODESIFT_NATIVE_STORE"] = "1";
  const metaRs = JSON.stringify(await getIndexMetaSqlite(dbPath));
  if (metaTs !== metaRs) {
    diffs++;
    console.log(`DIFF meta: ts=${metaTs} rs=${metaRs}`);
  }
  closeAllIndexDbs();

  console.log(JSON.stringify({ db: dbPath, queries: queries.length + 1, rows_compared: rows, diffs }));
  process.exit(diffs === 0 ? 0 : 1);
}

void main();
