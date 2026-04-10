import { describe, it, expect } from "vitest";
import { explainQuery } from "../../src/tools/query-tools.js";

// ---------------------------------------------------------------------------
// explainQuery — pure/synchronous, no mocks needed
// ---------------------------------------------------------------------------

describe("explainQuery — parsing", () => {
  it("parses basic findMany and generates SELECT SQL", () => {
    const result = explainQuery(
      `prisma.user.findMany({ where: { role: "admin" }, select: { id: true, name: true }, orderBy: { createdAt: "desc" }, take: 50 })`,
    );

    expect(result.parsed.model).toBe("user");
    expect(result.parsed.method).toBe("findMany");
    expect(result.sql).toMatch(/^SELECT/);
    expect(result.sql).toContain('"user"');
    expect(result.sql).toContain("LIMIT 50");
    expect(result.explain_command).toBe(`EXPLAIN ANALYZE ${result.sql}`);
  });

  it("parses findFirst → SELECT ... LIMIT 1", () => {
    const result = explainQuery(
      `prisma.post.findFirst({ where: { published: true } })`,
    );

    expect(result.parsed.model).toBe("post");
    expect(result.parsed.method).toBe("findFirst");
    expect(result.sql).toContain("LIMIT 1");
    expect(result.sql).toContain('"post"');
  });

  it("parses findUnique → SELECT ... WHERE ... LIMIT 1", () => {
    const result = explainQuery(
      `prisma.user.findUnique({ where: { id: "abc123" } })`,
    );

    expect(result.parsed.model).toBe("user");
    expect(result.parsed.method).toBe("findUnique");
    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain('"id"');
    expect(result.sql).toContain("LIMIT 1");
  });

  it("parses count → SELECT COUNT(*)", () => {
    const result = explainQuery(
      `prisma.user.count({ where: { active: true } })`,
    );

    expect(result.parsed.method).toBe("count");
    expect(result.sql).toMatch(/SELECT COUNT\(\*\)/);
    expect(result.sql).toContain("WHERE");
  });

  it("extracts where clause fields", () => {
    const result = explainQuery(
      `prisma.user.findMany({ where: { email: "a@b.com", role: "admin" }, take: 10 })`,
    );

    expect(result.parsed.where).toBeDefined();
    expect(result.parsed.where).toHaveProperty("email");
    expect(result.parsed.where).toHaveProperty("role");
  });

  it("extracts select fields", () => {
    const result = explainQuery(
      `prisma.user.findMany({ select: { id: true, name: true, email: true }, take: 10 })`,
    );

    expect(result.parsed.select).toEqual(["id", "name", "email"]);
    expect(result.sql).toContain('"id"');
    expect(result.sql).toContain('"name"');
    expect(result.sql).toContain('"email"');
    // should NOT be SELECT *
    expect(result.sql).not.toMatch(/SELECT \*/);
  });

  it("extracts orderBy", () => {
    const result = explainQuery(
      `prisma.post.findMany({ orderBy: { createdAt: "desc" }, take: 20 })`,
    );

    expect(result.parsed.orderBy).toBeDefined();
    expect(result.parsed.orderBy!.length).toBeGreaterThan(0);
    expect(result.parsed.orderBy![0]).toMatch(/createdAt.*DESC/);
    expect(result.sql).toContain("ORDER BY");
    expect(result.sql).toContain("DESC");
  });

  it("extracts take/skip into LIMIT/OFFSET", () => {
    const result = explainQuery(
      `prisma.user.findMany({ take: 25, skip: 100 })`,
    );

    expect(result.parsed.take).toBe(25);
    expect(result.parsed.skip).toBe(100);
    expect(result.sql).toContain("LIMIT 25");
    expect(result.sql).toContain("OFFSET 100");
  });
});

describe("explainQuery — warnings", () => {
  it("warns for findMany without take", () => {
    const result = explainQuery(
      `prisma.user.findMany({ where: { active: true } })`,
    );

    expect(result.warnings.some((w) => /unbounded|take/i.test(w))).toBe(true);
  });

  it("does NOT warn when findMany has take", () => {
    const result = explainQuery(
      `prisma.user.findMany({ where: { active: true }, take: 50 })`,
    );

    expect(result.warnings.some((w) => /unbounded/i.test(w))).toBe(false);
  });

  it("warns for include with relations", () => {
    const result = explainQuery(
      `prisma.user.findMany({ include: { posts: true, comments: true }, take: 10 })`,
    );

    expect(result.parsed.include).toEqual(["posts", "comments"]);
    expect(result.warnings.some((w) => /include.*relation|JOIN/i.test(w))).toBe(true);
  });
});

describe("explainQuery — optimization hints", () => {
  it("hints for potential missing index on non-standard where fields", () => {
    const result = explainQuery(
      `prisma.user.findMany({ where: { department: "eng" }, take: 10 })`,
    );

    const hasIndexHint = result.optimization_hints.some((h) =>
      /index.*department/i.test(h),
    );
    expect(hasIndexHint).toBe(true);
  });

  it("does NOT hint index on well-indexed fields (id, email)", () => {
    const result = explainQuery(
      `prisma.user.findUnique({ where: { id: "abc" } })`,
    );

    // "id" is in the indexed list — should not produce an index hint for it
    const hasIdHint = result.optimization_hints.some((h) => /index.*"id"/i.test(h));
    expect(hasIdHint).toBe(false);
  });

  it("hints orderBy index coverage", () => {
    const result = explainQuery(
      `prisma.post.findMany({ orderBy: { createdAt: "desc" }, take: 20 })`,
    );

    expect(result.optimization_hints.some((h) => /index.*createdAt/i.test(h))).toBe(true);
  });
});

describe("explainQuery — dialects", () => {
  it("postgresql dialect uses double quotes", () => {
    const result = explainQuery(
      `prisma.user.findMany({ take: 10 })`,
      { dialect: "postgresql" },
    );

    expect(result.sql).toContain('"user"');
    expect(result.sql).not.toContain("`user`");
  });

  it("mysql dialect uses backticks", () => {
    const result = explainQuery(
      `prisma.user.findMany({ where: { email: "a@b.com" }, take: 10 })`,
      { dialect: "mysql" },
    );

    expect(result.sql).toContain("`user`");
    expect(result.sql).toContain("`email`");
    expect(result.sql).not.toMatch(/"user"/);
  });

  it("sqlite dialect uses double quotes", () => {
    const result = explainQuery(
      `prisma.user.findMany({ take: 10 })`,
      { dialect: "sqlite" },
    );

    expect(result.sql).toContain('"user"');
  });

  it("defaults to postgresql when no dialect provided", () => {
    const result = explainQuery(`prisma.user.findMany({ take: 10 })`);
    expect(result.sql).toContain('"user"');
  });
});

describe("explainQuery — error handling", () => {
  it("throws on invalid input (no prisma.model.method pattern)", () => {
    expect(() => explainQuery("const x = 42")).toThrow(/parse|prisma/i);
  });

  it("throws on empty input", () => {
    expect(() => explainQuery("")).toThrow(/parse|prisma/i);
  });

  it("throws on malformed prisma call", () => {
    expect(() => explainQuery("prisma.findMany(...)")).toThrow(/parse|prisma/i);
  });
});

describe("explainQuery — result shape", () => {
  it("returns all expected fields", () => {
    const result = explainQuery(
      `prisma.user.findMany({ where: { id: "1" }, take: 10 })`,
    );

    expect(result).toHaveProperty("sql");
    expect(result).toHaveProperty("explain_command");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("optimization_hints");
    expect(result).toHaveProperty("parsed");
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.optimization_hints)).toBe(true);
    expect(result.explain_command.startsWith("EXPLAIN ANALYZE")).toBe(true);
  });
});
