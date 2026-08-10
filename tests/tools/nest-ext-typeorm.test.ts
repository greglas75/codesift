import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestTypeOrmMap } from "../../src/tools/nest-ext-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

beforeEach(() => {
  mockedGetCodeIndex.mockReset();
});

afterEach(() => {
  expect(mockedGetCodeIndex).toHaveBeenCalledTimes(1);
  expect(mockedGetCodeIndex).toHaveBeenCalledWith("test-repo");
  expect(mockedGetCodeIndex).not.toHaveBeenCalledWith("other-repo");
});

function mockIndexWithRoot(root: string, filePaths: string[]): CodeIndex {
  return {
    root,
    files: filePaths.map((p) => ({ path: p, size: 100 })),
    symbols: [],
  } as unknown as CodeIndex;
}

describe("nest_typeorm_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-typeorm-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts entities with table names and relation edges", async () => {
    await writeFile(join(tmpRoot, "src/article.entity.ts"), `
import { Entity, PrimaryGeneratedColumn, Column, OneToMany, ManyToOne } from 'typeorm';

@Entity('articles')
export class Article {
  @PrimaryGeneratedColumn() id: number;
  @Column() title: string;
  @OneToMany(() => Comment, c => c.article) comments: Comment[];
  @ManyToOne(() => User, u => u.articles) author: User;
}
`);
    await writeFile(join(tmpRoot, "src/comment.entity.ts"), `
@Entity()
export class Comment {
  @ManyToOne(() => Article, a => a.comments) article: Article;
  @ManyToOne(() => User, u => u.comments) user: User;
}
`);
    await writeFile(join(tmpRoot, "src/user.entity.ts"), `
@Entity('users')
export class User {
  @OneToMany(() => Article, a => a.author) articles: Article[];
  @OneToMany(() => Comment, c => c.user) comments: Comment[];
}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/article.entity.ts",
      "src/comment.entity.ts",
      "src/user.entity.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestTypeOrmMap("test-repo");
    expect(result.entities).toHaveLength(3);
    expect(result.entities.find((e) => e.name === "Article")!.table).toBe("articles");
    expect(result.entities.find((e) => e.name === "User")!.table).toBe("users");
    expect(result.entities.find((e) => e.name === "Comment")!.table).toBeUndefined();

    // Edges
    expect(result.edges).toContainEqual({ from: "Article", to: "Comment", relation: "OneToMany" });
    expect(result.edges).toContainEqual({ from: "Article", to: "User", relation: "ManyToOne" });
    expect(result.edges).toContainEqual({ from: "Comment", to: "Article", relation: "ManyToOne" });
    expect(result.edges).toContainEqual({ from: "User", to: "Article", relation: "OneToMany" });

    // Cycles: Article ↔ Comment and Article ↔ User create cycles
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  it("truncates when max_entities exceeded", async () => {
    await writeFile(join(tmpRoot, "src/a.entity.ts"), `@Entity() class A {}`);
    await writeFile(join(tmpRoot, "src/b.entity.ts"), `@Entity() class B {}`);
    const index = mockIndexWithRoot(tmpRoot, ["src/a.entity.ts", "src/b.entity.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestTypeOrmMap("test-repo", { max_entities: 1 });
    expect(result.entities).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("CQ8: unreadable entity file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.entity.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestTypeOrmMap("test-repo");
    expect(result.errors).toEqual([
      {
        file: "src/missing.entity.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
  });

  it("adversarial regression: supports Entity options, type-arrow relations, and exact limits", async () => {
    await writeFile(join(tmpRoot, "src/photo.entity.ts"), `
@Entity('photos', { schema: 'app', orderBy: { id: 'ASC' } })
export class Photo {
  @ManyToOne(type => User, user => user.photos)
  user: User;
}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/photo.entity.ts"]));

    const result = await nestTypeOrmMap("test-repo", { max_entities: 1 });

    expect(result.entities).toEqual([
      { name: "Photo", file: "src/photo.entity.ts", table: "photos" },
    ]);
    expect(result.edges).toContainEqual({ from: "Photo", to: "User", relation: "ManyToOne" });
    expect(result.truncated).toBeUndefined();
  });

  it("adversarial regression: reads top-level entity names and ignores commented relations", async () => {
    await writeFile(join(tmpRoot, "src/advanced.entity.ts"), `
@Entity({ metadata: { name: 'wrong' }, name: 'advanced' })
class Advanced {
  // @OneToMany(() => Ghost)
  @ManyToOne((type: Type) => User, user => user.advanced)
  user: User;
}
@Entity(/* table */ 'audit')
class Audit {}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/advanced.entity.ts"]));

    const result = await nestTypeOrmMap("test-repo");

    expect(result.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Advanced", table: "advanced" }),
        expect.objectContaining({ name: "Audit", table: "audit" }),
      ]),
    );
    expect(result.edges).toContainEqual({
      from: "Advanced",
      to: "User",
      relation: "ManyToOne",
    });
    expect(result.edges.some((edge) => edge.to === "Ghost")).toBe(false);
  });

  it("does not borrow a later property value for a shorthand entity name", async () => {
    await writeFile(join(tmpRoot, "src/shorthand.entity.ts"), `
const name = 'runtime-name';
@Entity({ name, schema: 'audit' })
class ShorthandEntity {}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/shorthand.entity.ts"]),
    );

    const result = await nestTypeOrmMap("test-repo");

    expect(result.entities).toEqual([
      { name: "ShorthandEntity", file: "src/shorthand.entity.ts" },
    ]);
  });
});
