import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroImageAudit } from "../../src/tools/astro-image-audit.js";

beforeAll(async () => {
  await initParser();
});

async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-img-"));
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

describe("astro_image_audit", () => {
  it("counts raw <img>, <Image>, missing alt, empty alt", async () => {
    const page = `---
import { Image } from "astro:assets";
---
<img src="/a.png">
<Image src="/x.png" alt="hi" />
<img src="/b.png" alt="" />
<img src="/c.png" alt="proper alt" />
`;
    await withProject(
      { "src/pages/index.astro": page },
      async (root) => {
        const result = await astroImageAudit({ project_root: root });
        expect(result.raw_img_count).toBe(3);
        expect(result.image_component_count).toBe(1);
        expect(result.missing_alt.length).toBe(1);
        expect(result.empty_alt.length).toBe(1);
        expect(result.issues.some((i) => i.code === "IM01")).toBe(true);
        expect(result.issues.some((i) => i.code === "IM02")).toBe(true);
        expect(result.issues.some((i) => i.code === "IM03")).toBe(true);
      },
    );
  });

  it("does NOT count <img> inside <script> blocks (pathological case)", async () => {
    const page = `---
---
<img src="/a.png" alt="real" />
<script>
  const html = '<img src="/fake.png">';
</script>
`;
    await withProject(
      { "src/pages/p.astro": page },
      async (root) => {
        const result = await astroImageAudit({ project_root: root });
        expect(result.raw_img_count).toBe(1);
      },
    );
  });

  it("does NOT count <img> inside HTML comments", async () => {
    const page = `---
---
<!-- <img src="/commented.png"> -->
<img src="/real.png" alt="hi" />
`;
    await withProject(
      { "src/pages/p.astro": page },
      async (root) => {
        const result = await astroImageAudit({ project_root: root });
        expect(result.raw_img_count).toBe(1);
      },
    );
  });

  it("project with no images → empty result, no issues", async () => {
    await withProject(
      { "src/pages/x.astro": `---\n---\n<p>hello</p>\n` },
      async (root) => {
        const result = await astroImageAudit({ project_root: root });
        expect(result.raw_img_count).toBe(0);
        expect(result.image_component_count).toBe(0);
        expect(result.issues).toEqual([]);
      },
    );
  });

  it("flags missing astro:assets import when getImage() is used (IM04)", async () => {
    const page = `---
const opt = await getImage({ src: "/a.png", width: 800 });
---
<img src={opt.src} alt="x" />
`;
    await withProject(
      { "src/pages/p.astro": page },
      async (root) => {
        const result = await astroImageAudit({ project_root: root });
        expect(result.issues.some((i) => i.code === "IM04")).toBe(true);
      },
    );
  });

  it("preserves accurate line numbers when scripts/comments precede images", async () => {
    // Adversarial CRITICAL regression: stripping must not collapse line offsets.
    const page = `---
---
<!-- some comment
spanning lines -->
<script>
  console.log("noise");
  const x = 1;
</script>
<img src="/late.png">
`;
    await withProject(
      { "src/pages/p.astro": page },
      async (root) => {
        const result = await astroImageAudit({ project_root: root });
        expect(result.missing_alt.length).toBe(1);
        // The img is on line 9 of the file (1: ---, 2: ---, 3-4: comment, 5-8: script, 9: img)
        expect(result.missing_alt[0]?.line).toBeGreaterThanOrEqual(8);
      },
    );
  });

  it("getImage() WITH astro:assets import → no IM04", async () => {
    const page = `---
import { getImage } from "astro:assets";
const opt = await getImage({ src: "/a.png", width: 800 });
---
<img src={opt.src} alt="x" />
`;
    await withProject(
      { "src/pages/p.astro": page },
      async (root) => {
        const result = await astroImageAudit({ project_root: root });
        expect(result.issues.some((i) => i.code === "IM04")).toBe(false);
      },
    );
  });
});
