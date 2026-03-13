import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder, listAllRepos, invalidateCache, getCodeIndex, getBM25Index } from "../../src/tools/index-tools.js";
import { searchBM25 } from "../../src/search/bm25.js";

const FIELD_WEIGHTS = { name: 3.0, signature: 2.0, docstring: 1.5, body: 1.0 };

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-test-"));
  fixtureDir = join(tmpDir, "test-project");
  await mkdir(fixtureDir, { recursive: true });

  // Set data dir to temp so we don't pollute real ~/.codesift
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  await rm(tmpDir, { recursive: true, force: true });
});

async function createFixtureProject(): Promise<void> {
  await mkdir(join(fixtureDir, "src"), { recursive: true });

  await writeFile(
    join(fixtureDir, "src", "user-service.ts"),
    `/**
 * Fetches a user by their unique identifier.
 */
export async function getUserById(id: string): Promise<User | null> {
  return db.user.findUnique({ where: { id } });
}

export const createUser = async (data: CreateUserInput): Promise<User> => {
  return db.user.create({ data });
};

interface User {
  id: string;
  name: string;
  email: string;
}

export class UserService {
  async findById(id: string): Promise<User | null> {
    return getUserById(id);
  }
}
`,
  );

  await writeFile(
    join(fixtureDir, "src", "payment.ts"),
    `export function processPayment(amount: number): PaymentResult {
  return { success: true, amount };
}

export function validateCard(cardNumber: string): boolean {
  return cardNumber.length === 16;
}

type PaymentResult = { success: boolean; amount: number };
`,
  );
}

describe("index_folder integration", () => {
  it("indexes a TypeScript project end-to-end", async () => {
    await createFixtureProject();

    const result = await indexFolder(fixtureDir, { watch: false });

    expect(result.repo).toBe("local/test-project");
    expect(result.root).toBe(fixtureDir);
    expect(result.file_count).toBe(2);
    expect(result.symbol_count).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  it("extracts expected symbols from TypeScript files", async () => {
    await createFixtureProject();
    await indexFolder(fixtureDir, { watch: false });

    const index = await getCodeIndex("local/test-project");
    expect(index).not.toBeNull();

    const symbolNames = index!.symbols.map((s) => s.name);

    // Functions
    expect(symbolNames).toContain("getUserById");
    expect(symbolNames).toContain("createUser");
    expect(symbolNames).toContain("processPayment");
    expect(symbolNames).toContain("validateCard");

    // Class and method
    expect(symbolNames).toContain("UserService");
    expect(symbolNames).toContain("findById");

    // Interface
    expect(symbolNames).toContain("User");

    // Type
    expect(symbolNames).toContain("PaymentResult");
  });

  it("builds a searchable BM25 index", async () => {
    await createFixtureProject();
    await indexFolder(fixtureDir, { watch: false });

    const bm25 = await getBM25Index("local/test-project");
    expect(bm25).not.toBeNull();
    expect(bm25!.docCount).toBeGreaterThan(0);

    // Search for a symbol by name
    const results = searchBM25(bm25!, "getUserById", 5, FIELD_WEIGHTS);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.symbol.name).toBe("getUserById");
  });

  it("search finds symbols by partial name", async () => {
    await createFixtureProject();
    await indexFolder(fixtureDir, { watch: false });

    const bm25 = await getBM25Index("local/test-project");
    expect(bm25).not.toBeNull();

    // "payment" should match processPayment
    const results = searchBM25(bm25!, "payment", 5, FIELD_WEIGHTS);
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.symbol.name);
    expect(names).toContain("processPayment");
  });

  it("registers repo in the registry", async () => {
    await createFixtureProject();
    await indexFolder(fixtureDir, { watch: false });

    const repos = await listAllRepos();
    expect(repos.length).toBeGreaterThan(0);
    expect(repos.some((r) => r.name === "local/test-project")).toBe(true);
  });

  it("invalidateCache removes the index", async () => {
    await createFixtureProject();
    await indexFolder(fixtureDir, { watch: false });

    const removed = await invalidateCache("local/test-project");
    expect(removed).toBe(true);

    const repos = await listAllRepos();
    expect(repos.some((r) => r.name === "local/test-project")).toBe(false);

    const bm25 = await getBM25Index("local/test-project");
    expect(bm25).toBeNull();
  });

  it("handles empty directory gracefully", async () => {
    const result = await indexFolder(fixtureDir, { watch: false });

    expect(result.file_count).toBe(0);
    expect(result.symbol_count).toBe(0);
  });

  it("respects include_paths filter", async () => {
    await createFixtureProject();

    // Also create a file outside src/
    await writeFile(
      join(fixtureDir, "scripts.ts"),
      `export function buildStuff(): void {}`,
    );

    const result = await indexFolder(fixtureDir, { include_paths: ["src"], watch: false });

    // Should only index files under src/
    expect(result.file_count).toBe(2);
    const index = await getCodeIndex("local/test-project");
    const files = index!.files.map((f) => f.path);
    expect(files.every((f) => f.startsWith("src/"))).toBe(true);
  });
});
