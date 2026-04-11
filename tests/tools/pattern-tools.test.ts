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

describe("nextjs-fetch-waterfall", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-fetch-waterfall"]!;

  it("matches sequential await fetch calls", () => {
    const source = `async function getData() {
  const a = await fetch('/api/users');
  const b = await fetch('/api/posts');
  return { a, b };
}`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("does not match single fetch call", () => {
    const source = `async function getData() {
  const a = await fetch('/api/users');
  return a;
}`;
    expect(pattern.regex.test(source)).toBe(false);
  });
});

describe("nextjs-unnecessary-use-client", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-unnecessary-use-client"]!;

  it("matches file with use client but no hooks or events", () => {
    const source = `"use client";
export function Plain({ message }) {
  return <div>{message}</div>;
}`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("does not match file with use client and useState", () => {
    const source = `"use client";
import { useState } from "react";
export function Btn() {
  const [c, setC] = useState(0);
  return <button onClick={() => setC(c+1)}>{c}</button>;
}`;
    expect(pattern.regex.test(source)).toBe(false);
  });
});

describe("nextjs-pages-in-app", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-pages-in-app"]!;

  it("matches index.tsx inside app/ directory", () => {
    expect(pattern.fileIncludePattern!.test("app/index.tsx")).toBe(true);
    expect(pattern.fileIncludePattern!.test("app/users/index.tsx")).toBe(true);
  });

  it("does not match page.tsx inside app/ directory", () => {
    expect(pattern.fileIncludePattern!.test("app/page.tsx")).toBe(false);
    expect(pattern.fileIncludePattern!.test("app/users/page.tsx")).toBe(false);
  });
});

describe("nextjs-missing-error-boundary", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-missing-error-boundary"]!;

  it("pattern exists with correct description", () => {
    expect(pattern.description).toContain("error");
  });

  it("fileIncludePattern matches page files in app/", () => {
    expect(pattern.fileIncludePattern!.test("app/products/page.tsx")).toBe(true);
  });
});

describe("nextjs-use-client-in-layout", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-use-client-in-layout"]!;

  it("matches layout file with use client", () => {
    const source = `"use client";
export default function Layout({ children }) {
  return <div>{children}</div>;
}`;
    expect(pattern.regex.test(source)).toBe(true);
  });

  it("does not match layout file without directive", () => {
    const source = `export default function Layout({ children }) {
  return <div>{children}</div>;
}`;
    expect(pattern.regex.test(source)).toBe(false);
  });
});

describe("nextjs-missing-metadata", () => {
  const pattern = BUILTIN_PATTERNS["nextjs-missing-metadata"]!;

  it("pattern exists with correct description", () => {
    expect(pattern.description).toContain("metadata");
  });

  it("fileIncludePattern matches page files in app/", () => {
    expect(pattern.fileIncludePattern!.test("app/about/page.tsx")).toBe(true);
  });
});
