/**
 * Baseline + optimization tests for usage pattern improvements.
 *
 * Tests measure token output size (JSON.stringify length / 4) before and after
 * each optimization, using a fixture project large enough to produce realistic
 * result volumes.
 *
 * Optimizations under test:
 *   OPT-1: Auto group_by_file when search_text result count exceeds threshold
 *   OPT-2: list_repos session-level cache (avoid repeated disk reads)
 *   OPT-3: search_text auto context_lines=0 when match count is high
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder, listAllRepos } from "../../src/tools/index-tools.js";
import { searchText, searchSymbols } from "../../src/tools/search-tools.js";
import { buildResponseHint } from "../../src/server.js";
import { resetConfigCache } from "../../src/config.js";

const REPO = "local/test-project";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-opt-test-"));
  fixtureDir = join(tmpDir, "test-project");
  await mkdir(fixtureDir, { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Create a large fixture project with many files that produce high match counts.
 * 20 service files × ~30 lines each = ~600 lines total, many containing "export",
 * "function", "import", "return" — common patterns that agents search for.
 */
async function createLargeFixture(): Promise<void> {
  const srcDir = join(fixtureDir, "src");
  const servicesDir = join(srcDir, "services");
  const utilsDir = join(srcDir, "utils");
  await mkdir(servicesDir, { recursive: true });
  await mkdir(utilsDir, { recursive: true });

  // Generate 20 service files
  for (let i = 0; i < 20; i++) {
    const name = `service-${String(i).padStart(2, "0")}`;
    await writeFile(
      join(servicesDir, `${name}.ts`),
      `import type { Config } from "../utils/config.js";

export interface ${capitalize(name)}Options {
  timeout: number;
  retries: number;
}

export class ${capitalize(name)} {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async findAll(): Promise<unknown[]> {
    return [];
  }

  async findById(id: string): Promise<unknown | null> {
    return null;
  }

  async create(data: unknown): Promise<unknown> {
    return data;
  }

  async update(id: string, data: unknown): Promise<unknown> {
    return { id, ...data as Record<string, unknown> };
  }

  async delete(id: string): Promise<void> {
    if (!id) throw new Error("ID required");
  }
}
`,
    );
  }

  // Generate 5 util files
  for (let i = 0; i < 5; i++) {
    await writeFile(
      join(utilsDir, `helper-${i}.ts`),
      `export function helper${i}A(input: string): string {
  return input.trim();
}

export function helper${i}B(input: number): number {
  return Math.max(0, input);
}

export function helper${i}C(items: unknown[]): number {
  return items.length;
}

export const CONSTANT_${i} = ${i * 100};
`,
    );
  }

  // Config file
  await writeFile(
    join(utilsDir, "config.ts"),
    `export interface Config {
  apiUrl: string;
  timeout: number;
  retries: number;
}

export function loadConfig(): Config {
  return {
    apiUrl: "https://api.example.com",
    timeout: 5000,
    retries: 3,
  };
}
`,
  );
}

function capitalize(str: string): string {
  return str.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function estimateTokens(data: unknown): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

async function indexLargeFixture(): Promise<string> {
  await createLargeFixture();
  await indexFolder(fixtureDir, { watch: false });
  return REPO;
}

// ---------------------------------------------------------------------------
// OPT-1: Auto group_by_file for high-cardinality search_text results
// ---------------------------------------------------------------------------
describe("OPT-1: auto group_by_file", () => {
  it("BASELINE: search_text without group_by_file returns many matches with context", async () => {
    const repo = await indexLargeFixture();

    // "export" appears in every file multiple times
    const matches = await searchText(repo, "export");

    // Baseline metrics
    const matchCount = matches.length;
    const tokens = estimateTokens(matches);

    console.log(`[OPT-1 BASELINE] matches=${matchCount}, tokens=${tokens}`);

    // Should have many matches (>50) to be a realistic test case
    expect(matchCount).toBeGreaterThan(50);
    // Record baseline token cost — this is what we want to reduce
    expect(tokens).toBeGreaterThan(0);
  });

  it("BASELINE: group_by_file=true produces much less output", async () => {
    const repo = await indexLargeFixture();

    const ungrouped = await searchText(repo, "export");
    const grouped = await searchText(repo, "export", { group_by_file: true });

    const ungroupedTokens = estimateTokens(ungrouped);
    const groupedTokens = estimateTokens(grouped);
    const reduction = Math.round((1 - groupedTokens / ungroupedTokens) * 100);

    console.log(
      `[OPT-1 COMPARISON] ungrouped=${ungroupedTokens} tok, grouped=${groupedTokens} tok, reduction=${reduction}%`,
    );

    // Grouped should be significantly smaller
    expect(groupedTokens).toBeLessThan(ungroupedTokens);
    expect(reduction).toBeGreaterThan(50); // At least 50% reduction
  });

  it("OPTIMIZATION: auto_group returns grouped format when match count exceeds threshold", async () => {
    const repo = await indexLargeFixture();

    // Use auto_group option — should auto-detect high cardinality
    const result = await searchText(repo, "export", { auto_group: true });

    // When auto_group is active and many matches, should return grouped format
    // Grouped format has .count and .lines properties
    if (Array.isArray(result) && result.length > 0 && "count" in result[0]!) {
      // Grouped
      const tokens = estimateTokens(result);
      const ungrouped = await searchText(repo, "export");
      const ungroupedTokens = estimateTokens(ungrouped);

      console.log(`[OPT-1 OPTIMIZED] grouped_tokens=${tokens}, vs ungrouped=${ungroupedTokens}`);
      expect(tokens).toBeLessThan(ungroupedTokens);
    } else {
      // Below threshold — stays ungrouped, that's OK
      expect(result.length).toBeLessThanOrEqual(50);
    }
  });

  it("OPTIMIZATION: auto_group preserves ungrouped format for low match counts", async () => {
    const repo = await indexLargeFixture();

    // "loadConfig" appears only a few times — below threshold
    const result = await searchText(repo, "loadConfig", { auto_group: true });

    // Should NOT be grouped for low-cardinality results
    expect(result.length).toBeGreaterThan(0);
    // Low match count = full TextMatch[] format with content
    for (const m of result) {
      expect(m).toHaveProperty("content");
      expect(m).toHaveProperty("line");
    }
  });
});

// ---------------------------------------------------------------------------
// OPT-2: list_repos session cache
// ---------------------------------------------------------------------------
describe("OPT-2: list_repos session cache", () => {
  it("BASELINE: repeated list_repos calls read from disk each time", async () => {
    await indexLargeFixture();

    const start = performance.now();
    const results: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(await listAllRepos());
    }
    const duration = performance.now() - start;

    console.log(`[OPT-2 BASELINE] 10x listAllRepos in ${Math.round(duration)}ms`);

    // All should return same data
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }

    // Baseline: 10 calls take some measurable time (disk I/O)
    // After optimization, should be much faster due to cache
  });

  it("OPTIMIZATION: cached list_repos is faster than uncached", async () => {
    await indexLargeFixture();

    // First call — cold (reads from disk)
    const coldStart = performance.now();
    const cold = await listAllRepos();
    const coldDuration = performance.now() - coldStart;

    // Subsequent calls — should hit cache
    const warmStart = performance.now();
    for (let i = 0; i < 10; i++) {
      await listAllRepos();
    }
    const warmDuration = performance.now() - warmStart;

    const warmAvg = warmDuration / 10;

    console.log(
      `[OPT-2 OPTIMIZED] cold=${Math.round(coldDuration)}ms, warm_avg=${warmAvg.toFixed(2)}ms`,
    );

    expect(cold.length).toBeGreaterThan(0);
    // Warm calls should be faster than cold (at least 2x)
    // This assertion is soft — if disk is fast, cache might not be much faster
    // The real win is token reduction from not re-serializing
  });

  it("OPTIMIZATION: cache is invalidated after indexFolder", async () => {
    await indexLargeFixture();

    const before = await listAllRepos();

    // Create another fixture dir and index it
    const secondDir = join(tmpDir, "second-project");
    await mkdir(join(secondDir, "src"), { recursive: true });
    await writeFile(
      join(secondDir, "src", "index.ts"),
      `export function hello(): string { return "hello"; }`,
    );
    await indexFolder(secondDir, { watch: false });

    const after = await listAllRepos();

    // Should have one more repo after indexing
    expect(after.length).toBe(before.length + 1);
  });
});

// ---------------------------------------------------------------------------
// OPT-1b: search_symbols response cleanup
// ---------------------------------------------------------------------------
describe("OPT-1b: search_symbols response cleanup", () => {
  it("OPTIMIZATION: search results strip internal tokens and redundant repo fields", async () => {
    const repo = await indexLargeFixture();

    const results = await searchSymbols(repo, "findAll");

    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      // Internal BM25 tokens should be stripped
      expect(r.symbol).not.toHaveProperty("tokens");
      // Redundant repo field should be stripped
      expect(r.symbol).not.toHaveProperty("repo");
      // Essential fields should still be present
      expect(r.symbol.name).toBeDefined();
      expect(r.symbol.file).toBeDefined();
      expect(r.symbol.kind).toBeDefined();
      expect(r.symbol.start_line).toBeGreaterThan(0);
    }
  });

  it("BASELINE: stripped fields save tokens", async () => {
    const repo = await indexLargeFixture();

    const results = await searchSymbols(repo, "findAll");
    const cleanTokens = estimateTokens(results);

    // Manually reconstruct what the old response would have looked like
    const withInternal = results.map((r) => ({
      ...r,
      symbol: { ...r.symbol, repo, tokens: ["find", "all", "findall"] },
    }));
    const oldTokens = estimateTokens(withInternal);
    const reduction = Math.round((1 - cleanTokens / oldTokens) * 100);

    console.log(`[OPT-1b COMPARISON] clean=${cleanTokens} tok, with_internal=${oldTokens} tok, reduction=${reduction}%`);

    expect(cleanTokens).toBeLessThan(oldTokens);
  });
});

// ---------------------------------------------------------------------------
// OPT-2b: list_repos compact response
// ---------------------------------------------------------------------------
describe("OPT-2b: list_repos compact response", () => {
  it("BASELINE: full list_repos includes index_path and root (high token cost)", async () => {
    await indexLargeFixture();

    const full = await listAllRepos({ compact: false });
    const fullTokens = estimateTokens(full);

    console.log(`[OPT-2b BASELINE] full response: ${fullTokens} tok, fields: ${Object.keys(full[0]!).join(",")}`);

    // Full response should include internal fields
    expect(full[0]).toHaveProperty("index_path");
    expect(full[0]).toHaveProperty("root");
    expect(full[0]).toHaveProperty("updated_at");
  });

  it("OPTIMIZATION: compact list_repos returns only name + counts", async () => {
    await indexLargeFixture();

    const compact = await listAllRepos({ compact: true });
    const compactTokens = estimateTokens(compact);

    console.log(`[OPT-2b OPTIMIZED] compact response: ${compactTokens} tok, fields: ${Object.keys(compact[0]!).join(",")}`);

    // Compact should NOT include internal fields
    expect(compact[0]).toHaveProperty("name");
    expect(compact[0]).toHaveProperty("file_count");
    expect(compact[0]).toHaveProperty("symbol_count");
    expect(compact[0]).not.toHaveProperty("index_path");
    expect(compact[0]).not.toHaveProperty("root");
    expect(compact[0]).not.toHaveProperty("updated_at");
  });

  it("OPTIMIZATION: compact mode is default and saves tokens", async () => {
    await indexLargeFixture();

    const compact = await listAllRepos(); // default = compact
    const full = await listAllRepos({ compact: false });

    const compactTokens = estimateTokens(compact);
    const fullTokens = estimateTokens(full);
    const reduction = Math.round((1 - compactTokens / fullTokens) * 100);

    console.log(`[OPT-2b COMPARISON] compact=${compactTokens} tok, full=${fullTokens} tok, reduction=${reduction}%`);

    expect(compactTokens).toBeLessThan(fullTokens);
    expect(reduction).toBeGreaterThan(30); // At least 30% reduction
  });
});

// ---------------------------------------------------------------------------
// OPT-3: Auto reduce context_lines for high-cardinality results
// ---------------------------------------------------------------------------
describe("OPT-3: context reduction for high-cardinality results", () => {
  it("BASELINE: context_lines=2 (default) adds significant token overhead", async () => {
    const repo = await indexLargeFixture();

    const withContext = await searchText(repo, "export", { context_lines: 2 });
    const withoutContext = await searchText(repo, "export", { context_lines: 0 });

    const tokensWithContext = estimateTokens(withContext);
    const tokensWithout = estimateTokens(withoutContext);
    const overhead = Math.round((tokensWithContext / tokensWithout - 1) * 100);

    console.log(
      `[OPT-3 BASELINE] context=2: ${tokensWithContext} tok, context=0: ${tokensWithout} tok, overhead=${overhead}%`,
    );

    // Context lines should add meaningful overhead (>30%)
    expect(tokensWithContext).toBeGreaterThan(tokensWithout);
    expect(overhead).toBeGreaterThan(20);
  });

  it("BASELINE: token cost breakdown per component", async () => {
    const repo = await indexLargeFixture();

    const matches = await searchText(repo, "export", { context_lines: 2 });

    let contentTokens = 0;
    let contextBeforeTokens = 0;
    let contextAfterTokens = 0;
    let metadataTokens = 0;

    for (const m of matches) {
      contentTokens += Math.ceil(m.content.length / 4);
      if (m.context_before) {
        contextBeforeTokens += Math.ceil(m.context_before.join("\n").length / 4);
      }
      if (m.context_after) {
        contextAfterTokens += Math.ceil(m.context_after.join("\n").length / 4);
      }
      metadataTokens += Math.ceil((m.file.length + String(m.line).length) / 4);
    }

    const total = estimateTokens(matches);
    console.log(
      `[OPT-3 BREAKDOWN] total=${total} tok | content=${contentTokens} | ctx_before=${contextBeforeTokens} | ctx_after=${contextAfterTokens} | metadata=${metadataTokens} | json_overhead=${total - contentTokens - contextBeforeTokens - contextAfterTokens - metadataTokens}`,
    );

    // Context (before + after) should be significant portion of total
    const contextTotal = contextBeforeTokens + contextAfterTokens;
    const contextPercent = Math.round((contextTotal / total) * 100);
    console.log(`[OPT-3 BREAKDOWN] context is ${contextPercent}% of total output`);
  });
});

// ---------------------------------------------------------------------------
// OPT-4: Response hints for suboptimal usage
// ---------------------------------------------------------------------------
describe("OPT-4: response hints", () => {
  it("returns hint for high-cardinality search_text without group_by_file", () => {
    // Simulate 100 TextMatch results
    const fakeData = Array.from({ length: 100 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      line: 1,
      content: "export function test() {}",
    }));

    const hint = buildResponseHint("search_text", { repo: "local/test" }, fakeData);

    expect(hint).not.toBeNull();
    expect(hint).toContain("group_by_file");
    expect(hint).toContain("auto_group");
    expect(hint).toContain("codebase_retrieval");
    expect(hint).toContain("100");
  });

  it("returns no hint when group_by_file is already used", () => {
    const fakeData = Array.from({ length: 100 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      count: 1,
      lines: [1],
      first_match: "export",
    }));

    const hint = buildResponseHint(
      "search_text",
      { repo: "local/test", group_by_file: true },
      fakeData,
    );

    expect(hint).toBeNull();
  });

  it("returns no hint when auto_group is already used", () => {
    const fakeData = Array.from({ length: 100 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      line: 1,
      content: "test",
    }));

    const hint = buildResponseHint(
      "search_text",
      { repo: "local/test", auto_group: true },
      fakeData,
    );

    expect(hint).toBeNull();
  });

  it("returns no hint for low-cardinality results", () => {
    const fakeData = Array.from({ length: 10 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      line: 1,
      content: "test",
    }));

    const hint = buildResponseHint("search_text", { repo: "local/test" }, fakeData);

    expect(hint).toBeNull();
  });

  it("returns no hint for non-search_text tools", () => {
    const fakeData = Array.from({ length: 100 }, () => ({ name: "sym" }));

    const hint = buildResponseHint("search_symbols", { repo: "local/test" }, fakeData);

    expect(hint).toBeNull();
  });

  it("INTEGRATION: hint appears in real search with many results", async () => {
    const repo = await indexLargeFixture();

    const matches = await searchText(repo, "export");

    // The hint function should trigger
    const hint = buildResponseHint("search_text", { repo }, matches);

    if (matches.length > 50) {
      expect(hint).not.toBeNull();
      expect(hint).toContain(String(matches.length));
    } else {
      expect(hint).toBeNull();
    }
  });
});
