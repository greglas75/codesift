/**
 * `detectRepoFrameworks` / `resolveRepoHonoEntryFile` on a REAL index (ADR-004 stage 2).
 *
 * The Hono tools, nest_audit and the cross-repo resolver used to load the whole index to answer
 * these two questions. The narrow path must give the same answer as the old one — same frameworks,
 * same first `new Hono(` symbol — so the narrow reads run FIRST, while nothing is resident, and are
 * then compared with the old functions applied to the full index.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config.js";
import { getCodeIndex, indexFolder } from "../../src/tools/index-tools.js";
import { detectRepoFrameworks, resolveRepoHonoEntryFile } from "../../src/tools/framework-detect-repo.js";
import { resolveHonoEntryFile } from "../../src/tools/hono-entry-resolver.js";
import { detectFrameworks } from "../../src/utils/framework-detect.js";

const FILES: Record<string, string> = {
  "src/a-utils.ts": `export function add(a: number, b: number): number {
  return a + b;
}
`,
  "src/server.ts": `import { Hono } from "hono";

export function buildApp() {
  const app = new Hono();
  app.get("/health", (c) => c.text("ok"));
  return app;
}
`,
  "src/second.ts": `import { Hono } from "hono";

export function buildOther() {
  return new Hono();
}
`,
  "src/main.kt": `fun main() {}
`,
};

let tmpDir = "";
let projDir = "";
let repo = "";

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-fw-detect-repo-"));
  projDir = join(tmpDir, "fw-detect-project");
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  for (const [rel, content] of Object.entries(FILES)) {
    const full = join(projDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  repo = (await indexFolder(projDir, { watch: false })).repo;
}, 60_000);

afterAll(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("detectRepoFrameworks", () => {
  it("matches detectFrameworks on the full index, and the first Hono symbol matches too", async () => {
    // Narrow first: indexFolder leaves nothing resident, so these are served by the database.
    const scan = await detectRepoFrameworks(repo);
    expect(scan).not.toBeNull();
    const entry = await resolveRepoHonoEntryFile(repo, scan!.root);

    const index = await getCodeIndex(repo);
    expect(index).not.toBeNull();
    expect([...scan!.frameworks].sort()).toEqual([...detectFrameworks(index!)].sort());
    expect(scan!.frameworks.has("hono")).toBe(true);
    expect(scan!.frameworks.has("kotlin-android")).toBe(true);
    expect(entry).toBe(resolveHonoEntryFile(index!));
    // Index order is the parser pool's completion order, not alphabetical — so which of the two
    // Hono files is "first" is not fixed; that both paths agree on it is the property that matters.
    expect([join(projDir, "src/server.ts"), join(projDir, "src/second.ts")]).toContain(entry);
  });

  it("returns null for a repo that is not indexed", async () => {
    expect(await detectRepoFrameworks("local/no-such-repo")).toBeNull();
  });
});
