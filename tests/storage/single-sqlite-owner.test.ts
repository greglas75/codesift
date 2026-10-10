// Bug it catches: a src module opening a database through `node:sqlite` directly. With the native store
// on (the default since ADR-006 stage 5), that is a second copy of SQLite on an index file in the same
// process — fcntl locks never conflict within a process, and a closing connection of one copy deletes
// the -wal/-shm the other still holds (lost writes). Every database goes through loadSqliteCtor().
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Runtime loads of node:sqlite that are deliberate, and why. */
const ALLOWED: Record<string, string> = {
  "src/storage/sqlite/runtime.ts": "loadSqliteCtor's own fallback when the native store is off",
  "src/cli/commands-daemon.ts": "daemon-lock.db, which nothing else opens",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isSymbolicLink()) return [];
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|cts)$/.test(e.name) ? [path] : [];
  });
}

const RUNTIME_LOAD = [
  /\bimport\s*\(\s*["']node:sqlite["']\s*\)/,
  /\bimport\s+(?!type\b)[^;]*?\bfrom\s*["']node:sqlite["']/,
  /\brequire\s*\(\s*["']node:sqlite["']\s*\)/,
];

function loadsNodeSqlite(source: string): boolean {
  // Comments mention the module freely; only code counts. `import("node:sqlite").DatabaseSync` in a
  // type position is still a dynamic-import expression, so type annotations use `import type`.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return RUNTIME_LOAD.some((re) => re.test(code));
}

describe("one SQLite copy per process", () => {
  it("loads node:sqlite at runtime only where it is deliberate", () => {
    const loaders = sourceFiles(join(ROOT, "src"))
      .filter((file) => loadsNodeSqlite(readFileSync(file, "utf-8")))
      .map((file) => relative(ROOT, file).split("\\").join("/"))
      .sort();
    expect(loaders).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each([
    ["a dynamic import", 'const m = await import("node:sqlite");', true],
    ["a value import", 'import { DatabaseSync } from "node:sqlite";', true],
    ["a type import", 'import type { DatabaseSync } from "node:sqlite";', false],
    ["a comment", '// never import("node:sqlite") here', false],
  ])("classifies %s", (_case, source, expected) => {
    expect(loadsNodeSqlite(source)).toBe(expected);
  });
});
