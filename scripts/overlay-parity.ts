/**
 * Parity of a worktree overlay (storage/sqlite/overlay.ts) against the full copy it replaces, on a
 * REAL index: the same writes go to both, and every read path must answer the same.
 *
 *   node --max-old-space-size=12288 --import tsx scripts/overlay-parity.ts <copy of an index.db> [files-to-touch]
 *
 * The writes: every file's mtime (as a seed records them), then rewrites, removals and new files.
 * Works on copies in a temp directory; the index given is only read. Prints the diffs (0 expected),
 * the two database sizes, and read timings on both.
 */
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadSqliteCtor } from "../src/storage/sqlite/runtime.js";
import { closeAllIndexDbs } from "../src/storage/sqlite/connection.js";
import { loadIndexSqlite } from "../src/storage/sqlite/index-io.js";
import { loadIndexSummarySqlite, removeFileFromIndexSqlite, saveIncrementalSqlite, setFileMtimesSqlite } from "../src/storage/sqlite/accessors.js";
import { findSymbolsSqlite, getIndexMetaSqlite, streamSymbolsSqlite } from "../src/storage/sqlite/queries.js";
import { findSymbolsByRequestedIdsSqlite } from "../src/storage/sqlite/narrow-queries.js";
import { baseForDonor, writeOverlayIndex } from "../src/tools/index-tools/worktree-overlay.js";
import type { CodeSymbol } from "../src/types.js";
import { getNativeCore } from "../src/native/index.js";

const source = process.argv[2];
const touch = Number(process.argv[3] ?? 300);
if (!source) {
  console.error("usage: overlay-parity.ts <index.db> [files-to-touch]");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "overlay-parity-"));
// The donor's checkout: a base records its uncommitted files, and refuses when git cannot say.
execFileSync("git", ["init", "-q"], { cwd: dir });
const donor = join(dir, "aaaaaaaaaaaa.index.db");
const plain = join(dir, "cccccccccccc.index.db");
const overlay = join(dir, "bbbbbbbbbbbb.index.db");
let diffs = 0;
/** Element by element: one JSON string of a 500k-symbol array is past V8's string limit. */
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
    return true;
  }
  return JSON.stringify(a) === JSON.stringify(b);
};
const diff = (label: string, a: unknown, b: unknown): void => {
  const same = equal(a, b);
  if (!same) diffs++;
  console.log(`${same ? "ok  " : "DIFF"} ${label}`);
  if (!same && !Array.isArray(a)) console.log(`     full:    ${JSON.stringify(a).slice(0, 300)}\n     overlay: ${JSON.stringify(b).slice(0, 300)}`);
};
const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const out = await fn();
  return [out, Math.round(performance.now() - t)];
};

try {
  copyFileSync(source, donor);
  const Ctor = (await loadSqliteCtor())!;
  const d = new Ctor(donor);
  const repo = (d.prepare("SELECT value FROM meta WHERE key = 'repo'").get() as { value: string }).value;
  d.exec(`VACUUM INTO '${plain}'`);
  d.close();
  const family = repo.split("@")[0]!;
  const wt = `${family}@overlay-parity`;
  const p = new Ctor(plain);
  // The full copy: the donor's rows under the worktree's meta. Ids and parent ids carry the prefix the
  // overlay's base gives them (the family), so the two compare row for row.
  for (const column of ["id", "parent"]) {
    p.prepare(`UPDATE symbols SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?`)
      .run(`${family}:`, repo.length + 2, repo.length + 1, `${repo}:`);
  }
  p.prepare("UPDATE meta SET value = ? WHERE key = 'repo'").run(wt);
  p.prepare("UPDATE meta SET value = '/parity' WHERE key = 'root'").run();
  p.close();

  const [picked, baseMs] = await time(() => baseForDonor(donor, { name: repo, root: dir, commit: null }, family, dir));
  await writeOverlayIndex(`${overlay}.seeding`, {
    donorDb: donor, donorName: repo, donorIsOverlay: false, base: picked.base, worktreeName: wt, worktreeRoot: "/parity",
  });
  await rename(`${overlay}.seeding`, overlay);
  console.log(`base ${(statSync(picked.base.path).size / 1e6).toFixed(0)} MB in ${baseMs} ms`);

  // The writes: every `step`-th file rewritten (its symbols renamed under the worktree), every
  // third of those removed, and some new files added.
  const full = (await loadIndexSqlite(plain))!;
  const byFile = new Map<string, CodeSymbol[]>();
  for (const s of full.symbols) (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s);
  const step = Math.max(1, Math.floor(full.files.length / touch));
  const targets = full.files.filter((_, i) => i % step === 0).slice(0, touch);
  const writes = async (db: string) => {
    // Every file's own mtime, as a seed records them (worktree-overlay.ts observeWorktreeMtimes).
    await setFileMtimesSqlite(db, full.files.map((f) => [f.path, (f.mtime_ms ?? 0) + 1] as const));
    for (const [i, f] of targets.entries()) {
      if (i % 3 === 2) { await removeFileFromIndexSqlite(db, f.path); continue; }
      const symbols = (byFile.get(f.path) ?? []).map((s) => ({ ...s, id: `${wt}:${s.file}:${s.name}:${s.start_line}`, source: `${s.source ?? ""}\n// edited` }));
      await saveIncrementalSqlite(db, f.path, symbols, { ...f, mtime_ms: 1 });
    }
    for (let n = 0; n < 20; n++) {
      const file = `parity/new${n}.ts`;
      const sym: CodeSymbol = { id: `${wt}:${file}:fresh${n}:1`, repo: wt, name: `fresh${n}`, kind: "function", file, start_line: 1, end_line: 2 };
      await saveIncrementalSqlite(db, file, [sym], { path: file, language: "typescript", symbol_count: 1, last_modified: 1, mtime_ms: 1 });
    }
  };
  await writes(plain);
  await writes(overlay);
  closeAllIndexDbs();
  console.log(`touched ${targets.length} files + 20 new`);

  const [a, loadPlain] = await time(() => loadIndexSqlite(plain));
  const [b, loadOverlay] = await time(() => loadIndexSqlite(overlay));
  diff(`loadIndex symbols (${a?.symbols.length})`, a?.symbols, b?.symbols);
  diff(`loadIndex files (${a?.files.length})`, a?.files, b?.files);
  const sum = async (db: string) => ({ ...(await loadIndexSummarySqlite(db)), updated_at: 0 });
  diff("summary", await sum(plain), await sum(overlay));
  const meta = async (db: string) => ({ ...(await getIndexMetaSqlite(db)), updatedAt: 0 });
  diff("index meta", await meta(plain), await meta(overlay));
  const stream = async (db: string) => {
    const ids: string[] = [];
    await streamSymbolsSqlite(db, { withSource: true }, (batch) => { for (const s of batch) ids.push(`${s.id}|${s.source?.length ?? 0}`); });
    return ids;
  };
  const [sa, streamPlain] = await time(() => stream(plain));
  const [sb, streamOverlay] = await time(() => stream(overlay));
  diff(`stream (${sa.length})`, sa, sb);
  const sample = a!.symbols.filter((_, i) => i % Math.max(1, Math.floor(a!.symbols.length / 200)) === 0);
  for (const q of [{ kind: "class" }, { kind: "method" }, { namePrefix: "use" }]) {
    diff(`find ${JSON.stringify(q)}`, await findSymbolsSqlite(plain, { withSource: false, ...q }), await findSymbolsSqlite(overlay, { withSource: false, ...q }));
  }
  let nameDiffs = 0;
  const [, namesOverlay] = await time(async () => {
    for (const s of sample) {
      const [x, y] = [await findSymbolsSqlite(plain, { withSource: true, name: s.name }), await findSymbolsSqlite(overlay, { withSource: true, name: s.name })];
      if (JSON.stringify(x) !== JSON.stringify(y)) nameDiffs++;
    }
  });
  diff(`find by name x${sample.length} (${nameDiffs} differing)`, nameDiffs, 0);
  const tails = sample.map((s) => s.id.slice(s.id.indexOf(":") + 1));
  diff(`ids without prefix x${tails.length}`, await findSymbolsByRequestedIdsSqlite(plain, tails, false), await findSymbolsByRequestedIdsSqlite(overlay, tails, false));

  // The call graph is built in Rust by its own query over `symbols` (callgraph.rs) — through the views.
  const core = await getNativeCore();
  if (core) {
    const [ga, gb] = [await core.buildCallGraph(plain, false, false), await core.buildCallGraph(overlay, false, false)];
    diff("call graph nodes/edges", [ga.nodeCount, ga.edgeCount], [gb.nodeCount, gb.edgeCount]);
    let edgeDiffs = 0;
    for (const s of sample) {
      for (const dir of ["callers", "callees"] as const) {
        const [x, y] = [ga[dir](s.id), gb[dir](s.id)];
        const ids = (g: typeof ga, v: Uint32Array | null) => (v ? g.idsAt(v) : null);
        if (JSON.stringify(ids(ga, x)) !== JSON.stringify(ids(gb, y))) edgeDiffs++;
      }
    }
    diff(`call graph callers/callees x${sample.length} (${edgeDiffs} differing)`, edgeDiffs, 0);
    ga.release();
    gb.release();
  } else {
    console.log("skip call graph (no native core)");
  }

  console.log(`\nsize: full copy ${(statSync(plain).size / 1e6).toFixed(1)} MB, overlay ${(statSync(overlay).size / 1e6).toFixed(1)} MB`);
  console.log(`loadIndex: full ${loadPlain} ms, overlay ${loadOverlay} ms`);
  console.log(`stream (with source): full ${streamPlain} ms, overlay ${streamOverlay} ms`);
  console.log(`find by name x${sample.length} (both): ${namesOverlay} ms`);
  console.log(`\n${diffs} diff(s)`);
} finally {
  closeAllIndexDbs();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(diffs === 0 ? 0 : 1);
