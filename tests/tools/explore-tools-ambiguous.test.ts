import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Only the batch lookup is made to collide; single-id lookups run for real. That is the shape the
// index produces for colliding ids in generated code, where getSymbols refuses the whole batch.
vi.mock("../../src/tools/symbol-lookup-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/symbol-lookup-tools.js")>();
  return {
    ...actual,
    getSymbols: vi.fn(async (repo: string, ids: string[]) => {
      if (ids.length > 1 || ids.some((id) => id.includes("collides"))) {
        throw new actual.AmbiguousSymbolIdError("ambiguous for test");
      }
      return actual.getSymbols(repo, ids);
    }),
  };
});

const { indexFolder } = await import("../../src/tools/index-tools.js");
const { explore } = await import("../../src/tools/explore-tools.js");
const { resetConfigCache } = await import("../../src/config.js");

let tmpDir: string;
let savedEmbeddings: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-explore-amb-"));
  const root = join(tmpDir, "explore-amb");
  await mkdir(join(root, "src"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  savedEmbeddings = process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "true";
  resetConfigCache();
  await writeFile(join(root, "src", "a.ts"), "export function parseOrder(): number {\n  return 1;\n}\n");
  await writeFile(join(root, "src", "collides.ts"), "export function parseOrderLine(): number {\n  return 2;\n}\n");
  await indexFolder(root);
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  if (savedEmbeddings === undefined) delete process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  else process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = savedEmbeddings;
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("explore with an ambiguous top hit", () => {
  it("renders the resolvable hits and lists the ambiguous one instead of failing", async () => {
    const out = await explore("local/explore-amb", "parseOrder", { top: 2 });
    expect(out).toContain("function parseOrder");
    expect(out).toContain("return 1;");
    expect(out).toMatch(/--- other matches \(\d+\) ---[\s\S]*src\/collides\.ts:1 function parseOrderLine/);
  });
});
