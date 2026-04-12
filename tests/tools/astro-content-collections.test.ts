import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroContentCollections } from "../../src/tools/astro-content-collections.js";

beforeAll(async () => {
  await initParser();
});

/** Create a tmp project and run the tool against it. */
async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-cc-"));
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

describe("astro_content_collections", () => {
  // -------------------------------------------------------------------------
  // 1. Empty config (collections = {}) → summary.total_collections=0
  // -------------------------------------------------------------------------
  it("1. empty config → total_collections=0", async () => {
    const config = `
import { defineCollection, z } from "astro:content";

export const collections = {};
`;
    await withProject(
      { "src/content.config.ts": config },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.config_version).toBe("v5+");
        expect(result.config_file).toBe("src/content.config.ts");
        expect(result.summary.total_collections).toBe(0);
        expect(result.summary.total_entries).toBe(0);
        expect(result.collections).toEqual([]);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 2. Single collection with glob loader → entry count matches
  // -------------------------------------------------------------------------
  it("2. single collection with glob loader → entry count", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
  }),
});

export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/blog/first.md": "---\ntitle: First\n---\n\nHello",
        "src/content/blog/second.md": "---\ntitle: Second\n---\n\nWorld",
        "src/content/blog/draft.md": "---\ntitle: Draft\n---\n\nDraft",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.summary.total_collections).toBe(1);
        expect(result.collections[0]!.name).toBe("blog");
        expect(result.collections[0]!.loader).toBe("glob");
        expect(result.collections[0]!.loader_pattern).toBe("**/*.md");
        expect(result.collections[0]!.entry_count).toBe(3);
        expect(result.summary.total_entries).toBe(3);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 3. Collection with Zod schema → field types extracted
  // -------------------------------------------------------------------------
  it("3. Zod schema → fields extracted with types", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    pubDate: z.date(),
    tags: z.array(z.string()),
    draft: z.boolean().optional(),
  }),
});

export const collections = { blog };
`;
    await withProject(
      { "src/content.config.ts": config },
      async (root) => {
        const result = await astroContentCollections({
          project_root: root,
          validate_entries: false,
        });
        const blog = result.collections.find((c) => c.name === "blog");
        expect(blog).toBeDefined();
        const fields = blog!.schema_fields;
        const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

        expect(byName.title).toMatchObject({ type: "string", required: true });
        expect(byName.pubDate).toMatchObject({ type: "date", required: true });
        expect(byName.tags).toMatchObject({ type: "array", required: true });
        expect(byName.draft).toMatchObject({ type: "boolean", required: false });
      },
    );
  });

  // -------------------------------------------------------------------------
  // 4. reference("authors") appears in reference_graph
  // -------------------------------------------------------------------------
  it("4. reference('authors') → appears in reference_graph", async () => {
    const config = `
import { defineCollection, z, reference } from "astro:content";
import { glob } from "astro/loaders";

const authors = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/authors" }),
  schema: z.object({
    name: z.string(),
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    author: reference("authors"),
  }),
});

export const collections = { blog, authors };
`;
    await withProject(
      { "src/content.config.ts": config },
      async (root) => {
        const result = await astroContentCollections({
          project_root: root,
          validate_entries: false,
        });
        expect(result.reference_graph["blog.author"]).toBeDefined();
        expect(result.reference_graph["blog.author"]).toEqual({
          field: "author",
          cardinality: "one-to-one",
        });

        const blog = result.collections.find((c) => c.name === "blog")!;
        expect(blog.references).toContain("authors");

        const authors = result.collections.find((c) => c.name === "authors")!;
        expect(authors.referenced_by).toContain("blog");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 5. Missing required field in entry → validation error
  // -------------------------------------------------------------------------
  it("5. missing required field → validation_issues has error", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    author: z.string(),
  }),
});

export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        // Missing 'author' field
        "src/content/blog/bad.md": "---\ntitle: Bad Post\n---\n\nContent",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.validation_issues.length).toBeGreaterThan(0);
        const issue = result.validation_issues.find(
          (i) => i.field === "author" && i.file.endsWith("bad.md"),
        );
        expect(issue).toBeDefined();
        expect(issue!.severity).toBe("error");
        expect(issue!.collection).toBe("blog");
        expect(result.summary.collections_with_issues).toBe(1);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 6. Optional field missing → no issue
  // -------------------------------------------------------------------------
  it("6. optional field missing → no validation issue", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    draft: z.boolean().optional(),
  }),
});

export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        // No draft field, but it is optional
        "src/content/blog/ok.md": "---\ntitle: OK Post\n---\n\nContent",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.validation_issues).toEqual([]);
        expect(result.summary.collections_with_issues).toBe(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 7. Legacy config at src/content/config.ts → config_version: "legacy"
  // -------------------------------------------------------------------------
  it("7. legacy config path → config_version: 'legacy'", async () => {
    const config = `
import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
  }),
});

export const collections = { blog };
`;
    await withProject(
      { "src/content/config.ts": config },
      async (root) => {
        const result = await astroContentCollections({
          project_root: root,
          validate_entries: false,
        });
        expect(result.config_version).toBe("legacy");
        expect(result.config_file).toBe("src/content/config.ts");
        expect(result.collections.find((c) => c.name === "blog")).toBeDefined();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 8. Missing config → config_file: null, config_version: "not-found"
  // -------------------------------------------------------------------------
  it("8. missing config → config_file null + not-found", async () => {
    await withProject({}, async (root) => {
      const result = await astroContentCollections({ project_root: root });
      expect(result.config_file).toBeNull();
      expect(result.config_version).toBe("not-found");
      expect(result.collections).toEqual([]);
      expect(result.summary.total_collections).toBe(0);
    });
  });
});
