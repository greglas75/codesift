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

function makeFile(path: string): FileEntry {
  return { path, language: "typescript", symbol_count: 0, last_modified: 0 };
}

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
