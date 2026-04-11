import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanDirective } from "../../src/utils/nextjs.js";

let tmpDir: string;

async function createFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-nextjs-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(tmpDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("scanDirective", () => {
  it("detects 'use client' at top of file", async () => {
    const root = await createFixture({
      "Component.tsx": `"use client";\nimport React from "react";\n`,
    });
    expect(await scanDirective(join(root, "Component.tsx"))).toBe("use client");
  });

  it("detects 'use server' at top of file", async () => {
    const root = await createFixture({
      "action.ts": `"use server";\nexport async function save() {}\n`,
    });
    expect(await scanDirective(join(root, "action.ts"))).toBe("use server");
  });

  it("detects directive after BOM prefix", async () => {
    const root = await createFixture({
      "BomFile.tsx": `\uFEFF"use client";\nimport React from "react";\n`,
    });
    expect(await scanDirective(join(root, "BomFile.tsx"))).toBe("use client");
  });

  it("detects directive after multi-line docblock comment", async () => {
    const root = await createFixture({
      "Docblock.tsx": `/* copyright 2024 */\n"use client";\n`,
    });
    expect(await scanDirective(join(root, "Docblock.tsx"))).toBe("use client");
  });

  it("detects directive after single-line comment", async () => {
    const root = await createFixture({
      "LineComment.tsx": `// some comment\n"use client";\n`,
    });
    expect(await scanDirective(join(root, "LineComment.tsx"))).toBe("use client");
  });

  it("detects directive after shebang", async () => {
    const root = await createFixture({
      "Shebang.tsx": `#!/usr/bin/env node\n"use client";\n`,
    });
    expect(await scanDirective(join(root, "Shebang.tsx"))).toBe("use client");
  });

  it("returns null when no directive present", async () => {
    const root = await createFixture({
      "Plain.tsx": `import React from "react";\nexport default function App() { return <div/>; }\n`,
    });
    expect(await scanDirective(join(root, "Plain.tsx"))).toBe(null);
  });

  it("returns null when directive is past 512-byte offset", async () => {
    const padding = "// " + "x".repeat(600) + "\n";
    const root = await createFixture({
      "FarDirective.tsx": padding + `"use client";\n`,
    });
    expect(await scanDirective(join(root, "FarDirective.tsx"))).toBe(null);
  });
});
