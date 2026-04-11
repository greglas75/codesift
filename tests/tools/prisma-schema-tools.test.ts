import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must come before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { analyzePrismaSchema } from "../../src/tools/prisma-schema-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { readFile } from "node:fs/promises";
import type { CodeIndex, FileEntry } from "../../src/types.js";

const mockGetCodeIndex = vi.mocked(getCodeIndex);
const mockReadFile = vi.mocked(readFile);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFile(path: string): FileEntry {
  return {
    path,
    language: "prisma",
    symbol_count: 0,
    last_modified: Date.now(),
  };
}

function makeIndex(files: FileEntry[]): CodeIndex {
  return {
    repo: "test",
    root: "/test/repo",
    symbols: [],
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: files.length,
  };
}

const SAMPLE_SCHEMA = `
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime?

  @@index([email])
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
  status   String
}

enum PostStatus {
  DRAFT
  PUBLISHED
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzePrismaSchema", () => {
  beforeEach(() => {
    mockGetCodeIndex.mockReset();
    mockReadFile.mockReset();
  });

  it("throws when repo is not indexed", async () => {
    mockGetCodeIndex.mockResolvedValue(null);
    await expect(analyzePrismaSchema("missing")).rejects.toThrow(/not found/);
  });

  it("throws when no schema.prisma file exists in index", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([makeFile("src/index.ts")]));
    await expect(analyzePrismaSchema("test")).rejects.toThrow(/No Prisma schema/);
  });

  it("throws when schema file cannot be read", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await expect(analyzePrismaSchema("test")).rejects.toThrow(
      /Failed to read Prisma schema/,
    );
  });

  it("parses schema and counts models + enums", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test");
    expect(report.model_count).toBe(2);
    expect(report.enum_count).toBe(1);
    expect(report.schema_path).toBe("prisma/schema.prisma");
  });

  it("detects User has id, soft-delete, and timestamps", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test");
    const user = report.models.find((m) => m.name === "User");
    expect(user).toBeDefined();
    expect(user!.has_id).toBe(true);
    expect(user!.has_created_at).toBe(true);
    expect(user!.has_updated_at).toBe(true);
    expect(user!.has_soft_delete).toBe(true);
  });

  it("detects Post FK column authorId without index", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test");
    const post = report.models.find((m) => m.name === "Post");
    expect(post).toBeDefined();
    expect(post!.fk_columns).toEqual(["authorId"]);
    expect(post!.fk_columns_without_index).toEqual(["authorId"]);
    expect(post!.fk_columns_with_index).toEqual([]);
  });

  it("detects Post.status as status-like String field", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test");
    const post = report.models.find((m) => m.name === "Post");
    expect(post!.status_like_string_fields).toContain("status");
  });

  it("computes fk_index_coverage_pct correctly", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test");
    // 1 FK total (authorId), 0 covered → 0%
    expect(report.totals.fk_columns).toBe(1);
    expect(report.totals.fk_with_index).toBe(0);
    expect(report.totals.fk_without_index).toBe(1);
    expect(report.totals.fk_index_coverage_pct).toBe(0);
  });

  it("emits warning for FK without @@index", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test");
    const fkWarn = report.warnings.find(
      (w) => w.includes("Post") && w.includes("authorId") && w.includes("@@index"),
    );
    expect(fkWarn).toBeDefined();
  });

  it("counts soft_delete_models in totals", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test");
    // Only User has deletedAt
    expect(report.totals.soft_delete_models).toBe(1);
  });

  it("honors explicit schema_path option", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("src/index.ts")]), // no prisma in index
    );
    mockReadFile.mockResolvedValue(SAMPLE_SCHEMA);

    const report = await analyzePrismaSchema("test", {
      schema_path: "custom/db.prisma",
    });
    expect(report.schema_path).toBe("custom/db.prisma");
    expect(report.model_count).toBe(2);
  });

  it("covers FK when @@index([authorId]) is present", async () => {
    const covered = `
model Post {
  id       Int    @id
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])

  @@index([authorId])
}

model User {
  id Int @id
}
`;
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(covered);

    const report = await analyzePrismaSchema("test");
    const post = report.models.find((m) => m.name === "Post");
    expect(post!.fk_columns_with_index).toEqual(["authorId"]);
    expect(post!.fk_columns_without_index).toEqual([]);
    expect(report.totals.fk_index_coverage_pct).toBe(100);
  });

  it("detects enum-typed fields", async () => {
    const withEnum = `
model Post {
  id     Int        @id
  status PostStatus
}

enum PostStatus {
  DRAFT
  PUBLISHED
}
`;
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(withEnum);

    const report = await analyzePrismaSchema("test");
    const post = report.models.find((m) => m.name === "Post");
    expect(post!.uses_enum_fields).toContain("status");
    // status is an enum here, NOT a String → should NOT be flagged as status-like String
    expect(post!.status_like_string_fields).not.toContain("status");
  });

  it("captures composite indexes and unique constraints", async () => {
    const composite = `
model Post {
  id       Int    @id
  authorId Int
  slug     String

  @@index([authorId, slug])
  @@unique([slug])
}
`;
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([makeFile("prisma/schema.prisma")]),
    );
    mockReadFile.mockResolvedValue(composite);

    const report = await analyzePrismaSchema("test");
    const post = report.models.find((m) => m.name === "Post");
    expect(post!.composite_indexes).toEqual(["[authorId, slug]"]);
    expect(post!.unique_constraints).toContain("[slug]");
    expect(report.totals.composite_indexes).toBe(1);
  });
});
