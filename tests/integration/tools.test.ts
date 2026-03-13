import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder, getCodeIndex } from "../../src/tools/index-tools.js";
import { searchSymbols, searchText } from "../../src/tools/search-tools.js";
import { getFileTree, getFileOutline, getRepoOutline } from "../../src/tools/outline-tools.js";
import { getSymbol, getSymbols, findAndShow, findReferences } from "../../src/tools/symbol-tools.js";
import { assembleContext } from "../../src/tools/context-tools.js";
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
      const outputPath = join(tmpDir, "CLAUDE.md");

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
    expect(data.error).toContain("Unknown sub-query type");
  });
});
