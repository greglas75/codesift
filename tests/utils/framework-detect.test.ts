import { describe, it, expect } from "vitest";
import { detectFrameworks, isFrameworkEntryPoint } from "../../src/utils/framework-detect.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

function makeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "test",
    root: "/test",
    symbols: [],
    files: [],
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

function makeFile(path: string, language?: string): FileEntry {
  return { path, language: language ?? "typescript", symbol_count: 0, last_modified: 0 };
}

describe("detectFrameworks — Astro", () => {
  it("returns 'astro' when a symbol source imports from 'astro' (dependencies signal)", () => {
    const index = makeIndex({
      symbols: [
        {
          name: "MyLayout",
          kind: "function",
          file: "src/layouts/Layout.astro",
          start_line: 1,
          end_line: 10,
          source: "import { Code } from 'astro:components';",
        },
      ],
    });
    const result = detectFrameworks(index);
    expect(result.has("astro")).toBe(true);
  });

  it("returns 'astro' when a symbol source imports from \"astro\" (devDependencies signal)", () => {
    const index = makeIndex({
      symbols: [
        {
          name: "MyComponent",
          kind: "function",
          file: "src/components/Card.astro",
          start_line: 1,
          end_line: 5,
          source: 'import type { ImageMetadata } from "astro";',
        },
      ],
    });
    const result = detectFrameworks(index);
    expect(result.has("astro")).toBe(true);
  });

  it("returns 'astro' when any file has .astro extension", () => {
    const index = makeIndex({
      files: [makeFile("src/pages/index.astro", "astro")],
    });
    const result = detectFrameworks(index);
    expect(result.has("astro")).toBe(true);
  });
});

describe("isFrameworkEntryPoint — Astro", () => {
  const astroFrameworks = new Set<import("../../src/utils/framework-detect.js").Framework>(["astro", "test"]);

  it("returns true for .astro files in src/pages/", () => {
    expect(
      isFrameworkEntryPoint({ name: "default", file: "src/pages/index.astro" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for .ts route files in src/pages/", () => {
    expect(
      isFrameworkEntryPoint({ name: "GET", file: "src/pages/api/users.ts" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for getStaticPaths symbol", () => {
    expect(
      isFrameworkEntryPoint({ name: "getStaticPaths", file: "src/pages/blog/[slug].astro" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for prerender symbol", () => {
    expect(
      isFrameworkEntryPoint({ name: "prerender", file: "src/pages/about.astro" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for GET symbol in an Astro project", () => {
    expect(
      isFrameworkEntryPoint({ name: "GET", file: "src/pages/api/data.ts" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for POST symbol in an Astro project", () => {
    expect(
      isFrameworkEntryPoint({ name: "POST", file: "src/pages/api/data.ts" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns false for non-pages file with arbitrary name", () => {
    expect(
      isFrameworkEntryPoint({ name: "helperFn", file: "src/lib/utils.ts" }, astroFrameworks),
    ).toBe(false);
  });
});

describe("detectFrameworks — Next.js broadened detection", () => {
  it("detects nextjs when only pages/index.tsx exists", () => {
    const index = makeIndex({
      files: [makeFile("pages/index.tsx")],
    });
    const result = detectFrameworks(index);
    expect(result.has("nextjs")).toBe(true);
  });

  it("detects nextjs when app/page.tsx + app/layout.tsx exist", () => {
    const index = makeIndex({
      files: [makeFile("app/page.tsx"), makeFile("app/layout.tsx")],
    });
    const result = detectFrameworks(index);
    expect(result.has("nextjs")).toBe(true);
  });

  it("detects nextjs when only next.config.ts at root exists", () => {
    const index = makeIndex({
      files: [makeFile("next.config.ts")],
    });
    const result = detectFrameworks(index);
    expect(result.has("nextjs")).toBe(true);
  });

  it("does NOT detect nextjs for TanStack Router fixture", () => {
    const index = makeIndex({
      files: [
        makeFile("app/routes/__root.tsx"),
        makeFile("app/routes/index.tsx"),
        makeFile("src/main.tsx"),
      ],
    });
    const result = detectFrameworks(index);
    expect(result.has("nextjs")).toBe(false);
  });

  it("does NOT detect nextjs for SvelteKit", () => {
    const index = makeIndex({
      files: [makeFile("src/routes/+page.svelte")],
    });
    const result = detectFrameworks(index);
    expect(result.has("nextjs")).toBe(false);
  });

  it("detects nextjs for App Router with API route", () => {
    const index = makeIndex({
      files: [makeFile("app/api/users/route.ts")],
    });
    const result = detectFrameworks(index);
    expect(result.has("nextjs")).toBe(true);
  });

  it("detects hono for Hono project", () => {
    const index = makeIndex({
      symbols: [
        {
          name: "app",
          kind: "const",
          file: "src/index.ts",
          start_line: 1,
          end_line: 5,
          source: "import { Hono } from 'hono';\nconst app = new Hono();",
        },
      ],
      files: [makeFile("src/index.ts")],
    });
    const result = detectFrameworks(index);
    expect(result.has("hono")).toBe(true);
  });

  it("isFrameworkEntryPoint recognizes Hono handler from model", () => {
    const symbol = { name: "getUserHandler", file: "/repo/src/routes/users.ts" };
    const honoModel = {
      entry_file: "/repo/src/index.ts",
      app_variables: {},
      routes: [{
        method: "GET" as const,
        path: "/users/:id",
        raw_path: "/users/:id",
        file: "/repo/src/routes/users.ts",
        line: 5,
        owner_var: "usersRouter",
        handler: { name: "getUserHandler", inline: false, file: "/repo/src/routes/users.ts", line: 5 },
        inline_middleware: [],
        validators: [],
      }],
      mounts: [], middleware_chains: [], context_vars: [], openapi_routes: [],
      rpc_exports: [], runtime: "unknown" as const, env_bindings: [],
      files_used: ["/repo/src/routes/users.ts"],
      extraction_status: "complete" as const, skip_reasons: {},
    };
    const frameworks = new Set<"hono">(["hono"]);
    expect(isFrameworkEntryPoint(symbol, frameworks as never, honoModel)).toBe(true);
  });

  it("detects nestjs NOT nextjs for NestJS project", () => {
    const index = makeIndex({
      symbols: [
        {
          name: "AppModule",
          kind: "class",
          file: "src/app.module.ts",
          start_line: 1,
          end_line: 10,
          source: "import { Module } from '@nestjs/common';",
        },
      ],
      files: [makeFile("src/app.module.ts")],
    });
    const result = detectFrameworks(index);
    expect(result.has("nestjs")).toBe(true);
    expect(result.has("nextjs")).toBe(false);
  });
});

describe("detectFrameworks — Kotlin/Android", () => {
  it("adds 'kotlin-android' when any file has .kt extension", () => {
    const index = makeIndex({
      files: [makeFile("app/src/main/java/com/x/Foo.kt", "kotlin")],
    });
    const frameworks = detectFrameworks(index);
    expect(frameworks.has("kotlin-android")).toBe(true);
  });

  it("adds 'kotlin-android' for .kts build scripts", () => {
    const index = makeIndex({
      files: [makeFile("build.gradle.kts", "kotlin")],
    });
    const frameworks = detectFrameworks(index);
    expect(frameworks.has("kotlin-android")).toBe(true);
  });

  it("does NOT add 'kotlin-android' for a pure TypeScript repo", () => {
    const index = makeIndex({
      files: [makeFile("src/a.ts", "typescript")],
    });
    const frameworks = detectFrameworks(index);
    expect(frameworks.has("kotlin-android")).toBe(false);
  });
});

describe("isFrameworkEntryPoint — Kotlin annotation whitelist", () => {
  const kotlinFrameworks = new Set(["kotlin-android"]) as Set<never>;

  function kotlinSymbol(name: string, decorators: string[] = [], source?: string) {
    return {
      name,
      file: "app/src/main/java/com/x/UserViewModel.kt",
      decorators: decorators.length > 0 ? decorators : undefined,
      ...(source !== undefined ? { source } : {}),
    };
  }

  it("treats @HiltViewModel as a framework entry point (decorators field)", () => {
    const symbol = kotlinSymbol("UserViewModel", ["HiltViewModel"]);
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("treats @Composable as a framework entry point", () => {
    const symbol = kotlinSymbol("HomeScreen", ["Composable"]);
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("treats @Preview as a framework entry point", () => {
    const symbol = kotlinSymbol("HomeScreenPreview", ["Preview"]);
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("treats @Serializable as a framework entry point", () => {
    const symbol = kotlinSymbol("User", ["Serializable"]);
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("treats @Entity as a framework entry point (Room)", () => {
    const symbol = kotlinSymbol("UserEntity", ["Entity"]);
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("treats @Dao as a framework entry point (Room)", () => {
    const symbol = kotlinSymbol("UserDao", ["Dao"]);
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("treats @Inject + @Provides as framework entry points (Hilt/Dagger)", () => {
    expect(isFrameworkEntryPoint(kotlinSymbol("repo", ["Inject"]), kotlinFrameworks)).toBe(true);
    expect(isFrameworkEntryPoint(kotlinSymbol("provideRepo", ["Provides"]), kotlinFrameworks)).toBe(true);
  });

  it("treats @Test methods as framework entry points (JUnit)", () => {
    const symbol = kotlinSymbol("shouldValidateEmail", ["Test"]);
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("does NOT treat a plain Kotlin class without annotations as entry point", () => {
    const symbol = kotlinSymbol("UnusedHelper", [], "class UnusedHelper { fun foo() {} }");
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(false);
  });

  it("falls back to source scan when decorators field is missing", () => {
    // Legacy/edge path: symbol.source contains the annotation text but the
    // extractor didn't populate `decorators`. The source-scan fallback should
    // still recognize it.
    const symbol = kotlinSymbol("LegacyViewModel", [], "@HiltViewModel\nclass LegacyViewModel");
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(true);
  });

  it("does NOT false-match @HiltViewModelX (word-boundary check)", () => {
    const symbol = kotlinSymbol("Foo", [], "@HiltViewModelExtra\nclass Foo");
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(false);
  });

  it("does NOT apply Kotlin whitelist to non-.kt files", () => {
    const symbol = {
      name: "UserViewModel",
      file: "src/components/UserViewModel.tsx",
      decorators: ["HiltViewModel"], // wrong file type
    };
    expect(isFrameworkEntryPoint(symbol, kotlinFrameworks)).toBe(false);
  });

  it("is a no-op when kotlin-android framework is not present", () => {
    const nonKotlin = new Set() as Set<never>;
    const symbol = kotlinSymbol("UserViewModel", ["HiltViewModel"]);
    expect(isFrameworkEntryPoint(symbol, nonKotlin)).toBe(false);
  });
});
