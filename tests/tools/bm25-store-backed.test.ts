// The native code BM25 index is store-backed (ADR-006 stage 9): it holds no symbols, and hits are read
// from the store by id. Holding every symbol cost a 1.43M-symbol index 4.1 s to load and 2.4 GB of
// heap per cached index that no budget counted.
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBM25Index, indexFile, indexFolder } from "../../src/tools/index-tools.js";
import { searchSymbols } from "../../src/tools/search-tools.js";
import { isNativeBM25 } from "../../src/search/bm25.js";
import { getNativeCore } from "../../src/native/index.js";
import { resetConfigCache } from "../../src/config.js";

const REPO = "local/bm25-store-backed";
let tmpDir: string;
let root: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cs-bm25-store-"));
  root = join(tmpDir, "bm25-store-backed");
  await mkdir(join(root, "src"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  await writeFile(join(root, "src", "users.ts"), "export function createUser(name: string) { return { name }; }\n");
  await writeFile(join(root, "src", "orders.ts"), "export function placeOrder(id: number) { return id; }\n");
  await indexFolder(root, { watch: false });
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!getNativeCore("bm25"))("store-backed native BM25", () => {
  // Bug it catches: the whole symbol set loaded back into the cached index.
  it("keeps no symbols of its own", async () => {
    const index = await getBM25Index(REPO);
    expect(index && isNativeBM25(index) && index.resolve !== undefined).toBe(true);
    expect(index!.symbols.size).toBe(0);
  });

  it("finds symbols, with their source, through the store", async () => {
    const [hit] = await searchSymbols(REPO, "createUser", { include_source: true, top_k: 3 });
    expect(hit?.symbol.name).toBe("createUser");
    expect(hit?.symbol.source).toContain("return { name }");
  });

  // Bug it catches: an edit updating the postings but the hit read from a stale copy, or not at all.
  it("answers from an edited file after index_file", async () => {
    await searchSymbols(REPO, "createUser", { top_k: 1 }); // build and cache
    await writeFile(join(root, "src", "users.ts"), "export function archiveUser(id: string) { return id; }\n");
    await indexFile(join(root, "src", "users.ts"));
    const names = (await searchSymbols(REPO, "archiveUser", { top_k: 3 })).map((r) => r.symbol.name);
    expect(names).toContain("archiveUser");
    const stale = (await searchSymbols(REPO, "createUser", { top_k: 3 })).map((r) => r.symbol.name);
    expect(stale).not.toContain("createUser");
  });

  it("lists symbols for an empty query", async () => {
    const names = (await searchSymbols(REPO, "", { top_k: 10 })).map((r) => r.symbol.name).sort();
    expect(names).toEqual(["createUser", "placeOrder"]);
  });
});
