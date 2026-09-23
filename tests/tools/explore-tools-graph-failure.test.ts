import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The call graph is the only part mocked: search and symbol lookup run for real, so the test
// exercises explore's handling of a failed neighbour lookup and nothing else.
vi.mock("../../src/tools/graph-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/graph-tools.js")>();
  return { ...actual, callNeighbours: vi.fn(async () => { throw new Error("adjacency build failed"); }) };
});

const { indexFolder } = await import("../../src/tools/index-tools.js");
const { explore } = await import("../../src/tools/explore-tools.js");
const { resetConfigCache } = await import("../../src/config.js");

let tmpDir: string;
let savedEmbeddings: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-explore-fail-"));
  const root = join(tmpDir, "explore-fail");
  await mkdir(join(root, "src"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  savedEmbeddings = process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "true";
  resetConfigCache();
  await writeFile(join(root, "src", "a.ts"), "export function onlyThing(): number {\n  return 1;\n}\n");
  await indexFolder(root);
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  if (savedEmbeddings === undefined) delete process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  else process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = savedEmbeddings;
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("explore when the call graph fails", () => {
  // "No callers" and "could not compute callers" call for opposite conclusions; the second must
  // never be rendered as the first.
  it("says the graph is unavailable instead of reporting no callers", async () => {
    const out = await explore("local/explore-fail", "onlyThing", { top: 1 });
    expect(out).toContain("function onlyThing");
    expect(out).toContain("call graph unavailable: adjacency build failed");
    expect(out).not.toContain("no direct callers or callees");
  });
});
