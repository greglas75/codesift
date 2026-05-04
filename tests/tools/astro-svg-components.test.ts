import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroSvgComponents } from "../../src/tools/astro-svg-components.js";

beforeAll(async () => {
  await initParser();
});

async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-svg-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content, "utf-8");
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("astro_svg_components", () => {
  it("detects ?component imports and usages", async () => {
    const page = `---
import Logo from "../assets/logo.svg?component";
import Unused from "../assets/u.svg?component";
---
<Logo class="hero" />
`;
    await withProject(
      { "src/pages/index.astro": page },
      async (root) => {
        const result = await astroSvgComponents({ project_root: root });
        expect(result.imports.length).toBe(2);
        const used = result.imports.find((i) => i.name === "Logo");
        const unused = result.imports.find((i) => i.name === "Unused");
        expect(used?.used).toBe(true);
        expect(unused?.used).toBe(false);
        expect(result.unused).toContain("Unused");
        expect(result.issues.some((i) => i.code === "SV01" && i.import_name === "Unused")).toBe(true);
      },
    );
  });

  it("project with no SVG imports → empty result", async () => {
    await withProject(
      { "src/pages/x.astro": `---\nconst x = 1;\n---\n<p/>` },
      async (root) => {
        const result = await astroSvgComponents({ project_root: root });
        expect(result.imports).toEqual([]);
        expect(result.issues).toEqual([]);
      },
    );
  });

  it("Astro 5 native SVG import (without ?component) flagged as SV02 if package.json indicates Astro 5+", async () => {
    const page = `---
import Logo from "../assets/logo.svg?component";
---
<Logo />
`;
    const pkg = JSON.stringify({ dependencies: { astro: "^5.0.0" } });
    await withProject(
      { "src/pages/p.astro": page, "package.json": pkg },
      async (root) => {
        const result = await astroSvgComponents({ project_root: root });
        // SV02 flags ?component imports as legacy when Astro 5+ is detected
        expect(result.issues.some((i) => i.code === "SV02")).toBe(true);
      },
    );
  });

  it("Astro 4 (?component is the supported pattern) → no SV02", async () => {
    const page = `---
import Logo from "../assets/logo.svg?component";
---
<Logo />
`;
    const pkg = JSON.stringify({ dependencies: { astro: "^4.16.0" } });
    await withProject(
      { "src/pages/p.astro": page, "package.json": pkg },
      async (root) => {
        const result = await astroSvgComponents({ project_root: root });
        expect(result.issues.some((i) => i.code === "SV02")).toBe(false);
      },
    );
  });

  it("does NOT cross-credit imports across files (Logo used in A must NOT mask unused Logo in B)", async () => {
    // Adversarial CRITICAL regression — file-scoped usage tracking.
    const a = `---
import Logo from "./logo.svg?component";
---
<Logo />
`;
    const b = `---
import Logo from "./logo.svg?component";
---
<p>no logo here</p>
`;
    await withProject(
      { "src/pages/a.astro": a, "src/pages/b.astro": b },
      async (root) => {
        const result = await astroSvgComponents({ project_root: root });
        const aRecord = result.imports.find((i) => i.file === "src/pages/a.astro");
        const bRecord = result.imports.find((i) => i.file === "src/pages/b.astro");
        expect(aRecord?.used).toBe(true);
        expect(bRecord?.used).toBe(false);
        // SV01 emitted only for the b.astro instance
        const sv01 = result.issues.filter((i) => i.code === "SV01");
        expect(sv01.length).toBe(1);
        expect(sv01[0]?.file).toBe("src/pages/b.astro");
      },
    );
  });

  it("multiple .svg?component imports, all used → no issues", async () => {
    const page = `---
import A from "./a.svg?component";
import B from "./b.svg?component";
---
<A />
<B class="x" />
`;
    await withProject(
      { "src/pages/p.astro": page },
      async (root) => {
        const result = await astroSvgComponents({ project_root: root });
        expect(result.imports.length).toBe(2);
        expect(result.unused).toEqual([]);
        expect(result.issues.some((i) => i.code === "SV01")).toBe(false);
      },
    );
  });
});
