import { describe, it, expect, beforeAll } from "vitest";
import { initParser } from "../../src/parser/parser-manager.js";
import { parseAstroDbSchema } from "../../src/tools/astro-db-parser.js";

beforeAll(async () => {
  await initParser();
});

describe("parseAstroDbSchema", () => {
  it("extracts a simple two-table schema with columns and FK reference", async () => {
    const src = `
import { defineDb, defineTable, column } from "astro:db";

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

export default defineDb({ tables: { Author, Comment } });
`;
    const result = await parseAstroDbSchema(src);
    expect(result.tables.length).toBe(2);
    const author = result.tables.find((t) => t.name === "Author");
    const comment = result.tables.find((t) => t.name === "Comment");
    expect(author).toBeDefined();
    expect(comment).toBeDefined();
    expect(author!.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(author!.columns.find((c) => c.name === "name")?.type).toBe("text");
    const authorIdCol = comment!.columns.find((c) => c.name === "authorId");
    expect(authorIdCol?.type).toBe("number");
    expect(authorIdCol?.references).toBe("Author.id");
    expect(result.issues).toEqual([]);
  });

  it("returns empty result for empty source", async () => {
    const result = await parseAstroDbSchema("");
    expect(result.tables).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("returns empty tables when no defineTable calls are present", async () => {
    const result = await parseAstroDbSchema(`const x = 1; export default {};`);
    expect(result.tables).toEqual([]);
  });

  it("flags malformed input with DB00 (no throw)", async () => {
    const result = await parseAstroDbSchema(`const Author = defineTable({{{`);
    expect(result.issues.some((i) => i.code === "DB00")).toBe(true);
    expect(result.tables).toEqual([]);
  });

  it("preserves multi-segment FK paths (e.g. db.User.columns.id → db.User.id)", async () => {
    const src = `
const Comment = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    authorId: column.number({ references: () => db.User.columns.id }),
  },
});
`;
    const result = await parseAstroDbSchema(src);
    const c = result.tables.find((t) => t.name === "Comment");
    const fk = c?.columns.find((col) => col.name === "authorId")?.references;
    expect(fk).toBe("db.User.id");
  });

  it("partial-syntax-error source still extracts valid tables (tree-sitter recovery)", async () => {
    const src = `
const Author = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    name: column.text(),
  },
});

const Broken = defineTable({ columns: { id: column.number({ primaryKey: trueeeeee  // <-- typo
`;
    const result = await parseAstroDbSchema(src);
    // Author should still be extracted even though the file has trailing errors
    expect(result.tables.find((t) => t.name === "Author")).toBeDefined();
    // A warning is recorded but not a hard fail
    expect(result.issues.some((i) => i.code === "DB00")).toBe(true);
  });

  it("captures column index flags", async () => {
    const src = `
const Post = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    slug: column.text({ unique: true }),
    title: column.text(),
  },
  indexes: [{ on: ["slug"] }],
});
`;
    const result = await parseAstroDbSchema(src);
    const post = result.tables.find((t) => t.name === "Post");
    expect(post).toBeDefined();
    const slug = post!.columns.find((c) => c.name === "slug");
    expect(slug?.unique).toBe(true);
  });

  it("extracts optional/nullable columns", async () => {
    const src = `
const T = defineTable({
  columns: {
    note: column.text({ optional: true }),
    deletedAt: column.date({ optional: true }),
  },
});
`;
    const result = await parseAstroDbSchema(src);
    const t = result.tables[0]!;
    expect(t.columns.find((c) => c.name === "note")?.optional).toBe(true);
    expect(t.columns.find((c) => c.name === "deletedAt")?.optional).toBe(true);
  });
});
