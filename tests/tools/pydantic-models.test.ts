import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { getPydanticModels } from "../../src/tools/pydantic-models.js";
import type { PydanticModelsResult } from "../../src/tools/pydantic-models.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function makeSym(o: Partial<CodeSymbol> & { name: string; file: string }): CodeSymbol {
  return {
    id: `test:${o.file}:${o.name}:${o.start_line ?? 1}`,
    repo: "test",
    kind: "class",
    start_line: 1,
    end_line: 20,
    ...o,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test", root: "/tmp/test",
    symbols,
    files: [...new Set(symbols.map((s) => s.file))].map((f) => ({
      path: f, language: "python", symbol_count: 1, last_modified: Date.now(),
    })),
    created_at: Date.now(), updated_at: Date.now(),
    symbol_count: symbols.length, file_count: 1,
  };
}

describe("getPydanticModels", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("extracts simple BaseModel with typed fields", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "User",
        file: "schemas.py",
        extends: ["BaseModel"],
        source: "class User(BaseModel):\n    id: int\n    name: str\n    email: str",
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    expect(result.total_models).toBe(1);
    expect(result.models[0]!.name).toBe("User");
    expect(result.models[0]!.fields.map((f) => f.name)).toEqual(["id", "name", "email"]);
  });

  it("detects optional fields", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "Config",
        file: "schemas.py",
        extends: ["BaseModel"],
        source: "class Config(BaseModel):\n    debug: bool\n    max_users: Optional[int] = None\n    name: str | None = None",
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    const model = result.models[0]!;
    expect(model.fields.find((f) => f.name === "debug")!.optional).toBe(false);
    expect(model.fields.find((f) => f.name === "max_users")!.optional).toBe(true);
    expect(model.fields.find((f) => f.name === "name")!.optional).toBe(true);
  });

  it("extracts Field() constraints", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "Product",
        file: "schemas.py",
        extends: ["BaseModel"],
        source: 'class Product(BaseModel):\n    name: str = Field(min_length=3, max_length=100)\n    price: float = Field(gt=0)',
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    const product = result.models[0]!;
    const nameField = product.fields.find((f) => f.name === "name")!;
    expect(nameField.constraints).toContain("min_length=3");
    expect(nameField.constraints).toContain("max_length=100");
    const priceField = product.fields.find((f) => f.name === "price")!;
    expect(priceField.constraints).toContain("gt=0");
  });

  it("builds edges between referenced models", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "Role",
        file: "schemas.py",
        extends: ["BaseModel"],
        source: "class Role(BaseModel):\n    name: str",
      }),
      makeSym({
        name: "User",
        file: "schemas.py",
        start_line: 5,
        extends: ["BaseModel"],
        source: "class User(BaseModel):\n    id: int\n    role: Role",
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    const edge = result.edges.find((e) => e.from === "User" && e.to === "Role");
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe("reference");
  });

  it("detects list[X] as 'list' kind edge", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "Tag", file: "s.py", extends: ["BaseModel"], source: "class Tag(BaseModel):\n    name: str" }),
      makeSym({
        name: "Post",
        file: "s.py",
        start_line: 5,
        extends: ["BaseModel"],
        source: "class Post(BaseModel):\n    title: str\n    tags: list[Tag]",
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    const edge = result.edges.find((e) => e.from === "Post" && e.to === "Tag");
    expect(edge!.kind).toBe("list");
  });

  it("detects inheritance edges", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({ name: "UserBase", file: "s.py", extends: ["BaseModel"], source: "class UserBase(BaseModel):\n    name: str" }),
      makeSym({
        name: "UserResponse",
        file: "s.py",
        start_line: 5,
        extends: ["UserBase"],
        source: "class UserResponse(UserBase):\n    id: int",
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    const inheritanceEdge = result.edges.find((e) => e.kind === "inheritance");
    expect(inheritanceEdge).toBeDefined();
    expect(inheritanceEdge!.from).toBe("UserResponse");
    expect(inheritanceEdge!.to).toBe("UserBase");
    expect(result.models.find((m) => m.name === "UserResponse")!.is_derived).toBe(true);
  });

  it("extracts validators", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "User",
        file: "s.py",
        extends: ["BaseModel"],
        source: "class User(BaseModel):\n    name: str\n\n    @field_validator('name')\n    def validate_name(cls, v):\n        return v.lower()",
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    expect(result.models[0]!.validators).toContain("validate_name");
  });

  it("extracts model_config overrides", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "Strict",
        file: "s.py",
        extends: ["BaseModel"],
        source: 'class Strict(BaseModel):\n    model_config = ConfigDict(strict=True, extra="forbid")\n    name: str',
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    expect(result.models[0]!.config.strict).toBe("True");
    expect(result.models[0]!.config.extra).toBe("forbid");
  });

  it("ignores non-Pydantic classes", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "DjangoModel",
        file: "s.py",
        extends: ["models.Model"],
        source: "class DjangoModel(models.Model):\n    name = models.CharField()",
      }),
    ]));

    const result = await getPydanticModels("test") as PydanticModelsResult;
    expect(result.total_models).toBe(0);
  });

  it("produces mermaid classDiagram", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex([
      makeSym({
        name: "User",
        file: "s.py",
        extends: ["BaseModel"],
        source: "class User(BaseModel):\n    id: int\n    name: str",
      }),
    ]));

    const result = await getPydanticModels("test", { output_format: "mermaid" }) as { mermaid: string };
    expect(result.mermaid).toContain("classDiagram");
    expect(result.mermaid).toContain("class User");
    expect(result.mermaid).toContain("id");
  });
});
