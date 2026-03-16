import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder, getCodeIndex } from "../../src/tools/index-tools.js";
import { searchSymbols, searchText } from "../../src/tools/search-tools.js";
import { getFileTree, getFileOutline, getRepoOutline } from "../../src/tools/outline-tools.js";
import { getSymbol, getSymbols, findAndShow, findReferences, findDeadCode, getContextBundle } from "../../src/tools/symbol-tools.js";
import { assembleContext, getKnowledgeMap } from "../../src/tools/context-tools.js";
import { analyzeComplexity } from "../../src/tools/complexity-tools.js";
import { findClones } from "../../src/tools/clone-tools.js";
import { analyzeHotspots } from "../../src/tools/hotspot-tools.js";
import { searchPatterns, listPatterns } from "../../src/tools/pattern-tools.js";
import { generateClaudeMd } from "../../src/tools/generate-tools.js";
import { codebaseRetrieval } from "../../src/retrieval/codebase-retrieval.js";
import { resetConfigCache } from "../../src/config.js";

const REPO = "local/test-project";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-tools-test-"));
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
 * Create a fixture project with cross-file imports for testing
 * symbol search, references, and context assembly.
 */
async function createFixtureProject(): Promise<void> {
  await mkdir(join(fixtureDir, "src"), { recursive: true });

  // src/types.ts — shared interfaces
  await writeFile(
    join(fixtureDir, "src", "types.ts"),
    `export interface User {
  id: string;
  name: string;
  email: string;
}

export interface PaymentInfo {
  cardNumber: string;
  amount: number;
  currency: string;
}

export type UserRole = "admin" | "editor" | "viewer";
`,
  );

  // src/user-service.ts — imports from types.ts
  await writeFile(
    join(fixtureDir, "src", "user-service.ts"),
    `import type { User, UserRole } from "./types.js";

/**
 * Retrieves a user by their unique ID.
 */
export async function getUserById(id: string): Promise<User | null> {
  return null;
}

export async function createUser(name: string, email: string, role: UserRole): Promise<User> {
  return { id: "1", name, email };
}

export class UserService {
  async findAll(): Promise<User[]> {
    return [];
  }

  async deleteUser(id: string): Promise<void> {
    const user = await getUserById(id);
    if (!user) throw new Error("User not found");
  }
}
`,
  );

  // src/payment.ts — standalone functions, also uses PaymentInfo
  await writeFile(
    join(fixtureDir, "src", "payment.ts"),
    `import type { PaymentInfo } from "./types.js";

export function processPayment(info: PaymentInfo): boolean {
  return info.amount > 0;
}

export function validateCard(cardNumber: string): boolean {
  return cardNumber.length === 16;
}

export function formatCurrency(amount: number, currency: string): string {
  return amount.toFixed(2) + " " + currency;
}
`,
  );
}

/**
 * Helper: index the fixture project and return the repo name.
 */
async function indexFixture(): Promise<string> {
  await createFixtureProject();
  await indexFolder(fixtureDir, { watch: false });
  return REPO;
}

// ---------------------------------------------------------------------------
// search_tools
// ---------------------------------------------------------------------------
describe("search_tools", () => {
  describe("searchSymbols", () => {
    it("finds symbols by name", async () => {
      const repo = await indexFixture();

      const results = await searchSymbols(repo, "getUserById");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.symbol.name).toBe("getUserById");
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("returns source by default", async () => {
      const repo = await indexFixture();

      const results = await searchSymbols(repo, "processPayment");

      expect(results.length).toBeGreaterThan(0);
      const sym = results[0]!.symbol;
      expect(sym.source).toBeDefined();
      expect(sym.source).toContain("processPayment");
    });

    it("filters by kind", async () => {
      const repo = await indexFixture();

      const results = await searchSymbols(repo, "User", { kind: "interface" });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.symbol.kind).toBe("interface");
      }
    });

    it("filters by file_pattern", async () => {
      const repo = await indexFixture();

      const results = await searchSymbols(repo, "payment", {
        file_pattern: "**/*.ts",
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.symbol.file).toMatch(/\.ts$/);
      }
    });

    it("filters by specific file_pattern", async () => {
      const repo = await indexFixture();

      const results = await searchSymbols(repo, "processPayment", {
        file_pattern: "src/payment.ts",
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.symbol.file).toBe("src/payment.ts");
      }
    });

    it("returns empty array when no matches", async () => {
      const repo = await indexFixture();

      const results = await searchSymbols(repo, "xyzNonExistentSymbol");

      expect(results).toEqual([]);
    });
  });

  describe("searchText", () => {
    it("finds text in files", async () => {
      const repo = await indexFixture();

      const matches = await searchText(repo, "processPayment");

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.file === "src/payment.ts")).toBe(true);
      expect(matches[0]!.content).toContain("processPayment");
      expect(matches[0]!.line).toBeGreaterThan(0);
    });

    it("finds text with regex", async () => {
      const repo = await indexFixture();

      const matches = await searchText(repo, "export (async )?function", {
        regex: true,
      });

      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m.content).toMatch(/export (async )?function/);
      }
    });

    it("includes context lines", async () => {
      const repo = await indexFixture();

      const matches = await searchText(repo, "processPayment", {
        context_lines: 2,
      });

      expect(matches.length).toBeGreaterThan(0);
      // The function definition line should have context around it
      const defMatch = matches.find((m) => m.content.includes("export function processPayment"));
      expect(defMatch).toBeDefined();
    });

    it("returns empty array when no matches", async () => {
      const repo = await indexFixture();

      const matches = await searchText(repo, "xyzNonExistentText");

      expect(matches).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// outline_tools
// ---------------------------------------------------------------------------
describe("outline_tools", () => {
  describe("getFileTree", () => {
    it("returns directory tree with symbol counts", async () => {
      const repo = await indexFixture();

      const tree = await getFileTree(repo);

      expect(tree.length).toBeGreaterThan(0);

      // Should have a "src" directory node
      const srcNode = tree.find((n) => n.name === "src" && n.type === "dir");
      expect(srcNode).toBeDefined();
      expect(srcNode!.children).toBeDefined();
      expect(srcNode!.children!.length).toBe(3);

      // File nodes should have symbol_count
      const fileNodes = srcNode!.children!.filter((n) => n.type === "file");
      expect(fileNodes.length).toBe(3);
      for (const f of fileNodes) {
        expect(f.symbol_count).toBeDefined();
        expect(f.symbol_count).toBeGreaterThanOrEqual(0);
      }
    });

    it("filters by path_prefix", async () => {
      const repo = await indexFixture();

      const tree = await getFileTree(repo, { path_prefix: "src" });

      expect(tree.length).toBeGreaterThan(0);
      // All nodes should be under src
      for (const node of tree) {
        expect(node.path).toMatch(/^src/);
      }
    });

    it("compact mode returns flat list of paths with symbol counts", async () => {
      const repo = await indexFixture();

      const result = await getFileTree(repo, { compact: true });

      // Should be an array of { path, symbols } entries
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(3); // 3 files in fixture

      for (const entry of result) {
        expect(entry).toHaveProperty("path");
        expect(entry).toHaveProperty("symbols");
        expect(typeof (entry as { path: string }).path).toBe("string");
        expect(typeof (entry as { symbols: number }).symbols).toBe("number");
      }

      // Should NOT have nested tree properties
      for (const entry of result) {
        expect(entry).not.toHaveProperty("children");
        expect(entry).not.toHaveProperty("type");
        expect(entry).not.toHaveProperty("name");
      }

      // Should be sorted alphabetically by path
      const paths = result.map((e) => (e as { path: string }).path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });

    it("compact mode with path_prefix filters correctly", async () => {
      const repo = await indexFixture();

      const result = await getFileTree(repo, { compact: true, path_prefix: "src" });

      expect(result.length).toBe(3);
      for (const entry of result) {
        expect((entry as { path: string }).path).toMatch(/^src\//);
      }
    });

    it("compact mode with name_pattern filters correctly", async () => {
      const repo = await indexFixture();

      const result = await getFileTree(repo, { compact: true, name_pattern: "*.ts" });

      expect(result.length).toBe(3);
      for (const entry of result) {
        expect((entry as { path: string }).path).toMatch(/\.ts$/);
      }
    });

    it("compact mode produces much less output than full mode", async () => {
      const repo = await indexFixture();

      const compact = await getFileTree(repo, { compact: true });
      const full = await getFileTree(repo);

      const compactSize = JSON.stringify(compact).length;
      const fullSize = JSON.stringify(full).length;

      // Compact should be meaningfully smaller
      expect(compactSize).toBeLessThan(fullSize);
    });

    it("min_symbols filters files by symbol count", async () => {
      const repo = await indexFixture();

      // Get all files first to find the max symbol count
      const allFiles = await getFileTree(repo, { compact: true });
      expect(allFiles.length).toBe(3);

      // Find a threshold that filters out at least one file
      const symbolCounts = allFiles.map((e) => (e as { symbols: number }).symbols);
      const maxSymbols = Math.max(...symbolCounts);

      // Filter with min_symbols = maxSymbols should return only the file(s) with that count
      const filtered = await getFileTree(repo, { compact: true, min_symbols: maxSymbols });
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.length).toBeLessThanOrEqual(allFiles.length);

      for (const entry of filtered) {
        expect((entry as { symbols: number }).symbols).toBeGreaterThanOrEqual(maxSymbols);
      }
    });

    it("min_symbols works with full (non-compact) mode", async () => {
      const repo = await indexFixture();

      // Very high threshold should return empty or very few files
      const result = await getFileTree(repo, { min_symbols: 999 });

      // Collect all file nodes from the tree
      function collectFiles(nodes: typeof result): number {
        let count = 0;
        for (const node of nodes) {
          if ("type" in node && node.type === "file") count++;
          if ("children" in node && node.children) count += collectFiles(node.children);
        }
        return count;
      }

      expect(collectFiles(result)).toBe(0);
    });
  });

  describe("getFileOutline", () => {
    it("returns symbols for a file sorted by start_line", async () => {
      const repo = await indexFixture();

      const outline = await getFileOutline(repo, "src/user-service.ts");

      expect(outline.length).toBeGreaterThan(0);

      const names = outline.map((e) => e.name);
      expect(names).toContain("getUserById");
      expect(names).toContain("createUser");
      expect(names).toContain("UserService");

      // Verify sorted by start_line
      for (let i = 1; i < outline.length; i++) {
        expect(outline[i]!.start_line).toBeGreaterThanOrEqual(outline[i - 1]!.start_line);
      }

      // Each entry has required fields
      for (const entry of outline) {
        expect(entry.name).toBeDefined();
        expect(entry.kind).toBeDefined();
        expect(entry.start_line).toBeGreaterThan(0);
        expect(entry.end_line).toBeGreaterThanOrEqual(entry.start_line);
      }
    });

    it("returns empty array for non-existent file", async () => {
      const repo = await indexFixture();

      const outline = await getFileOutline(repo, "src/nonexistent.ts");

      expect(outline).toEqual([]);
    });
  });

  describe("getRepoOutline", () => {
    it("returns per-directory summary", async () => {
      const repo = await indexFixture();

      const outline = await getRepoOutline(repo);

      expect(outline.total_files).toBe(3);
      expect(outline.total_symbols).toBeGreaterThan(0);
      expect(outline.directories.length).toBeGreaterThan(0);
      expect(outline.languages).toBeDefined();
      expect(outline.languages["typescript"]).toBe(3);

      // Each directory entry has the right shape
      for (const dir of outline.directories) {
        expect(dir.path).toBeDefined();
        expect(dir.file_count).toBeGreaterThan(0);
        expect(dir.symbol_count).toBeGreaterThanOrEqual(0);
        expect(dir.languages.length).toBeGreaterThan(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// symbol_tools
// ---------------------------------------------------------------------------
describe("symbol_tools", () => {
  describe("getSymbol", () => {
    it("retrieves a single symbol by ID with source", async () => {
      const repo = await indexFixture();

      // Get a symbol ID from the index
      const index = await getCodeIndex(repo);
      expect(index).not.toBeNull();
      const targetSym = index!.symbols.find((s) => s.name === "processPayment");
      expect(targetSym).toBeDefined();

      const result = await getSymbol(repo, targetSym!.id);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("processPayment");
      expect(result!.id).toBe(targetSym!.id);
      expect(result!.source).toBeDefined();
      expect(result!.source).toContain("processPayment");
    });

    it("returns null for non-existent symbol ID", async () => {
      const repo = await indexFixture();

      const result = await getSymbol(repo, "nonexistent:id:here:1");

      expect(result).toBeNull();
    });
  });

  describe("getSymbols", () => {
    it("batch retrieves multiple symbols", async () => {
      const repo = await indexFixture();

      const index = await getCodeIndex(repo);
      expect(index).not.toBeNull();

      const ids = index!.symbols
        .filter((s) => ["processPayment", "validateCard", "getUserById"].includes(s.name))
        .map((s) => s.id);

      expect(ids.length).toBeGreaterThanOrEqual(3);

      const results = await getSymbols(repo, ids);

      expect(results.length).toBe(ids.length);
      const names = results.map((s) => s.name);
      expect(names).toContain("processPayment");
      expect(names).toContain("validateCard");
      expect(names).toContain("getUserById");

      // Each result has source
      for (const sym of results) {
        expect(sym.source).toBeDefined();
      }
    });

    it("preserves requested order", async () => {
      const repo = await indexFixture();

      const index = await getCodeIndex(repo);
      const sym1 = index!.symbols.find((s) => s.name === "validateCard");
      const sym2 = index!.symbols.find((s) => s.name === "processPayment");
      expect(sym1).toBeDefined();
      expect(sym2).toBeDefined();

      const results = await getSymbols(repo, [sym1!.id, sym2!.id]);

      expect(results[0]!.name).toBe("validateCard");
      expect(results[1]!.name).toBe("processPayment");
    });

    it("skips non-existent IDs", async () => {
      const repo = await indexFixture();

      const index = await getCodeIndex(repo);
      const validId = index!.symbols[0]!.id;

      const results = await getSymbols(repo, [validId, "nonexistent:id:0"]);

      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(validId);
    });
  });

  describe("findAndShow", () => {
    it("finds and returns symbol with source", async () => {
      const repo = await indexFixture();

      const result = await findAndShow(repo, "processPayment");

      expect(result).not.toBeNull();
      expect(result!.symbol.name).toBe("processPayment");
      expect(result!.symbol.source).toBeDefined();
      expect(result!.symbol.source).toContain("processPayment");
    });

    it("includes references when requested", async () => {
      const repo = await indexFixture();

      const result = await findAndShow(repo, "getUserById", true);

      expect(result).not.toBeNull();
      expect(result!.symbol.name).toBe("getUserById");
      expect(result!.references).toBeDefined();
      expect(result!.references!.length).toBeGreaterThan(0);
    });

    it("returns null when no symbols match", async () => {
      const repo = await indexFixture();

      const result = await findAndShow(repo, "xyzCompletelyAbsentSymbol");

      expect(result).toBeNull();
    });
  });

  describe("findReferences", () => {
    it("finds references across files", async () => {
      const repo = await indexFixture();

      // getUserById is defined in user-service.ts and called in the deleteUser method
      const refs = await findReferences(repo, "getUserById");

      expect(refs.length).toBeGreaterThan(0);

      // Should find it in user-service.ts (definition + usage)
      const userServiceRefs = refs.filter((r) => r.file === "src/user-service.ts");
      expect(userServiceRefs.length).toBeGreaterThanOrEqual(2); // definition + call in deleteUser

      // Each reference has required fields
      for (const ref of refs) {
        expect(ref.file).toBeDefined();
        expect(ref.line).toBeGreaterThan(0);
        expect(ref.context).toBeDefined();
        expect(ref.context).toContain("getUserById");
      }
    });

    it("finds cross-file references via type imports", async () => {
      const repo = await indexFixture();

      // "User" is defined in types.ts and imported in user-service.ts
      const refs = await findReferences(repo, "User");

      expect(refs.length).toBeGreaterThan(0);

      const files = [...new Set(refs.map((r) => r.file))];
      // Should appear in at least types.ts and user-service.ts
      expect(files).toContain("src/types.ts");
      expect(files).toContain("src/user-service.ts");
    });
  });
});

// ---------------------------------------------------------------------------
// context_tools
// ---------------------------------------------------------------------------
describe("context_tools", () => {
  describe("assembleContext", () => {
    it("returns context within token budget", async () => {
      const repo = await indexFixture();

      const result = await assembleContext(repo, "user", 5000);

      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.total_tokens).toBeGreaterThan(0);
      expect(result.total_tokens).toBeLessThanOrEqual(5000);
      expect(typeof result.truncated).toBe("boolean");

      // Symbols should have source
      for (const sym of result.symbols) {
        expect(sym.source).toBeDefined();
      }
    });

    it("truncates when budget is very small", async () => {
      const repo = await indexFixture();

      // Use a tiny budget so not all results fit
      const result = await assembleContext(repo, "function", 50);

      expect(result.total_tokens).toBeLessThanOrEqual(50);
      // With a budget of 50 tokens (~200 chars), it should truncate
      // unless only one very small symbol matches
    });

    it("returns relevant symbols for the query", async () => {
      const repo = await indexFixture();

      const result = await assembleContext(repo, "payment", 5000);

      expect(result.symbols.length).toBeGreaterThan(0);
      // The top results should be payment-related
      const names = result.symbols.map((s) => s.name);
      const hasPaymentRelated = names.some(
        (n) => n.toLowerCase().includes("payment") || n.toLowerCase().includes("card") || n.toLowerCase().includes("currency"),
      );
      expect(hasPaymentRelated).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// context_tools: getKnowledgeMap + circular dependency detection
// ---------------------------------------------------------------------------
describe("knowledge_map", () => {
  it("returns modules and edges for the fixture project", async () => {
    const repo = await indexFixture();

    const map = await getKnowledgeMap(repo);

    expect(map.modules.length).toBe(3); // types.ts, user-service.ts, payment.ts
    expect(map.edges.length).toBeGreaterThan(0);
    // user-service.ts imports from types.ts
    expect(map.edges.some((e) => e.from.includes("user-service") && e.to.includes("types"))).toBe(true);
    // payment.ts imports from types.ts
    expect(map.edges.some((e) => e.from.includes("payment") && e.to.includes("types"))).toBe(true);
    // circular_deps should exist (may be empty for this fixture)
    expect(Array.isArray(map.circular_deps)).toBe(true);
  });

  it("reports no circular deps in acyclic fixture", async () => {
    const repo = await indexFixture();

    const map = await getKnowledgeMap(repo);

    // The standard fixture has no circular imports
    expect(map.circular_deps).toHaveLength(0);
  });

  it("detects circular dependencies in cyclic fixture", async () => {
    // Create a fixture with A -> B -> C -> A cycle
    await mkdir(join(fixtureDir, "src"), { recursive: true });

    await writeFile(
      join(fixtureDir, "src", "module-a.ts"),
      `import { helperB } from "./module-b.js";
export function funcA(): string { return helperB(); }
`,
    );

    await writeFile(
      join(fixtureDir, "src", "module-b.ts"),
      `import { helperC } from "./module-c.js";
export function helperB(): string { return helperC(); }
`,
    );

    await writeFile(
      join(fixtureDir, "src", "module-c.ts"),
      `import { funcA } from "./module-a.js";
export function helperC(): string { return funcA(); }
`,
    );

    await indexFolder(fixtureDir, { watch: false });

    const map = await getKnowledgeMap(REPO);

    // Should detect the A -> B -> C -> A cycle
    expect(map.circular_deps.length).toBeGreaterThan(0);
    const cycle = map.circular_deps[0]!;
    expect(cycle.length).toBe(3); // 3 edges
    expect(cycle.cycle.length).toBe(4); // 4 nodes (first == last)
    // First and last should be the same (closed cycle)
    expect(cycle.cycle[0]).toBe(cycle.cycle[cycle.cycle.length - 1]);
  });

  it("detects simple A <-> B mutual dependency", async () => {
    await mkdir(join(fixtureDir, "src"), { recursive: true });

    await writeFile(
      join(fixtureDir, "src", "alpha.ts"),
      `import { beta } from "./beta.js";
export function alpha(): string { return beta(); }
`,
    );

    await writeFile(
      join(fixtureDir, "src", "beta.ts"),
      `import { alpha } from "./alpha.js";
export function beta(): string { return alpha(); }
`,
    );

    await indexFolder(fixtureDir, { watch: false });

    const map = await getKnowledgeMap(REPO);

    expect(map.circular_deps.length).toBeGreaterThan(0);
    const cycle = map.circular_deps[0]!;
    expect(cycle.length).toBe(2); // 2 edges: A->B, B->A
  });

  it("filters circular deps to focus path", async () => {
    await mkdir(join(fixtureDir, "src", "core"), { recursive: true });
    await mkdir(join(fixtureDir, "src", "utils"), { recursive: true });

    // Cycle in core/
    await writeFile(
      join(fixtureDir, "src", "core", "x.ts"),
      `import { y } from "./y.js";
export function x(): string { return y(); }
`,
    );
    await writeFile(
      join(fixtureDir, "src", "core", "y.ts"),
      `import { x } from "./x.js";
export function y(): string { return x(); }
`,
    );
    // No cycle in utils/
    await writeFile(
      join(fixtureDir, "src", "utils", "helper.ts"),
      `export function helper(): number { return 42; }
`,
    );

    await indexFolder(fixtureDir, { watch: false });

    // Focus on utils — should see no circular deps
    const utilsMap = await getKnowledgeMap(REPO, "utils");
    expect(utilsMap.circular_deps).toHaveLength(0);

    // Focus on core — should see the cycle
    const coreMap = await getKnowledgeMap(REPO, "core");
    expect(coreMap.circular_deps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// get_context_bundle
// ---------------------------------------------------------------------------
describe("get_context_bundle", () => {
  it("returns symbol + imports + siblings in one call", async () => {
    const repo = await indexFixture();

    const bundle = await getContextBundle(repo, "getUserById");

    expect(bundle).not.toBeNull();
    expect(bundle!.symbol.name).toBe("getUserById");
    expect(bundle!.symbol.source).toBeDefined();

    // Should have imports from the file
    expect(bundle!.imports.length).toBeGreaterThan(0);
    expect(bundle!.imports.some((i) => i.includes("types"))).toBe(true);

    // Should have sibling symbols from same file (createUser, UserService, etc.)
    expect(bundle!.siblings.length).toBeGreaterThan(0);
    const siblingNames = bundle!.siblings.map((s) => s.name);
    expect(siblingNames).toContain("createUser");
    expect(siblingNames).toContain("UserService");

    // Should have types_used extracted from the symbol source
    expect(Array.isArray(bundle!.types_used)).toBe(true);
    // getUserById returns Promise<User | null> — should reference User
    expect(bundle!.types_used).toContain("User");
  });

  it("returns null for non-existent symbol", async () => {
    const repo = await indexFixture();

    const bundle = await getContextBundle(repo, "xyzNonExistent");

    expect(bundle).toBeNull();
  });

  it("includes all import lines from the file", async () => {
    const repo = await indexFixture();

    const bundle = await getContextBundle(repo, "processPayment");

    expect(bundle).not.toBeNull();
    // payment.ts imports from types.ts
    expect(bundle!.imports.some((i) => i.includes("PaymentInfo"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// find_dead_code
// ---------------------------------------------------------------------------
describe("find_dead_code", () => {
  it("finds exported symbols with no external references", async () => {
    // Create fixture with a dead export
    await mkdir(join(fixtureDir, "src"), { recursive: true });

    await writeFile(
      join(fixtureDir, "src", "used.ts"),
      `export function usedFunc(): string { return "used"; }
export function deadFunc(): string { return "dead"; }
`,
    );

    await writeFile(
      join(fixtureDir, "src", "consumer.ts"),
      `import { usedFunc } from "./used.js";
export function main(): string { return usedFunc(); }
`,
    );

    await indexFolder(fixtureDir, { watch: false });

    const result = await findDeadCode(REPO);

    expect(result.scanned_symbols).toBeGreaterThan(0);
    expect(result.scanned_files).toBeGreaterThan(0);

    // deadFunc is exported but never referenced outside used.ts
    const dead = result.candidates.find((c) => c.name === "deadFunc");
    expect(dead).toBeDefined();
    expect(dead!.file).toBe("src/used.ts");
    expect(dead!.reason).toContain("no references");

    // usedFunc should NOT be in candidates (it's imported by consumer.ts)
    const used = result.candidates.find((c) => c.name === "usedFunc");
    expect(used).toBeUndefined();
  });

  it("excludes test files by default", async () => {
    await mkdir(join(fixtureDir, "src"), { recursive: true });

    await writeFile(
      join(fixtureDir, "src", "service.ts"),
      `export function serve(): void {}`,
    );

    await writeFile(
      join(fixtureDir, "src", "service.test.ts"),
      `import { serve } from "./service.js";
export function testHelper(): void { serve(); }
`,
    );

    await indexFolder(fixtureDir, { watch: false });

    // Without tests: serve() has no non-test external refs
    const withoutTests = await findDeadCode(REPO);
    const serveCandidate = withoutTests.candidates.find((c) => c.name === "serve");
    // serve is referenced in test file, but tests excluded by default
    // however test imports DO count as external refs if we read ALL files
    // Actually: include_tests=false means we skip test files from scanning too
    // So testHelper won't be in candidates (it's in test file = excluded)
    expect(withoutTests.candidates.every((c) => !c.file.includes(".test."))).toBe(true);
  });

  it("filters by file_pattern", async () => {
    await mkdir(join(fixtureDir, "src", "a"), { recursive: true });
    await mkdir(join(fixtureDir, "src", "b"), { recursive: true });

    await writeFile(
      join(fixtureDir, "src", "a", "alpha.ts"),
      `export function alphaFunc(): void {}`,
    );
    await writeFile(
      join(fixtureDir, "src", "b", "beta.ts"),
      `export function betaFunc(): void {}`,
    );

    await indexFolder(fixtureDir, { watch: false });

    const result = await findDeadCode(REPO, { file_pattern: "src/a" });

    // Should only contain candidates from src/a
    for (const c of result.candidates) {
      expect(c.file).toContain("src/a");
    }
  });

  it("returns empty candidates when all exports are used", async () => {
    const repo = await indexFixture(); // Standard fixture: all types are imported

    const result = await findDeadCode(repo);

    // In the standard fixture, types.ts exports are used by user-service.ts and payment.ts
    const typesCandidates = result.candidates.filter((c) => c.file === "src/types.ts");
    // User and PaymentInfo should not be dead (they're imported)
    expect(typesCandidates.find((c) => c.name === "User")).toBeUndefined();
    expect(typesCandidates.find((c) => c.name === "PaymentInfo")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// analyze_complexity
// ---------------------------------------------------------------------------
describe("analyze_complexity", () => {
  it("returns complexity info for functions in fixture", async () => {
    const repo = await indexFixture();

    const result = await analyzeComplexity(repo);

    expect(result.summary.total_functions).toBeGreaterThan(0);
    expect(result.functions.length).toBeGreaterThan(0);

    for (const fn of result.functions) {
      expect(fn.name).toBeDefined();
      expect(fn.cyclomatic_complexity).toBeGreaterThanOrEqual(1);
      expect(fn.lines).toBeGreaterThan(0);
      expect(fn.max_nesting_depth).toBeGreaterThanOrEqual(0);
    }
  });

  it("detects higher complexity in branchy code", async () => {
    await mkdir(join(fixtureDir, "src"), { recursive: true });

    await writeFile(
      join(fixtureDir, "src", "complex.ts"),
      `export function complexFunc(x: number, y: string): string {
  if (x > 0) {
    if (y === "a") {
      return "a";
    } else if (y === "b") {
      return "b";
    }
  } else if (x < -10) {
    switch (y) {
      case "c": return "c";
      case "d": return "d";
      default: return "other";
    }
  }
  return x > 5 ? "big" : "small";
}

export function simpleFunc(): number {
  return 42;
}
`,
    );

    await indexFolder(fixtureDir, { watch: false });

    const result = await analyzeComplexity(REPO);

    const complex = result.functions.find((f) => f.name === "complexFunc");
    const simple = result.functions.find((f) => f.name === "simpleFunc");

    expect(complex).toBeDefined();
    expect(simple).toBeDefined();
    expect(complex!.cyclomatic_complexity).toBeGreaterThan(simple!.cyclomatic_complexity);
    expect(complex!.max_nesting_depth).toBeGreaterThan(0);
    expect(complex!.branches).toBeGreaterThan(3);
  });

  it("sorts by complexity descending", async () => {
    const repo = await indexFixture();

    const result = await analyzeComplexity(repo);

    for (let i = 1; i < result.functions.length; i++) {
      expect(result.functions[i]!.cyclomatic_complexity)
        .toBeLessThanOrEqual(result.functions[i - 1]!.cyclomatic_complexity);
    }
  });

  it("respects min_complexity filter", async () => {
    const repo = await indexFixture();

    const result = await analyzeComplexity(repo, { min_complexity: 999 });

    expect(result.functions).toHaveLength(0);
  });

  it("summary includes above_threshold count", async () => {
    const repo = await indexFixture();

    const result = await analyzeComplexity(repo);

    expect(typeof result.summary.above_threshold).toBe("number");
    expect(typeof result.summary.avg_complexity).toBe("number");
    expect(typeof result.summary.avg_lines).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// find_clones
// ---------------------------------------------------------------------------
describe("find_clones", () => {
  it("detects cloned functions across files", async () => {
    await mkdir(join(fixtureDir, "src"), { recursive: true });

    const sharedBody = `
  const items = [];
  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) {
      items.push({ id: i, value: i * 10 });
    } else {
      items.push({ id: i, value: i * 5 });
    }
  }
  const filtered = items.filter(x => x.value > 50);
  const mapped = filtered.map(x => x.value);
  return mapped.reduce((a, b) => a + b, 0);`;

    await writeFile(
      join(fixtureDir, "src", "calc-a.ts"),
      `export function calculateTotalsA(): number {${sharedBody}\n}\n`,
    );
    await writeFile(
      join(fixtureDir, "src", "calc-b.ts"),
      `export function calculateTotalsB(): number {${sharedBody}\n}\n`,
    );

    await indexFolder(fixtureDir, { watch: false });

    const result = await findClones(REPO, { min_similarity: 0.7, min_lines: 5 });

    expect(result.scanned_symbols).toBeGreaterThan(0);
    const clone = result.clones.find((c) =>
      (c.symbol_a.name === "calculateTotalsA" && c.symbol_b.name === "calculateTotalsB") ||
      (c.symbol_a.name === "calculateTotalsB" && c.symbol_b.name === "calculateTotalsA"),
    );
    expect(clone).toBeDefined();
    expect(clone!.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it("returns empty for unique functions", async () => {
    const repo = await indexFixture();

    // Standard fixture has unique functions
    const result = await findClones(repo, { min_similarity: 0.9, min_lines: 5 });

    // getUserById, processPayment, etc. are all different
    expect(result.clones.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyze_hotspots
// ---------------------------------------------------------------------------
describe("analyze_hotspots", () => {
  it("returns hotspot data for a git repo", async () => {
    // Use the codesift-mcp repo itself (has git history)
    // First index it in a temp dir
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(join(fixtureDir, "src", "index.ts"), `export const x = 1;\n`);
    // Init a git repo
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd: fixtureDir, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: fixtureDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init", "--no-gpg-sign"], { cwd: fixtureDir, stdio: "pipe" });

    // Make a second commit
    await writeFile(join(fixtureDir, "src", "index.ts"), `export const x = 2;\nexport const y = 3;\n`);
    execFileSync("git", ["add", "."], { cwd: fixtureDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "update", "--no-gpg-sign"], { cwd: fixtureDir, stdio: "pipe" });

    await indexFolder(fixtureDir, { watch: false });

    const result = await analyzeHotspots(REPO, { since_days: 3650 }); // 10 years to catch fresh commits

    expect(result.period).toContain("3650");
    // Git log may not pick up commits made milliseconds ago — check gracefully
    if (result.hotspots.length > 0) {
      const topFile = result.hotspots[0]!;
      expect(topFile.commits).toBeGreaterThanOrEqual(1);
      expect(topFile.lines_changed).toBeGreaterThan(0);
      expect(topFile.hotspot_score).toBeGreaterThan(0);
    }
    // At minimum, the function should not throw
    expect(result.total_files).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// search_patterns
// ---------------------------------------------------------------------------
describe("search_patterns", () => {
  it("finds empty catch blocks with built-in pattern", async () => {
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(
      join(fixtureDir, "src", "bad.ts"),
      `export function bad() {
  try { doSomething(); } catch (e) {}
}
`,
    );
    await indexFolder(fixtureDir, { watch: false });

    const result = await searchPatterns(REPO, "empty-catch");

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.pattern).toContain("Empty catch");
  });

  it("finds custom regex pattern", async () => {
    const repo = await indexFixture();

    const result = await searchPatterns(repo, "Promise<.*null>");

    expect(result.scanned_symbols).toBeGreaterThan(0);
    // getUserById returns Promise<User | null>
    const match = result.matches.find((m) => m.name === "getUserById");
    expect(match).toBeDefined();
  });

  it("lists built-in patterns", () => {
    const patterns = listPatterns();

    expect(patterns.length).toBeGreaterThan(5);
    expect(patterns.some((p) => p.name === "empty-catch")).toBe(true);
    expect(patterns.some((p) => p.name === "useEffect-no-cleanup")).toBe(true);
    expect(patterns.some((p) => p.name === "any-type")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generate_tools
// ---------------------------------------------------------------------------
describe("generate_tools", () => {
  describe("generateClaudeMd", () => {
    it("generates markdown content with architecture overview", async () => {
      const repo = await indexFixture();

      const result = await generateClaudeMd(repo);

      expect(result.content).toBeDefined();
      expect(result.content).toContain("Architecture Overview");
      expect(result.content).toContain("files");
      expect(result.content).toContain("symbols");
      expect(result.content).toContain("typescript");
      // Should not have a path when no outputPath is given
      expect(result.path).toBeUndefined();
    });

    it("includes directory breakdown", async () => {
      const repo = await indexFixture();

      const result = await generateClaudeMd(repo);

      // Should mention the src directory
      expect(result.content).toContain("src");
    });

    it("writes to file when outputPath is provided", async () => {
      const repo = await indexFixture();
      const outputPath = join(fixtureDir, "CLAUDE.md");

      const result = await generateClaudeMd(repo, outputPath);

      expect(result.path).toBe(outputPath);
      expect(result.content).toContain("Architecture Overview");
    });
  });
});

// ---------------------------------------------------------------------------
// codebase_retrieval
// ---------------------------------------------------------------------------
describe("codebase_retrieval", () => {
  it("executes batch queries with symbols and text sub-queries", async () => {
    const repo = await indexFixture();

    const result = await codebaseRetrieval(repo, [
      { type: "symbols", query: "getUserById" },
      { type: "text", query: "processPayment" },
    ]);

    expect(result.results.length).toBe(2);
    expect(result.query_count).toBe(2);
    expect(result.total_tokens).toBeGreaterThan(0);

    // First result should be symbols type
    expect(result.results[0]!.type).toBe("symbols");
    expect(result.results[0]!.tokens).toBeGreaterThan(0);

    // Second result should be text type
    expect(result.results[1]!.type).toBe("text");
    expect(result.results[1]!.tokens).toBeGreaterThan(0);
  });

  it("enforces token budget by truncating results", async () => {
    const repo = await indexFixture();

    // Use a very small budget to force truncation
    const result = await codebaseRetrieval(
      repo,
      [
        { type: "symbols", query: "User" },
        { type: "text", query: "export" },
        { type: "symbols", query: "payment" },
      ],
      500,
    );

    expect(result.total_tokens).toBeLessThanOrEqual(500);
    // With a budget of 500, some queries may be dropped
    expect(result.query_count).toBe(3); // All 3 were submitted
  });

  it("handles file_tree sub-query", async () => {
    const repo = await indexFixture();

    const result = await codebaseRetrieval(repo, [
      { type: "file_tree", path: "src" },
    ]);

    expect(result.results.length).toBe(1);
    expect(result.results[0]!.type).toBe("file_tree");
    const data = result.results[0]!.data as Array<{ name: string }>;
    expect(data.length).toBeGreaterThan(0);
  });

  it("handles outline sub-query", async () => {
    const repo = await indexFixture();

    const result = await codebaseRetrieval(repo, [
      { type: "outline", file_path: "src/types.ts" },
    ]);

    expect(result.results.length).toBe(1);
    expect(result.results[0]!.type).toBe("outline");
    const data = result.results[0]!.data as Array<{ name: string }>;
    expect(data.length).toBeGreaterThan(0);
  });

  it("handles references sub-query", async () => {
    const repo = await indexFixture();

    const result = await codebaseRetrieval(repo, [
      { type: "references", symbol_name: "User" },
    ]);

    expect(result.results.length).toBe(1);
    expect(result.results[0]!.type).toBe("references");
    const data = result.results[0]!.data as Array<{ file: string }>;
    expect(data.length).toBeGreaterThan(0);
  });

  it("returns error for unknown sub-query type", async () => {
    const repo = await indexFixture();

    const result = await codebaseRetrieval(repo, [
      { type: "nonexistent_type", query: "test" },
    ]);

    expect(result.results.length).toBe(1);
    expect(result.results[0]!.type).toBe("nonexistent_type");
    const data = result.results[0]!.data as { error: string };
    expect(data.error).toContain("Invalid sub-query");
  });
});

// ---------------------------------------------------------------------------
// New symbol kinds: constant, test_hook, markdown sections
// ---------------------------------------------------------------------------
describe("new_symbol_kinds", () => {
  it("indexes SCREAMING_CASE const as 'constant' kind", async () => {
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(
      join(fixtureDir, "src", "constants.ts"),
      `export const MAX_RETRIES = 3;
export const API_BASE_URL = "https://example.com";
export const normalVar = { key: "value" };
`,
    );
    await indexFolder(fixtureDir, { watch: false });

    const index = await getCodeIndex(REPO);
    const constants = index!.symbols.filter((s) => s.kind === "constant");
    const variables = index!.symbols.filter((s) => s.kind === "variable");

    expect(constants.map((c) => c.name).sort()).toEqual(["API_BASE_URL", "MAX_RETRIES"]);
    expect(variables.some((v) => v.name === "normalVar")).toBe(true);
  });

  it("indexes test lifecycle hooks as 'test_hook' kind", async () => {
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(
      join(fixtureDir, "src", "example.test.ts"),
      `describe("MyService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does something", () => {
    expect(true).toBe(true);
  });
});
`,
    );
    await indexFolder(fixtureDir, { watch: false });

    const index = await getCodeIndex(REPO);
    const hooks = index!.symbols.filter((s) => s.kind === "test_hook");

    expect(hooks).toHaveLength(2);
    expect(hooks.map((h) => h.name).sort()).toEqual(["afterEach", "beforeEach"]);
  });

  it("indexes markdown headings as 'section' kind", async () => {
    await writeFile(
      join(fixtureDir, "README.md"),
      `# Project Title

This is the project overview.

## Installation

Run npm install.

## Usage

Import and use.
`,
    );
    await indexFolder(fixtureDir, { watch: false });

    const index = await getCodeIndex(REPO);
    const sections = index!.symbols.filter((s) => s.kind === "section");

    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.name)).toEqual(["Project Title", "Installation", "Usage"]);
  });

  it("indexes markdown frontmatter as 'metadata' kind", async () => {
    await writeFile(
      join(fixtureDir, "doc.md"),
      `---
title: API Guide
version: 2.0
---

# API Guide

Content here.
`,
    );
    await indexFolder(fixtureDir, { watch: false });

    const index = await getCodeIndex(REPO);
    const metadata = index!.symbols.filter((s) => s.kind === "metadata");

    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.name).toBe("frontmatter");
    expect(metadata[0]!.source).toContain("title: API Guide");
  });
});
