import { describe, it, expect } from "vitest";
import {
  extractKotlinImports,
  resolveKotlinImport,
  buildKotlinFilesByBasename,
} from "../../src/utils/import-graph.js";
import type { CodeIndex } from "../../src/types.js";

describe("extractKotlinImports", () => {
  it("extracts a simple fully-qualified import", () => {
    const source = `package com.example

import com.example.service.UserService

class App {}
`;
    expect(extractKotlinImports(source)).toEqual(["com.example.service.UserService"]);
  });

  it("extracts multiple imports", () => {
    const source = `import com.example.User
import com.example.service.UserService
import com.example.repo.UserRepository
`;
    const imports = extractKotlinImports(source);
    expect(imports).toContain("com.example.User");
    expect(imports).toContain("com.example.service.UserService");
    expect(imports).toContain("com.example.repo.UserRepository");
  });

  it("extracts wildcard imports", () => {
    const source = `import com.example.*`;
    expect(extractKotlinImports(source)).toEqual(["com.example.*"]);
  });

  it("extracts import with alias (drops the alias)", () => {
    const source = `import com.example.VeryLongName as VLN`;
    expect(extractKotlinImports(source)).toEqual(["com.example.VeryLongName"]);
  });

  it("deduplicates repeated imports", () => {
    const source = `import com.example.User
import com.example.User
`;
    expect(extractKotlinImports(source)).toEqual(["com.example.User"]);
  });

  it("returns empty array for source without imports", () => {
    expect(extractKotlinImports("class Foo {}")).toEqual([]);
  });
});

describe("buildKotlinFilesByBasename", () => {
  it("groups Kotlin files by basename", () => {
    const index: CodeIndex = {
      repo: "test",
      root: "/tmp/test",
      files: [
        { path: "src/main/kotlin/com/example/service/UserService.kt", language: "kotlin", symbol_count: 0, last_modified: 0, mtime_ms: 0 },
        { path: "src/main/kotlin/com/example/repo/UserRepository.kt", language: "kotlin", symbol_count: 0, last_modified: 0, mtime_ms: 0 },
        { path: "src/main/kotlin/com/other/UserService.kt", language: "kotlin", symbol_count: 0, last_modified: 0, mtime_ms: 0 },
        { path: "src/main/ts/Config.ts", language: "typescript", symbol_count: 0, last_modified: 0, mtime_ms: 0 },
      ],
      symbols: [],
    };

    const map = buildKotlinFilesByBasename(index);
    expect(map.get("UserService")).toHaveLength(2);
    expect(map.get("UserRepository")).toHaveLength(1);
    expect(map.get("Config")).toBeUndefined(); // .ts excluded
  });

  it("handles .kts files", () => {
    const index: CodeIndex = {
      repo: "test",
      root: "/tmp/test",
      files: [
        { path: "build.gradle.kts", language: "kotlin", symbol_count: 0, last_modified: 0, mtime_ms: 0 },
      ],
      symbols: [],
    };
    const map = buildKotlinFilesByBasename(index);
    expect(map.get("build.gradle")).toHaveLength(1);
  });
});

describe("resolveKotlinImport", () => {
  const kotlinFiles = new Map<string, string[]>([
    ["UserService", ["src/main/kotlin/com/example/service/UserService.kt"]],
    ["UserRepository", ["src/main/kotlin/com/example/repo/UserRepository.kt"]],
    ["Duplicate", [
      "src/main/kotlin/com/example/a/Duplicate.kt",
      "src/main/kotlin/com/example/b/Duplicate.kt",
    ]],
  ]);

  it("resolves a fully-qualified name to the matching file", () => {
    expect(
      resolveKotlinImport("com.example.service.UserService", kotlinFiles),
    ).toBe("src/main/kotlin/com/example/service/UserService.kt");
  });

  it("prefers file whose path matches the package path", () => {
    expect(
      resolveKotlinImport("com.example.a.Duplicate", kotlinFiles),
    ).toBe("src/main/kotlin/com/example/a/Duplicate.kt");
    expect(
      resolveKotlinImport("com.example.b.Duplicate", kotlinFiles),
    ).toBe("src/main/kotlin/com/example/b/Duplicate.kt");
  });

  it("returns null for wildcard imports", () => {
    expect(resolveKotlinImport("com.example.*", kotlinFiles)).toBeNull();
  });

  it("returns null for kotlin stdlib imports", () => {
    expect(resolveKotlinImport("kotlin.collections.List", kotlinFiles)).toBeNull();
    expect(resolveKotlinImport("kotlin.io.println", kotlinFiles)).toBeNull();
  });

  it("returns null for java/javax imports", () => {
    expect(resolveKotlinImport("java.util.List", kotlinFiles)).toBeNull();
    expect(resolveKotlinImport("javax.inject.Inject", kotlinFiles)).toBeNull();
  });

  it("returns null for android/androidx imports", () => {
    expect(resolveKotlinImport("android.content.Context", kotlinFiles)).toBeNull();
    expect(resolveKotlinImport("androidx.compose.runtime.Composable", kotlinFiles)).toBeNull();
  });

  it("returns null for org.junit imports", () => {
    expect(resolveKotlinImport("org.junit.jupiter.api.Test", kotlinFiles)).toBeNull();
  });

  it("returns null for unknown simple names", () => {
    expect(resolveKotlinImport("com.example.NotFound", kotlinFiles)).toBeNull();
  });

  it("returns null for single-segment names (not FQ)", () => {
    expect(resolveKotlinImport("UserService", kotlinFiles)).toBeNull();
  });

  it("falls back to single candidate even if package path doesn't match", () => {
    expect(
      resolveKotlinImport("com.other.location.UserRepository", kotlinFiles),
    ).toBe("src/main/kotlin/com/example/repo/UserRepository.kt");
  });
});
