#!/usr/bin/env node
/**
 * Reconcile `registry.json` with what is actually on disk.
 *
 * Two drifts, both observed on this machine 2026-08-07:
 *
 *  - **Entries whose root no longer exists** (32 of 335). Harmless-looking, except one of them was
 *    `local/tgm-survey-platform` pointing at a DELETED worktree — so the name resolved to nothing
 *    while the real main checkout was unreachable, and every worktree of that repo had been
 *    collapsing onto that one name before the `@worktree` fix.
 *  - **Index databases with no registry entry at all.** The main checkout above was one: 630 MB and
 *    240,699 symbols on disk, described nowhere. That is not merely invisible — `codesift prune`
 *    deletes artifacts whose hash is not in the registry, so the largest index on the machine was
 *    one prune away from being erased.
 *
 * Repair is reconstruction, never invention: name and root come from each database's own `meta`
 * table, which is authoritative. An entry is only written when its recorded root still exists.
 *
 * Usage:  node scripts/repair-registry.mjs [--apply]     (default: dry run)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const APPLY = process.argv.includes("--apply");
const DATA = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
const REGISTRY = join(DATA, "registry.json");

const registry = JSON.parse(readFileSync(REGISTRY, "utf-8"));
const repos = registry.repos ?? {};

const deadRoots = [];
for (const [name, meta] of Object.entries(repos)) {
  const root = meta?.root;
  if (root && !existsSync(root)) deadRoots.push({ name, root });
}

/** Read a database's own idea of who it is. Authoritative — it was written by the indexer. */
function describeDb(file) {
  try {
    const db = new DatabaseSync(`file:${file}?mode=ro`, { open: true });
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
    const symbols = db.prepare("SELECT COUNT(*) AS n FROM symbols").get()?.n ?? 0;
    const files = db.prepare("SELECT COUNT(*) AS n FROM files").get()?.n ?? 0;
    db.close();
    if (!meta["repo"] || !meta["root"]) return null;
    return { repo: meta["repo"], root: meta["root"], symbols, files, updated_at: Number(meta["updated_at"] ?? 0) };
  } catch {
    return null; // not a codesift index, or unreadable — never a reason to guess
  }
}

const knownIndexPaths = new Set(Object.values(repos).map((m) => m?.index_path).filter(Boolean));
const orphans = [];
for (const entry of readdirSync(DATA)) {
  if (!entry.endsWith(".index.db")) continue;
  const file = join(DATA, entry);
  const jsonTwin = file.replace(/\.index\.db$/, ".index.json");
  if (knownIndexPaths.has(file) || knownIndexPaths.has(jsonTwin)) continue;
  const d = describeDb(file);
  if (!d) continue;
  // Only re-register something whose tree is still there. A database describing a deleted
  // directory is genuine garbage, and re-registering it would resurrect the first drift.
  if (!existsSync(d.root)) continue;
  orphans.push({ file, ...d });
}

console.log(`registry entries: ${Object.keys(repos).length}`);
console.log(`dead roots (entry points at a directory that is gone): ${deadRoots.length}`);
for (const d of deadRoots.slice(0, 8)) console.log(`   - ${d.name}  ->  ${d.root}`);
if (deadRoots.length > 8) console.log(`   … and ${deadRoots.length - 8} more`);

console.log(`unregistered index databases whose tree still exists: ${orphans.length}`);
for (const o of orphans) {
  const clash = repos[o.repo];
  console.log(
    `   + ${o.repo}  (${o.symbols} symbols, ${o.files} files)  ->  ${o.root}` +
      (clash ? `   [name currently held by an entry rooted at ${clash.root}]` : ""),
  );
}

if (!APPLY) {
  console.log("\ndry run — pass --apply to write. Nothing changed.");
  process.exit(0);
}

const deadNames = new Set(deadRoots.map((entry) => entry.name));
const candidatesByRepo = new Map();
for (const orphan of orphans) {
  const candidates = candidatesByRepo.get(orphan.repo) ?? [];
  candidates.push(orphan);
  candidatesByRepo.set(orphan.repo, candidates);
}

// A healthy registry owner must never be displaced by a detached database
// carrying the same legacy name. When the existing owner is dead or absent,
// repair only a single unambiguous candidate; filesystem iteration order is
// not a sound way to choose between two live checkouts.
const repairs = [];
for (const [repo, candidates] of candidatesByRepo) {
  if ((repos[repo] && !deadNames.has(repo)) || candidates.length !== 1) continue;
  repairs.push(candidates[0]);
}

const backup = `${REGISTRY}.bak-${Date.now()}`;
copyFileSync(REGISTRY, backup);

for (const d of deadRoots) delete repos[d.name];
for (const o of repairs) {
  repos[o.repo] = {
    name: o.repo,
    root: o.root,
    // Canonical form is the `.index.json` path even when storage is SQLite — `sqlitePathFor()`
    // derives the `.db` from it, and every other registry entry uses that form. Writing the `.db`
    // path here made the entry invisible to `prune`'s live-set, which is how this repair nearly
    // destroyed the 8.33 GB it had just rescued.
    index_path: o.file.replace(/\.index\.db$/, ".index.json"),
    symbol_count: o.symbols,
    file_count: o.files,
    updated_at: o.updated_at || Date.now(),
  };
}
registry.repos = repos;
registry.updated_at = Date.now();
writeFileSync(REGISTRY, JSON.stringify(registry), "utf-8");

console.log(`\nbackup: ${backup}`);
console.log(`removed ${deadRoots.length}, re-registered ${repairs.length}, now ${Object.keys(repos).length} entries`);
