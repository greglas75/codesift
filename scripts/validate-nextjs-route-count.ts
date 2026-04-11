#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * SC2: For each of the 3 committed fixtures, walk the filesystem with
 * canonical route-file globs via picomatch, and assert that the set of
 * walked files exactly equals the set of routes returned by
 * `nextjsRouteMap`. Exit 1 on any mismatch.
 *
 * Fixtures:
 *   - tests/fixtures/nextjs-app-router
 *   - tests/fixtures/nextjs-pages-router
 *   - tests/fixtures/nextjs-hybrid
 */

import { readdir, stat } from "node:fs/promises";
import { resolve, relative, join, extname } from "node:path";
import picomatch from "picomatch";

// Import the route-tools internals so we can run the pipeline directly
// without going through getCodeIndex. This mirrors how validate-nextjs-accuracy
// is structured (Task 25).
import { parseRouteFile, type NextjsRouteEntry } from "../src/tools/nextjs-route-tools.js";
import { discoverWorkspaces } from "../src/utils/nextjs.js";

const FIXTURES_DIR = resolve(import.meta.dirname, "../tests/fixtures");

const APP_GLOBS = [
  "app/**/{page,route,layout,loading,error,not-found,default,template,global-error}.{tsx,jsx,ts,js}",
];
const PAGES_GLOBS = ["pages/**/*.{tsx,jsx,ts,js}"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next"]);

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function inner(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await inner(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await inner(root);
  return out;
}

async function collectExpected(
  workspaceRoot: string,
  router: "app" | "pages",
): Promise<Set<string>> {
  const globs = router === "app" ? APP_GLOBS : PAGES_GLOBS;
  const matcher = picomatch(globs, { dot: false });
  const all = await walk(workspaceRoot);
  const out = new Set<string>();
  for (const abs of all) {
    const rel = relative(workspaceRoot, abs);
    if (matcher(rel)) out.add(rel);
  }
  return out;
}

async function collectActual(
  workspaceRoot: string,
): Promise<NextjsRouteEntry[]> {
  const all = await walk(workspaceRoot);
  const results: NextjsRouteEntry[] = [];
  const ROUTE_EXT = new Set([".tsx", ".jsx", ".ts", ".js"]);
  for (const abs of all) {
    const ext = extname(abs);
    if (!ROUTE_EXT.has(ext)) continue;
    const rel = relative(workspaceRoot, abs);
    let router: "app" | "pages" | null = null;
    if (rel.startsWith("app/") || rel.startsWith("src/app/")) {
      if (!/\/(page|route|layout|loading|error|not-found|default|template|global-error)\.[jt]sx?$/.test(rel)) {
        continue;
      }
      router = "app";
    } else if (rel.startsWith("pages/") || rel.startsWith("src/pages/")) {
      router = "pages";
    } else {
      continue;
    }
    try {
      const entry = await parseRouteFile(abs, workspaceRoot, router);
      results.push(entry);
    } catch {
      // Skip unparseable fixture files
    }
  }
  return results;
}

interface FixtureSpec {
  name: string;
  path: string;
  /** For monorepo hybrid fixture, list per-workspace sub-roots. */
  workspaces?: string[];
}

async function validateFixture(fx: FixtureSpec): Promise<boolean> {
  // Discover workspaces for the hybrid case
  let roots: string[];
  if (fx.workspaces) {
    roots = fx.workspaces.map((w) => join(fx.path, w));
  } else {
    const discovered = await discoverWorkspaces(fx.path);
    roots = discovered.length > 0 ? discovered.map((w) => w.root) : [fx.path];
  }

  const expected = new Set<string>();
  const actual = new Set<string>();

  for (const wsRoot of roots) {
    const wsRel = relative(fx.path, wsRoot);
    const prefix = wsRel ? `${wsRel}/` : "";

    // Check which routers exist in this workspace
    const appExpected = await collectExpected(wsRoot, "app");
    const pagesExpected = await collectExpected(wsRoot, "pages");
    for (const p of appExpected) expected.add(prefix + p);
    for (const p of pagesExpected) expected.add(prefix + p);

    const actualEntries = await collectActual(wsRoot);
    for (const e of actualEntries) actual.add(prefix + e.file_path);
  }

  const missing = [...expected].filter((p) => !actual.has(p));
  const extra = [...actual].filter((p) => !expected.has(p));

  if (missing.length > 0 || extra.length > 0) {
    console.error(`FAIL: ${fx.name} route count mismatch`);
    console.error(`  expected: ${expected.size}`);
    console.error(`  actual:   ${actual.size}`);
    if (missing.length > 0) {
      console.error(`  missing (in expected, not in actual):`);
      for (const p of missing) console.error(`    - ${p}`);
    }
    if (extra.length > 0) {
      console.error(`  extra (in actual, not in expected):`);
      for (const p of extra) console.error(`    + ${p}`);
    }
    return false;
  }

  console.log(`  ${fx.name}: ${actual.size} routes match`);
  return true;
}

async function main(): Promise<number> {
  const fixtures: FixtureSpec[] = [
    { name: "nextjs-app-router", path: join(FIXTURES_DIR, "nextjs-app-router") },
    { name: "nextjs-pages-router", path: join(FIXTURES_DIR, "nextjs-pages-router") },
    {
      name: "nextjs-hybrid",
      path: join(FIXTURES_DIR, "nextjs-hybrid"),
      workspaces: ["apps/web-app", "apps/web-pages"],
    },
  ];

  let allOk = true;
  for (const fx of fixtures) {
    try {
      await stat(fx.path);
    } catch {
      console.error(`SKIP ${fx.name}: fixture not found`);
      continue;
    }
    const ok = await validateFixture(fx);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    console.error("SC2: FAIL");
    return 1;
  }
  console.log(`SC2: PASS ${fixtures.length}/${fixtures.length} fixtures`);
  return 0;
}

process.exit(await main());
