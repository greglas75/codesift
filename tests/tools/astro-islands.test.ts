import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex, FileEntry } from "../../src/types.js";
import { analyzeIslandsFromIndex } from "../../src/tools/astro-islands.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), "codesift-astro-islands-test");

let fixtureCounter = 0;

function createFixtureDir(files: Record<string, string>): string {
  const dir = join(TMP_ROOT, `run-${Date.now()}-${fixtureCounter++}`);
  mkdirSync(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function makeIndex(root: string, astroPaths: string[]): CodeIndex {
  const files: FileEntry[] = astroPaths.map((p) => ({
    path: p,
    language: "astro",
    symbol_count: 1,
    last_modified: Date.now(),
  }));
  return {
    repo: "local/test",
    root,
    symbols: [],
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: files.length,
    file_count: files.length,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("astroAnalyzeIslands", () => {
  it("returns empty result when no .astro files in index", () => {
    const root = createFixtureDir({});
    const index = makeIndex(root, []);

    const result = analyzeIslandsFromIndex(index);

    expect(result.islands).toEqual([]);
    expect(result.summary.total_islands).toBe(0);
    expect(result.summary.by_directive).toEqual({});
    expect(result.summary.by_framework).toEqual({});
    expect(result.summary.warnings).toEqual([]);
    expect(result.server_islands).toEqual([]);
  });

  it("detects a React client:load island with all fields", () => {
    const source = `---
import Counter from '../components/Counter.tsx';
---
<div>
  <Counter client:load count={0} />
</div>
`;
    const root = createFixtureDir({ "src/pages/index.astro": source });
    const index = makeIndex(root, ["src/pages/index.astro"]);

    const result = analyzeIslandsFromIndex(index);

    expect(result.islands).toHaveLength(1);
    const island = result.islands[0]!;
    expect(island.component_name).toBe("Counter");
    expect(island.directive).toBe("client:load");
    expect(island.framework_hint).toBe("react");
    expect(island.target_kind).toBe("framework");
    expect(island.line).toBeGreaterThan(0);
    expect(island.document_order).toBe(0);
    // file annotation
    expect((island as any).file).toBe("src/pages/index.astro");

    expect(result.summary.total_islands).toBe(1);
    expect(result.summary.by_directive["client:load"]).toBe(1);
    expect(result.summary.by_framework["react"]).toBe(1);
  });

  it("groups mixed frameworks (React + Svelte) in summary", () => {
    const source = `---
import Counter from '../components/Counter.tsx';
import Toggle from '../components/Toggle.svelte';
---
<div>
  <Counter client:load />
  <Toggle client:idle />
</div>
`;
    const root = createFixtureDir({ "src/pages/mixed.astro": source });
    const index = makeIndex(root, ["src/pages/mixed.astro"]);

    const result = analyzeIslandsFromIndex(index);

    expect(result.islands).toHaveLength(2);
    expect(result.summary.by_framework["react"]).toBe(1);
    expect(result.summary.by_framework["svelte"]).toBe(1);
  });

  it("counts by_directive correctly for load, idle, visible", () => {
    const source = `---
import A from './A.tsx';
import B from './B.tsx';
import C from './C.tsx';
import D from './D.tsx';
---
<A client:load />
<B client:idle />
<C client:visible />
<D client:load />
`;
    const root = createFixtureDir({ "src/pages/multi.astro": source });
    const index = makeIndex(root, ["src/pages/multi.astro"]);

    const result = analyzeIslandsFromIndex(index);

    expect(result.summary.total_islands).toBe(4);
    expect(result.summary.by_directive["client:load"]).toBe(2);
    expect(result.summary.by_directive["client:idle"]).toBe(1);
    expect(result.summary.by_directive["client:visible"]).toBe(1);
  });

  it("filters results by path_prefix", () => {
    const pageSource = `---
import Counter from '../components/Counter.tsx';
---
<Counter client:load />
`;
    const layoutSource = `---
import Nav from '../components/Nav.tsx';
---
<Nav client:load />
`;
    const root = createFixtureDir({
      "src/pages/index.astro": pageSource,
      "src/layouts/Base.astro": layoutSource,
    });
    const index = makeIndex(root, ["src/pages/index.astro", "src/layouts/Base.astro"]);

    const result = analyzeIslandsFromIndex(index, "src/pages/");

    expect(result.islands).toHaveLength(1);
    expect((result.islands[0] as any).file).toBe("src/pages/index.astro");
    expect(result.summary.total_islands).toBe(1);
  });

  it("puts server:defer components into server_islands, not islands", () => {
    const source = `---
import Comments from '../components/Comments.tsx';
---
<div>
  <Comments server:defer>
    <p>Loading comments...</p>
  </Comments>
</div>
`;
    const root = createFixtureDir({ "src/pages/post.astro": source });
    const index = makeIndex(root, ["src/pages/post.astro"]);

    const result = analyzeIslandsFromIndex(index);

    // server:defer should NOT appear in islands
    expect(result.islands).toHaveLength(0);
    expect(result.summary.total_islands).toBe(0);

    // Should appear in server_islands
    expect(result.server_islands).toHaveLength(1);
    const si = result.server_islands[0]!;
    expect(si.component).toBe("Comments");
    expect(si.file).toBe("src/pages/post.astro");
    expect(si.line).toBeGreaterThan(0);
    expect(si.has_fallback).toBe(true);
  });
});
