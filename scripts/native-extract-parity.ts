/**
 * Extractor parity on REAL code (ADR-006 stage 3): every TypeScript / TSX / JavaScript / Python file under a
 * directory, extracted by web-tree-sitter + the TypeScript extractor and by the Rust extractor,
 * compared byte for byte after JSON.stringify (same symbols, same order, same keys in the same order).
 *
 *   node --max-old-space-size=8192 --import tsx scripts/native-extract-parity.ts <dir> [--limit N]
 *
 * Normalised before comparing, and only this: a lone surrogate (a 5,000-unit truncation can split a
 * pair) becomes U+FFFD, the character both paths store in SQLite.
 *
 * Exit 0 = identical, 1 = differences (the first few are printed), 2 = usage / no native core.
 */
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { initParser, parseFile, getLanguageForPath } from "../src/parser/parser-manager.js";
import { extractSymbols } from "../src/parser/symbol-extractor.js";
import { getNativeCore } from "../src/native/index.js";

const NATIVE_LANGUAGES = new Set(["typescript", "tsx", "javascript", "python", "go", "rust", "php"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", "target", ".venv", "venv", "__pycache__"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, out);
    else if (st.isFile() && st.size < 2_000_000) out.push(path);
  }
}

function normalise(json: string): string {
  // JSON.stringify escapes a lone surrogate as \udXXX; the Rust side already holds U+FFFD there.
  return json.replace(/\\ud[89ab][0-9a-f]{2}(?!\\udc|\\udd|\\ude|\\udf)/gi, "�").replace(/(?<!\\ud[89ab][0-9a-f]{2})\\ud[cdef][0-9a-f]{2}/gi, "�");
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: native-extract-parity.ts <dir> [--limit N]");
    process.exit(2);
  }
  const gi = process.argv.indexOf("--lang");
  const only = gi > 0 ? new Set(process.argv[gi + 1]!.split(",")) : null;
  const li = process.argv.indexOf("--limit");
  const limit = li > 0 ? Number(process.argv[li + 1]) : Infinity;
  const core = getNativeCore();
  if (!core) {
    console.error("no native core");
    process.exit(2);
  }
  await initParser();

  const files: string[] = [];
  walk(root, files);
  const targets = files
    .map((abs) => ({ abs, rel: relative(root, abs), language: getLanguageForPath(relative(root, abs)) }))
    .filter((f): f is { abs: string; rel: string; language: string } => f.language !== null && NATIVE_LANGUAGES.has(f.language) && (only === null || only.has(f.language)))
    .slice(0, limit);

  let diffs = 0;
  let symbols = 0;
  let tsMs = 0;
  let rsMs = 0;
  for (const { abs, rel, language } of targets) {
    const source = await readFile(abs, "utf-8");

    let t = performance.now();
    const tree = await parseFile(abs, source);
    const ts = tree ? extractSymbols(tree, rel, source, "local/parity", language) : [];
    tsMs += performance.now() - t;

    t = performance.now();
    const out = await core.extractSymbols(source, rel, "local/parity", language, 30_000);
    rsMs += performance.now() - t;

    const a = normalise(JSON.stringify(ts));
    const b = normalise(JSON.stringify(JSON.parse(out.json)));
    symbols += ts.length;
    if (a !== b) {
      diffs++;
      if (diffs <= 6) {
        let at = 0;
        while (at < a.length && a[at] === b[at]) at++;
        console.log(`DIFF ${rel} (${language}) — ts ${ts.length} symbols, rs ${(JSON.parse(out.json) as unknown[]).length}; first divergence at char ${at}`);
        console.log(`  ts: …${a.slice(Math.max(0, at - 120), at + 160)}`);
        console.log(`  rs: …${b.slice(Math.max(0, at - 120), at + 160)}`);
      }
    }
  }
  console.log(JSON.stringify({ root, files: targets.length, symbols, diffs, ts_ms: Math.round(tsMs), native_ms: Math.round(rsMs) }));
  process.exit(diffs === 0 ? 0 : 1);
}

void main();
