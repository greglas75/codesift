import { describe, it, expect, afterEach } from "vitest";
import { BUILTIN_PATTERNS, listPatterns, searchPatterns } from "../../src/tools/pattern-tools.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createIndexedFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-pattern-test-"));
  const projDir = join(tmpDir, "test-project");
  await mkdir(projDir, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(projDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  await indexFolder(projDir, { watch: false });
  return "local/test-project";
}

describe("nextjs-wrong-router", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-wrong-router"]!;

  it("regex matches next/router import", () => {
    const source = `import { useRouter } from "next/router";`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("regex does not match next/navigation import", () => {
    const source = `import { useRouter } from "next/navigation";`;
    expect(pattern.regex.test(source)).toBe(false);
  });

  it("fileExcludePattern suppresses pages/ files", () => {
    expect(pattern.fileExcludePattern!.test("pages/index.tsx")).toBe(true);
    expect(pattern.fileExcludePattern!.test("pages/api/users.ts")).toBe(true);
  });

  it("fileExcludePattern does not suppress app/ files", () => {
    expect(pattern.fileExcludePattern!.test("app/page.tsx")).toBe(false);
    expect(pattern.fileExcludePattern!.test("app/components/Nav.tsx")).toBe(false);
  });

  it("suppressed on pages/ files in searchPatterns", async () => {
    const repo = await createIndexedFixture({
      // The source needs the import inline to be part of a symbol
      "pages/index.tsx": `export default function Home() {
  // Using wrong: from "next/router" import
  const source = 'from "next/router"';
  return null;
}`,
    });
    const result = await searchPatterns(repo, "nextjs-wrong-router");
    expect(result.matches).toHaveLength(0);
  });

  it("matches in app/ files in searchPatterns", async () => {
    const repo = await createIndexedFixture({
      "app/page.tsx": `export default function Home() {
  // Using wrong: from "next/router" import
  const source = 'from "next/router"';
  return null;
}`,
    });
    const result = await searchPatterns(repo, "nextjs-wrong-router");
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });
});
