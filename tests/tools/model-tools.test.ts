import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { getModelGraph } from "../../src/tools/model-tools.js";
import type { ModelGraph } from "../../src/tools/model-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function makeIndex(symbols: Array<Partial<CodeSymbol> & { name: string; file: string }>): CodeIndex {
  const syms: CodeSymbol[] = symbols.map((s) => ({
    id: `test:${s.file}:${s.name}:${s.start_line ?? 1}`,
    repo: "test",
    kind: "class",
    start_line: 1,
    end_line: 50,
    ...s,
  }));
  return {
    repo: "test",
    root: "/tmp/test",
    symbols: syms,
    files: [...new Set(syms.map((s) => s.file))].map((f) => ({
      path: f, language: "python", symbol_count: 1, last_modified: Date.now(),
    })),
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: syms.length,
    file_count: 1,
  };
}

describe("getModelGraph — Django", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("extracts ForeignKey relationship", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      {
        name: "Author",
        file: "models.py",
        extends: ["models.Model"],
        source: `class Author(models.Model):\n    name = models.CharField(max_length=100)`,
      },
      {
        name: "Book",
        file: "models.py",
        extends: ["models.Model"],
        source: `class Book(models.Model):\n    title = models.CharField(max_length=200)\n    author = models.ForeignKey(Author, on_delete=models.CASCADE)`,
      },
    ]));

    const result = await getModelGraph("test") as ModelGraph;
    expect(result.models).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      from: "Book",
      to: "Author",
      field: "author",
      relationship: "fk",
    });
    expect(result.framework).toBe("django");
  });

  it("extracts ManyToManyField", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      {
        name: "Article",
        file: "models.py",
        extends: ["models.Model"],
        source: `class Article(models.Model):\n    tags = models.ManyToManyField('Tag')`,
      },
    ]));

    const result = await getModelGraph("test") as ModelGraph;
    expect(result.edges[0]).toMatchObject({
      from: "Article",
      to: "Tag",
      relationship: "m2m",
    });
  });
});

describe("getModelGraph — SQLAlchemy", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("extracts relationship()", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      {
        name: "User",
        file: "models.py",
        extends: ["Base"],
        source: `class User(Base):\n    __tablename__ = 'users'\n    id = Column(Integer, primary_key=True)\n    posts = relationship("Post", back_populates="author")`,
      },
    ]));

    const result = await getModelGraph("test") as ModelGraph;
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      from: "User",
      to: "Post",
      relationship: "relationship",
    });
    expect(result.framework).toBe("sqlalchemy");
  });
});

describe("getModelGraph — mermaid output", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("generates mermaid erDiagram", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      {
        name: "User",
        file: "models.py",
        extends: ["models.Model"],
        source: `class User(models.Model):\n    name = models.CharField(max_length=100)`,
      },
      {
        name: "Post",
        file: "models.py",
        extends: ["models.Model"],
        source: `class Post(models.Model):\n    author = models.ForeignKey(User, on_delete=models.CASCADE)`,
      },
    ]));

    const result = await getModelGraph("test", { output_format: "mermaid" }) as { mermaid: string };
    expect(result.mermaid).toContain("erDiagram");
    expect(result.mermaid).toContain("Post");
    expect(result.mermaid).toContain("User");
    expect(result.mermaid).toContain("author");
  });
});
