import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroDbAudit } from "../../src/tools/astro-db-audit.js";

beforeAll(async () => {
  await initParser();
});

async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-db-"));
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

const SCHEMA = `
import { defineTable, column } from "astro:db";

const Author = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    name: column.text(),
  },
});

const Comment = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    body: column.text(),
    authorId: column.number({ references: () => Author.columns.id }),
  },
});

export default { tables: { Author, Comment } };
`;

describe("astro_db_audit", () => {
  it("happy path — schema extracted, no FK index → DB03; loop+select → DB02", async () => {
    const usage = `
import { db, Comment, Author } from "astro:db";
const posts = await db.select().from(Author);
for (const post of posts) {
  await db.select().from(Comment).where(eq(Comment.authorId, post.id));
}
`;
    await withProject(
      { "db/config.ts": SCHEMA, "src/pages/index.astro": "---\n" + usage + "\n---\n" },
      async (root) => {
        const result = await astroDbAudit({ project_root: root });
        expect(result.tables.length).toBe(2);
        expect(result.n_plus_one.length).toBeGreaterThanOrEqual(1);
        expect(result.n_plus_one[0]?.code).toBe("DB02");
        expect(result.missing_indexes.some((c) => c.column === "authorId" && c.code === "DB03")).toBe(true);
      },
    );
  });

  it("no db/config.ts → empty tables, no issues", async () => {
    await withProject({ "package.json": "{}" }, async (root) => {
      const result = await astroDbAudit({ project_root: root });
      expect(result.tables).toEqual([]);
      expect(result.n_plus_one).toEqual([]);
      expect(result.missing_indexes).toEqual([]);
    });
  });

  it("no select calls → no DB02 even with FK", async () => {
    await withProject(
      { "db/config.ts": SCHEMA, "src/pages/x.astro": `---\nconst x = 1;\n---\n` },
      async (root) => {
        const result = await astroDbAudit({ project_root: root });
        expect(result.n_plus_one).toEqual([]);
      },
    );
  });

  it("FK column with explicit index avoids DB03", async () => {
    const schema = `
import { defineTable, column } from "astro:db";
const Author = defineTable({
  columns: { id: column.number({ primaryKey: true }) },
});
const Comment = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    authorId: column.number({ references: () => Author.columns.id }),
  },
  indexes: [{ on: ["authorId"] }],
});
export default { tables: { Author, Comment } };
`;
    await withProject(
      { "db/config.ts": schema },
      async (root) => {
        const result = await astroDbAudit({ project_root: root });
        expect(result.missing_indexes).toEqual([]);
      },
    );
  });

  it("indexed column on table A does NOT mask missing index on same-named col in table B", async () => {
    // Cross-table contamination regression (adversarial CRITICAL).
    const schema = `
import { defineTable, column } from "astro:db";
const Author = defineTable({
  columns: { id: column.number({ primaryKey: true }) },
});
const A = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    authorId: column.number({ references: () => Author.columns.id }),
  },
  indexes: [{ on: ["authorId"] }],  // A.authorId IS indexed
});
const B = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    authorId: column.number({ references: () => Author.columns.id }),
  },
  // B.authorId NOT indexed — must still be flagged
});
export default { tables: { Author, A, B } };
`;
    await withProject(
      { "db/config.ts": schema },
      async (root) => {
        const result = await astroDbAudit({ project_root: root });
        const Bmissing = result.missing_indexes.find((m) => m.table === "B" && m.column === "authorId");
        const Amissing = result.missing_indexes.find((m) => m.table === "A" && m.column === "authorId");
        expect(Bmissing).toBeDefined();
        expect(Amissing).toBeUndefined();
      },
    );
  });

  it("forEach with parenthesized arrow params + nested if still flagged DB02", async () => {
    // Regex CRITICAL regression — AST detection must catch standard Prettier shape.
    const usage = `
import { db, Comment } from "astro:db";
posts.forEach((post) => {
  if (post.active) {
    db.select().from(Comment).where(eq(Comment.authorId, post.id));
  }
});
`;
    await withProject(
      { "db/config.ts": SCHEMA, "src/pages/api/x.ts": usage },
      async (root) => {
        const result = await astroDbAudit({ project_root: root });
        expect(result.n_plus_one.length).toBeGreaterThanOrEqual(1);
        expect(result.n_plus_one[0]?.message).toMatch(/forEach/);
      },
    );
  });

  it("circular references are flagged DB04 and do not infinite loop", async () => {
    const schema = `
import { defineTable, column } from "astro:db";
const A = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    bId: column.number({ references: () => B.columns.id }),
  },
});
const B = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    aId: column.number({ references: () => A.columns.id }),
  },
});
export default { tables: { A, B } };
`;
    await withProject(
      { "db/config.ts": schema },
      async (root) => {
        const result = await astroDbAudit({ project_root: root });
        // The function must terminate; cycle detection emits DB04
        expect(result.issues.some((i) => i.code === "DB04")).toBe(true);
      },
    );
  });
});
