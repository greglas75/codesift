import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractKotlinSerializationContract } from "../../src/tools/serialization-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));
const { getCodeIndex } = await import("../../src/tools/index-tools.js");

function makeSym(overrides: Partial<CodeSymbol> & { name: string }): CodeSymbol {
  return {
    id: `test:${overrides.file ?? "api.kt"}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: overrides.kind ?? "class",
    file: overrides.file ?? "api.kt",
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 20,
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [],
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: 0,
  };
}

describe("extractKotlinSerializationContract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extracts fields from a simple @Serializable data class", async () => {
    const index = makeIndex([
      makeSym({
        name: "User",
        decorators: ["Serializable"],
        source: `@Serializable
data class User(
    val name: String,
    val age: Int,
    val email: String? = null
)`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await extractKotlinSerializationContract("test");
    expect(result.total_classes).toBe(1);
    const contract = result.contracts[0]!;
    expect(contract.class_name).toBe("User");
    expect(contract.fields).toHaveLength(3);

    const nameField = contract.fields.find((f) => f.name === "name")!;
    expect(nameField.type).toBe("String");
    expect(nameField.nullable).toBe(false);
    expect(nameField.has_default).toBe(false);

    const emailField = contract.fields.find((f) => f.name === "email")!;
    expect(emailField.type).toBe("String");
    expect(emailField.nullable).toBe(true);
    expect(emailField.has_default).toBe(true);
  });

  it("respects @SerialName remapping", async () => {
    const index = makeIndex([
      makeSym({
        name: "ApiResponse",
        decorators: ["Serializable"],
        source: `@Serializable
data class ApiResponse(
    @SerialName("user_name") val userName: String,
    @SerialName("created_at") val createdAt: Long
)`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await extractKotlinSerializationContract("test");
    const fields = result.contracts[0]!.fields;
    expect(fields[0]!.name).toBe("userName");
    expect(fields[0]!.serial_name).toBe("user_name");
    expect(fields[1]!.name).toBe("createdAt");
    expect(fields[1]!.serial_name).toBe("created_at");
  });

  it("handles generic types (List<T>, Map<K,V>)", async () => {
    const index = makeIndex([
      makeSym({
        name: "PageResult",
        decorators: ["Serializable"],
        source: `@Serializable
data class PageResult(
    val items: List<User>,
    val metadata: Map<String, Any>,
    val tags: Set<String> = emptySet()
)`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await extractKotlinSerializationContract("test");
    const fields = result.contracts[0]!.fields;
    expect(fields[0]!.type).toBe("List<User>");
    expect(fields[1]!.type).toBe("Map<String, Any>");
    expect(fields[2]!.type).toBe("Set<String>");
    expect(fields[2]!.has_default).toBe(true);
  });

  it("skips non-Serializable classes", async () => {
    const index = makeIndex([
      makeSym({
        name: "Plain",
        source: `data class Plain(val x: Int)`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await extractKotlinSerializationContract("test");
    expect(result.total_classes).toBe(0);
  });

  it("returns empty for non-Kotlin project", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(makeIndex([]));
    const result = await extractKotlinSerializationContract("test");
    expect(result.contracts).toHaveLength(0);
  });
});
