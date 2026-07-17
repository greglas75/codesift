import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import * as parserManager from "../../src/parser/parser-manager.js";
import { astroContentCollections } from "../../src/tools/astro-content-collections.js";
import * as indexTools from "../../src/tools/index-tools.js";

beforeAll(async () => {
  await initParser();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("9. direct collection export falls back to the discovered local definition", async () => {
    const config = `
import { defineCollection, z } from "astro:content";

export const blog = defineCollection({
  type: "content",
  schema: z.object({ title: z.string() }),
});
`;
    await withProject(
      { "src/content.config.ts": config },
      async (root) => {
        const result = await astroContentCollections({
          project_root: root,
          validate_entries: false,
        });
        expect(result.collections).toEqual([
          expect.objectContaining({
            name: "blog",
            loader: "glob",
            schema_fields: [
              expect.objectContaining({ name: "title", type: "string", required: true }),
            ],
          }),
        ]);
      },
    );
  });

  it("10. file loader validates JSON entries against required schema fields", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";

const authors = defineCollection({
  loader: file("src/content/authors.json"),
  schema: z.object({ name: z.string() }),
});

export const collections = { authors };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/authors.json": JSON.stringify({ slug: "ada" }),
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]).toMatchObject({
          name: "authors",
          loader: "file",
          loader_pattern: "src/content/authors.json",
          entry_count: 1,
        });
        expect(result.validation_issues).toEqual([
          {
            collection: "authors",
            file: "src/content/authors.json",
            field: "name",
            message: "Missing required field 'name' (string)",
            severity: "error",
          },
        ]);
      },
    );
  });

  it("11. content without frontmatter is reported as an orphaned file", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({ title: z.string() }),
});

export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/blog/no-frontmatter.md": "Plain markdown",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.orphaned_files).toEqual(["src/content/blog/no-frontmatter.md"]);
        expect(result.validation_issues).toEqual([]);
        expect(result.collections[0]!.entry_count).toBe(0);
      },
    );
  });

  it("12. glob loaders count only files matching their pattern", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({ title: z.string() }),
});

export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/blog/post.md": "---\ntitle: Post\n---\n",
        "src/content/blog/metadata.json": JSON.stringify({ title: "Metadata" }),
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]!.entry_count).toBe(1);
        expect(result.summary.total_entries).toBe(1);
      },
    );
  });

  it("13. file loaders inspect only the configured file", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";

const authors = defineCollection({
  loader: file("src/content/authors.json"),
  schema: z.object({ name: z.string() }),
});

export const collections = { authors };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/authors.json": JSON.stringify({ name: "Ada" }),
        "src/content/unrelated.json": JSON.stringify({ slug: "wrong collection" }),
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]!.entry_count).toBe(1);
        expect(result.validation_issues).toEqual([]);
      },
    );
  });

  it("14. loader bases outside the project are not traversed", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "astro-cc-outside-"));
    try {
      await writeFile(
        join(outsideRoot, "external.md"),
        "---\ntitle: External\n---\n",
        "utf-8",
      );
      const config = `
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: ${JSON.stringify(outsideRoot)} }),
  schema: z.object({ title: z.string() }),
});

export const collections = { blog };
`;
      await withProject(
        { "src/content.config.ts": config },
        async (root) => {
          const result = await astroContentCollections({ project_root: root });
          expect(result.collections[0]!.entry_count).toBe(0);
          expect(result.summary.total_entries).toBe(0);
        },
      );
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("15. malformed JSON entries produce a validation diagnostic", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";

const authors = defineCollection({
  loader: file("src/content/authors.json"),
  schema: z.object({ name: z.string() }),
});

export const collections = { authors };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/authors.json": "{ invalid json",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.validation_issues).toEqual([
          {
            collection: "authors",
            file: "src/content/authors.json",
            field: "$",
            message: "Invalid JSON content entry",
            severity: "error",
          },
        ]);
        expect(result.collections[0]!.entry_count).toBe(0);
      },
    );
  });

  it("16. resolves the project root from the indexed repo", async () => {
    await withProject(
      {
        "src/content.config.ts": `
import { defineCollection } from "astro:content";
export const collections = { blog: defineCollection({ type: "content" }) };
`,
      },
      async (root) => {
        vi.spyOn(indexTools, "getCodeIndex").mockResolvedValue({ root } as Awaited<
          ReturnType<typeof indexTools.getCodeIndex>
        >);
        const result = await astroContentCollections({ repo: "local/example" });
        expect(indexTools.getCodeIndex).toHaveBeenCalledWith("local/example");
        expect(result.config_file).toBe("src/content.config.ts");
        expect(result.collections[0]!.name).toBe("blog");
      },
    );
  });

  it("17. validates YAML data entries", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";
const authors = defineCollection({
  loader: file("src/content/authors.yaml"),
  schema: z.object({ name: z.string() }),
});
export const collections = { authors };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/authors.yaml": "slug: ada\n",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.validation_issues[0]).toMatchObject({
          field: "name",
          message: "Missing required field 'name' (string)",
        });
      },
    );
  });

  it("18. validates each object in a JSON array", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";
const authors = defineCollection({
  loader: file("src/content/authors.json"),
  schema: z.object({ name: z.string() }),
});
export const collections = { authors };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/authors.json": JSON.stringify([{ name: "Ada" }, { slug: "grace" }]),
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.validation_issues).toEqual([
          expect.objectContaining({ field: "[1].name" }),
        ]);
      },
    );
  });

  it("19. matches project-relative glob patterns when base is omitted", async () => {
    const config = `
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
const blog = defineCollection({ loader: glob({ pattern: "src/content/blog/**/*.md" }) });
export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/blog/post.md": "---\ntitle: Post\n---\n",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]!.entry_count).toBe(1);
      },
    );
  });

  it("20. reports parser unavailability without claiming the config is missing", async () => {
    vi.spyOn(parserManager, "getParser").mockResolvedValue(null);
    await withProject(
      { "src/content.config.ts": "export const collections = {};" },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.config_version).toBe("v5+");
        expect(result.validation_issues[0]).toMatchObject({
          field: "$config",
          message: "JavaScript parser unavailable",
        });
      },
    );
  });

  it("21. reports config parse failures", async () => {
    const parser = await parserManager.getParser("javascript");
    expect(parser).not.toBeNull();
    vi.spyOn(parserManager, "getParser").mockResolvedValue({
      parse: () => {
        throw new Error("parse failed");
      },
    } as unknown as NonNullable<typeof parser>);
    await withProject(
      { "src/content.config.ts": "export const collections = {};" },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.config_version).toBe("v5+");
        expect(result.validation_issues[0]).toMatchObject({
          field: "$config",
          message: "Unable to parse content collection config",
        });
      },
    );
  });

  it("22. treats empty required values as missing", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
const blog = defineCollection({
  type: "content",
  schema: z.object({ title: z.string() }),
});
export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/blog/empty.md": "---\ntitle: \n---\n",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.validation_issues[0]).toMatchObject({ field: "title" });
      },
    );
  });

  it("23. treats id-keyed JSON objects as multiple entries", async () => {
    const config = `
import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";
const authors = defineCollection({
  loader: file("src/content/authors.json"),
  schema: z.object({ name: z.string() }),
});
export const collections = { authors };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/authors.json": JSON.stringify({
          ada: { name: "Ada" },
          grace: { name: "Grace" },
        }),
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]!.entry_count).toBe(2);
        expect(result.validation_issues).toEqual([]);
      },
    );
  });

  it("24. counts entries inside a file-loader JSON array", async () => {
    const config = `
import { defineCollection } from "astro:content";
import { file } from "astro/loaders";
const authors = defineCollection({ loader: file("src/content/authors.json") });
export const collections = { authors };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/authors.json": JSON.stringify([{ name: "Ada" }, { name: "Grace" }]),
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]!.entry_count).toBe(2);
        expect(result.summary.total_entries).toBe(2);
      },
    );
  });

  it("25. rejects file-loader symlinks that escape the project", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "astro-cc-symlink-"));
    const outsideFile = join(outsideRoot, "authors.json");
    await writeFile(outsideFile, JSON.stringify({ name: "External" }), "utf-8");
    try {
      const config = `
import { defineCollection } from "astro:content";
import { file } from "astro/loaders";
const authors = defineCollection({ loader: file("src/content/authors.json") });
export const collections = { authors };
`;
      await withProject(
        { "src/content.config.ts": config },
        async (root) => {
          await mkdir(join(root, "src/content"), { recursive: true });
          await symlink(outsideFile, join(root, "src/content/authors.json"));
          const result = await astroContentCollections({ project_root: root });
          expect(result.collections[0]!.entry_count).toBe(0);
        },
      );
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("26. prunes dependency directories for base-less glob loaders", async () => {
    const config = `
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
const blog = defineCollection({ loader: glob({ pattern: "**/*.md" }) });
export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "src/content/blog/post.md": "---\ntitle: Post\n---\n",
        "node_modules/example/noise.md": "dependency docs",
      },
      async (root) => {
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]!.entry_count).toBe(1);
      },
    );
  });

  it("27. preserves logical paths for in-project symlinked glob roots", async () => {
    const config = `
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
const blog = defineCollection({ loader: glob({ pattern: "src/content/blog/**/*.md" }) });
export const collections = { blog };
`;
    await withProject(
      {
        "src/content.config.ts": config,
        "content-real/post.md": "---\ntitle: Linked\n---\n",
      },
      async (root) => {
        await mkdir(join(root, "src/content"), { recursive: true });
        await symlink(join(root, "content-real"), join(root, "src/content/blog"));
        const result = await astroContentCollections({ project_root: root });
        expect(result.collections[0]!.entry_count).toBe(1);
      },
    );
  });
});
