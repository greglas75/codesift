#!/usr/bin/env node
// Weekly telemetry product report (spec §6). Reads collected Level-1 payloads
// (JSONL from the collector) and answers the four questions that drive
// "what to polish": tool ranking, version adoption, hint efficacy, latency vs
// repo size. Emits Markdown to stdout — the Monday retro-mine digest folds it in
// as a third source alongside retros + backlogs.
//
// Usage:
//   node scripts/telemetry-report.mjs [dataDir] [--since YYYY-MM-DD]
//   dataDir default: ~/.codesift/telemetry-collected/codesift
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const dataDir = args.find((a) => !a.startsWith("--") && a !== since)
  ?? join(homedir(), ".codesift", "telemetry-collected", "codesift");

function loadPayloads() {
  const out = [];
  let files = [];
  try { files = readdirSync(dataDir).filter((f) => f.endsWith(".jsonl")); } catch { return out; }
  for (const f of files) {
    if (since && f.slice(0, 10) < since) continue;
    let raw;
    try { raw = readFileSync(join(dataDir, f), "utf-8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        const p = rec.payload ?? rec;
        if (p && typeof p === "object" && Array.isArray(p.tools)) out.push(p);
      } catch { /* skip */ }
    }
  }
  return out;
}

const payloads = loadPayloads();
if (payloads.length === 0) {
  console.log(`# CodeSift telemetry report\n\n_No collected payloads in ${dataDir}${since ? ` since ${since}` : ""}._`);
  process.exit(0);
}

const installs = new Set();
const versionInstalls = new Map();     // version -> Set(anon_id)
const tool = new Map();                // name -> {count, errW, emptyW, cacheW, maxP95}
const latByBucket = new Map();         // name -> Map(bucket -> {p95Sum, n})
const hint = new Map();                // code -> count

for (const p of payloads) {
  const anon = String(p.anon_id ?? "?");
  installs.add(anon);
  const ver = p.env?.codesift_ver ?? "unknown";
  if (!versionInstalls.has(ver)) versionInstalls.set(ver, new Set());
  versionInstalls.get(ver).add(anon);
  const bucket = p.env?.repo_size_bucket ?? "n/a";

  for (const t of p.tools) {
    let a = tool.get(t.tool);
    if (!a) { a = { count: 0, errW: 0, emptyW: 0, cacheW: 0, maxP95: 0 }; tool.set(t.tool, a); }
    a.count += t.count ?? 0;
    a.errW += (t.error_rate ?? 0) * (t.count ?? 0);
    a.emptyW += (t.empty_result_rate ?? 0) * (t.count ?? 0);
    a.cacheW += (t.cache_hit_rate ?? 0) * (t.count ?? 0);
    a.maxP95 = Math.max(a.maxP95, t.p95_ms ?? 0);

    if (!latByBucket.has(t.tool)) latByBucket.set(t.tool, new Map());
    const lb = latByBucket.get(t.tool);
    if (!lb.has(bucket)) lb.set(bucket, { p95Sum: 0, n: 0 });
    const e = lb.get(bucket);
    e.p95Sum += t.p95_ms ?? 0; e.n += 1;
  }
  for (const h of p.hints ?? []) hint.set(h.hint_code, (hint.get(h.hint_code) ?? 0) + (h.count ?? 0));
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const rows = [...tool.entries()].map(([name, a]) => ({
  name, count: a.count,
  err: a.count ? a.errW / a.count : 0,
  empty: a.count ? a.emptyW / a.count : 0,
  cache: a.count ? a.cacheW / a.count : 0,
  maxP95: a.maxP95,
})).sort((x, y) => y.count - x.count);

const L = [];
L.push(`# CodeSift telemetry report`);
L.push(`\n_${payloads.length} payloads · ${installs.size} unique installs${since ? ` · since ${since}` : ""} · ${dataDir}_`);

L.push(`\n## 1. Tool ranking — fix / kill candidates`);
L.push(`\n| tool | calls | error% | empty% | cache% | worst p95 (ms) | flag |`);
L.push(`|------|------:|-------:|-------:|-------:|---------------:|------|`);
for (const r of rows) {
  const flags = [];
  if (r.err > 0.1) flags.push("HIGH-ERROR");
  if (r.empty > 0.5) flags.push("HIGH-EMPTY");
  if (r.maxP95 > 30_000) flags.push("SLOW-TAIL");
  L.push(`| ${r.name} | ${r.count} | ${pct(r.err)} | ${pct(r.empty)} | ${pct(r.cache)} | ${r.maxP95} | ${flags.join(" ") || "—"} |`);
}

L.push(`\n## 2. Version adoption — are fixes reaching users?`);
L.push(`\n| codesift_ver | installs |`);
L.push(`|--------------|---------:|`);
for (const [ver, set] of [...versionInstalls.entries()].sort((a, b) => b[1].size - a[1].size)) {
  L.push(`| ${ver} | ${set.size} |`);
}

L.push(`\n## 3. Hint efficacy — which hints fire (H1–H18)`);
if (hint.size === 0) { L.push(`\n_No hint emissions recorded._`); }
else {
  L.push(`\n| hint | emissions |`);
  L.push(`|------|----------:|`);
  for (const [code, n] of [...hint.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${code} | ${n} |`);
}
L.push(`\n_(hint-APPLIED and plan_turn recommended→used funnels pending client capture.)_`);

L.push(`\n## 4. Latency vs repo size — where it scales badly`);
L.push(`\n| tool | repo bucket | avg p95 (ms) | samples |`);
L.push(`|------|-------------|-------------:|--------:|`);
for (const r of rows.slice(0, 12)) {
  const lb = latByBucket.get(r.name);
  if (!lb) continue;
  for (const [bucket, e] of [...lb.entries()].sort()) {
    L.push(`| ${r.name} | ${bucket} | ${Math.round(e.p95Sum / e.n)} | ${e.n} |`);
  }
}

console.log(L.join("\n"));
