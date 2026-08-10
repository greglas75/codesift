import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestGraphQLMap } from "../../src/tools/nest-ext-tools.js";

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

describe("shared Nest analyzer errors", () => {
  it("reports the missing repository and indexing remedy", async () => {
    mockedGetCodeIndex.mockResolvedValue(undefined);

    await expect(nestGraphQLMap("test-repo")).rejects.toThrow(
      'Repository "test-repo" not found. Index it first with index_folder.',
    );
  });
});

// ---------------------------------------------------------------------------
// G5: nest_graphql_map
// ---------------------------------------------------------------------------

describe("nest_graphql_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-gql-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts Query, Mutation, Subscription handlers", async () => {
    await writeFile(join(tmpRoot, "src/article.resolver.ts"), `
import { Resolver, Query, Mutation, Subscription, Args } from '@nestjs/graphql';
import { Article } from './article.entity';

@Resolver(() => Article)
export class ArticleResolver {
  @Query(() => [Article])
  async articles() { return []; }

  @Mutation(() => Article)
  async createArticle(@Args('input') input: CreateArticleInput) {}

  @Subscription(() => Article)
  articleCreated() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/article.resolver.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestGraphQLMap("test-repo");
    expect(result.entries).toHaveLength(3);
    expect(result.entries.find((e) => e.handler === "articles")!.operation).toBe("Query");
    expect(result.entries.find((e) => e.handler === "createArticle")!.operation).toBe("Mutation");
    expect(result.entries.find((e) => e.handler === "articleCreated")!.operation).toBe("Subscription");
    // All resolved to ArticleResolver class
    expect(result.entries.every((e) => e.resolver_class === "ArticleResolver")).toBe(true);
    // Return type extracted
    expect(result.entries.find((e) => e.handler === "articles")!.return_type).toBe("Article");
  });

  it("returns empty entries for repo with no resolvers", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestGraphQLMap("test-repo");
    expect(result.entries).toEqual([]);
  });

  it("truncates when max_entries exceeded", async () => {
    await writeFile(join(tmpRoot, "src/a.resolver.ts"), `
@Resolver() export class AResolver {
  @Query() a() {}
  @Query() b() {}
  @Query() c() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/a.resolver.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestGraphQLMap("test-repo", { max_entries: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("stops before reading a later resolver after reaching max_entries", async () => {
    await writeFile(join(tmpRoot, "src/first.resolver.ts"), `
@Resolver() class FirstResolver { @Query() first() {} }
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, [
        "src/first.resolver.ts",
        "src/missing.resolver.ts",
      ]),
    );

    const result = await nestGraphQLMap("test-repo", { max_entries: 1 });

    expect(result.entries).toEqual([
      expect.objectContaining({ handler: "first", resolver_class: "FirstResolver" }),
    ]);
    expect(result.errors).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it("extracts operations from JavaScript resolver files", async () => {
    await writeFile(join(tmpRoot, "src/legacy.resolver.js"), `
@Resolver()
class LegacyResolver {
  @Query()
  legacy() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/legacy.resolver.js"]),
    );

    const result = await nestGraphQLMap("test-repo");

    expect(result.entries).toEqual([
      expect.objectContaining({
        file: "src/legacy.resolver.js",
        handler: "legacy",
        resolver_class: "LegacyResolver",
      }),
    ]);
  });

  it("CQ8: unreadable file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.resolver.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestGraphQLMap("test-repo");
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([
      {
        file: "src/missing.resolver.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
  });

  it("adversarial regression: ignores commented resolvers and attributes operations to their class", async () => {
    await writeFile(join(tmpRoot, "src/multi.resolver.ts"), `
// @Resolver() class RemovedResolver { @Query() removed() {} }
@Resolver()
@UseGuards(GqlAuthGuard)
export class FirstResolver {
  @Query()
  first() {}
}
@Resolver()
export class SecondResolver {
  @Mutation()
  second() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/multi.resolver.ts"]));

    const result = await nestGraphQLMap("test-repo");

    expect(result.entries).toEqual([
      expect.objectContaining({ handler: "first", resolver_class: "FirstResolver" }),
      expect.objectContaining({ handler: "second", resolver_class: "SecondResolver" }),
    ]);
  });
});
