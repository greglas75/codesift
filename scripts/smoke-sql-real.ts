/**
 * Smoke test: run extractSqlSymbols against real-world SQL files.
 *
 * Reports per-file: symbol counts by kind, parse time, errors.
 * Aggregates: total files, total symbols, slowest files, errors.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { extractSqlSymbols, stripJinjaTokens } from "../src/parser/extractors/sql.js";
import { analyzeSchema } from "../src/tools/sql-tools.js";
import { indexFolder } from "../src/tools/index-tools.js";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("usage: tsx scripts/smoke-sql-real.ts <root-dir>");
  process.exit(1);
}

function* walkSql(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) yield* walkSql(full);
    else if (name.endsWith(".sql")) yield full;
  }
}

interface FileResult {
  path: string;
  bytes: number;
  symbolsByKind: Record<string, number>;
  totalSymbols: number;
  parseTimeMs: number;
  hasJinja: boolean;
  error?: string;
}

const files: string[] = [];
for (const f of walkSql(ROOT)) files.push(f);
console.log(`Found ${files.length} SQL files under ${ROOT}`);

const results: FileResult[] = [];
let totalBytes = 0;
let totalSymbols = 0;
let totalParseTime = 0;
let crashes = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const r: FileResult = {
    path: rel,
    bytes: 0,
    symbolsByKind: {},
    totalSymbols: 0,
    parseTimeMs: 0,
    hasJinja: false,
  };

  try {
    const source = readFileSync(file, "utf-8");
    r.bytes = source.length;
    totalBytes += source.length;

    const hasJinja = /\{\{|\{%|\{#/.test(source);
    r.hasJinja = hasJinja;
    const toParse = hasJinja ? stripJinjaTokens(source) : source;

    const t0 = performance.now();
    const symbols = extractSqlSymbols(toParse, rel, "real-test", hasJinja ? source : undefined);
    const t1 = performance.now();

    r.parseTimeMs = t1 - t0;
    r.totalSymbols = symbols.length;
    for (const s of symbols) {
      r.symbolsByKind[s.kind] = (r.symbolsByKind[s.kind] ?? 0) + 1;
    }
    totalSymbols += symbols.length;
    totalParseTime += r.parseTimeMs;
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
    crashes++;
  }

  results.push(r);
}

// ── Aggregate report ──────────────────────────
console.log("\n═══ AGGREGATE ═══");
console.log(`Files:         ${files.length}`);
console.log(`Total bytes:   ${totalBytes.toLocaleString()} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`Total symbols: ${totalSymbols.toLocaleString()}`);
console.log(`Crashes:       ${crashes}`);
console.log(`Total parse:   ${totalParseTime.toFixed(0)}ms`);
console.log(`Avg per file:  ${(totalParseTime / files.length).toFixed(2)}ms`);

const kindTotals: Record<string, number> = {};
for (const r of results) {
  for (const [k, v] of Object.entries(r.symbolsByKind)) {
    kindTotals[k] = (kindTotals[k] ?? 0) + v;
  }
}
console.log("\n═══ SYMBOLS BY KIND ═══");
for (const [k, v] of Object.entries(kindTotals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${v.toLocaleString()}`);
}

// Top 10 slowest
const slowest = [...results].sort((a, b) => b.parseTimeMs - a.parseTimeMs).slice(0, 10);
console.log("\n═══ TOP 10 SLOWEST FILES ═══");
for (const r of slowest) {
  console.log(`  ${r.parseTimeMs.toFixed(1).padStart(7)}ms  ${r.totalSymbols.toString().padStart(4)} sym  ${(r.bytes / 1024).toFixed(0).padStart(5)}KB  ${r.path.slice(-80)}`);
}

// Top 10 by symbol count
const richest = [...results].sort((a, b) => b.totalSymbols - a.totalSymbols).slice(0, 10);
console.log("\n═══ TOP 10 RICHEST FILES (by symbol count) ═══");
for (const r of richest) {
  const breakdown = Object.entries(r.symbolsByKind).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  ${r.totalSymbols.toString().padStart(4)} sym  [${breakdown}]  ${r.path.slice(-70)}`);
}

// Files with Jinja
const jinja = results.filter(r => r.hasJinja);
if (jinja.length > 0) {
  console.log(`\n═══ JINJA-DETECTED FILES (${jinja.length}) ═══`);
  for (const r of jinja.slice(0, 10)) {
    console.log(`  ${r.totalSymbols} sym  ${r.path}`);
  }
}

// Errors
const errors = results.filter(r => r.error);
if (errors.length > 0) {
  console.log(`\n═══ ERRORS (${errors.length}) ═══`);
  for (const r of errors) {
    console.log(`  ${r.path}: ${r.error}`);
  }
}

// Files with 0 symbols (potential extractor gaps)
const empty = results.filter(r => r.totalSymbols === 0 && r.bytes > 100);
if (empty.length > 0) {
  console.log(`\n═══ NON-EMPTY FILES WITH 0 SYMBOLS (${empty.length}) — possible parser gap ═══`);
  for (const r of empty.slice(0, 20)) {
    console.log(`  ${r.bytes.toString().padStart(6)}B  ${r.path}`);
  }
  if (empty.length > 20) console.log(`  ... and ${empty.length - 20} more`);
}

console.log(`\n✅ Smoke test complete. ${crashes === 0 ? "Zero crashes." : `${crashes} CRASHES.`}`);
