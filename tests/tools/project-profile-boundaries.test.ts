import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCodeIndex = vi.hoisted(() => vi.fn());

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: mockGetCodeIndex,
}));

import {
  extractDependencyGraph,
  extractDependencyHealth,
  extractIdentity,
  extractKnownGotchas,
  extractTestConventions,
} from "../../src/tools/project-profile-extractors.js";
import { readJson } from "../../src/tools/project-profile-fs.js";
import { buildImporterCount } from "../../src/tools/project-profile-imports.js";
import { writeProfileToDisk } from "../../src/tools/project-profile-persistence.js";
import { buildConventionsSummary, buildSummary } from "../../src/tools/project-profile-summary.js";
import type { CodeIndex } from "../../src/types.js";
import { analyzeProject, resetAnalyzeProjectCacheForTesting } from "../../src/tools/project-tools.js";
import type { ProjectProfile } from "../../src/tools/project-tools.js";

const execFileAsync = promisify(execFile);

describe("project profile module boundaries", () => {
  beforeEach(() => {
    mockGetCodeIndex.mockReset();
    resetAnalyzeProjectCacheForTesting();
  });

  it("keeps project-tools free of static index-tools imports", async () => {
    const source = await readFile(join(process.cwd(), "src/tools/project-tools.ts"), "utf-8");

    expect(source).not.toMatch(/from\s+["']\.\/index-tools\.js["']/);
    expect(source).toContain('await import("./index-tools.js")');
  });

  it("analyzeProject resolves getCodeIndex through the dynamic import boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-boundary-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "dynamic-boundary", devDependencies: { vitest: "^3.0.0" } }));
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
      await writeFile(join(root, "src/index.ts"), "export const value = 1;");

      const index = {
        repo: "local/dynamic-boundary",
        root,
        files: [
          { path: "package.json", language: "json", symbol_count: 0, last_modified: 1 },
          { path: "tsconfig.json", language: "json", symbol_count: 0, last_modified: 1 },
          { path: "src/index.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        ],
        symbols: [],
        created_at: 1,
        updated_at: 1783350000000,
        symbol_count: 1,
        file_count: 3,
      } as CodeIndex;
      mockGetCodeIndex.mockResolvedValueOnce(index);

      const summary = await analyzeProject("local/dynamic-boundary", { force: true });

      expect(mockGetCodeIndex).toHaveBeenCalledWith("local/dynamic-boundary");
      expect(summary.stack).toEqual({
        framework: null,
        language: "typescript",
        test_runner: "vitest",
        package_manager: null,
        monorepo: false,
      });
      expect(summary.profile_path).toBe(join(root, ".zuvo", "project-profile.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds profile summaries from extracted profile data", () => {
    const profile: ProjectProfile = {
      version: "1.0",
      generated_at: "2026-07-06T00:00:00.000Z",
      generated_by: {
        tool: "codesift",
        tool_version: "1.0.0",
        extractor_versions: { typescript: "3.0.0" },
      },
      compatible_with: ">=1.0, <2.0",
      status: "complete",
      stack: {
        framework: "hono",
        framework_version: "4.0.0",
        language: "typescript",
        language_version: "ES2022",
        test_runner: "vitest",
        package_manager: "npm",
        build_tool: null,
        monorepo: null,
        detected_from: ["package.json:dependencies.hono"],
      },
      file_classifications: {
        critical: [{ path: "src/server.ts", code_type: "ORCHESTRATOR", dependents_count: 3, has_tests: true }],
        important: { count: 2, by_type: { SERVICE: 2 }, top: [] },
        routine: { count: 4, by_type: { TEST: 4 } },
      },
      dependency_health: {
        total: 3,
        prod: 1,
        dev: 2,
        key_versions: { hono: "^4.0.0", vitest: "^3.0.0" },
      },
      generation_metadata: {
        files_analyzed: 7,
        files_skipped: 0,
        skip_reasons: {},
        duration_ms: 12,
      },
    };

    const summary = buildSummary(profile, "/tmp/profile.json");

    expect(summary.profile_path).toBe("/tmp/profile.json");
    expect(summary.stack).toEqual({
      framework: "hono",
      language: "typescript",
      test_runner: "vitest",
      package_manager: "npm",
      monorepo: false,
    });
    expect(summary.file_counts).toEqual({ critical: 1, important: 2, routine: 4, total_analyzed: 7 });
    expect(summary.dependency_health).toEqual({ total: 3, prod: 1, dev: 2, key_count: 2 });
  });

  it("uses summary defaults when optional profile sections are omitted", () => {
    const profile: ProjectProfile = {
      version: "1.0",
      generated_at: "2026-07-06T00:00:00.000Z",
      generated_by: { tool: "codesift", tool_version: "1.0.0", extractor_versions: {} },
      compatible_with: ">=1.0, <2.0",
      status: "failed",
      generation_metadata: {
        files_analyzed: 0,
        files_skipped: 1,
        skip_reasons: { no_index: 1 },
        duration_ms: 5,
      },
    };

    const summary = buildSummary(profile, "(not written)");

    expect(summary.stack).toEqual({
      framework: null,
      language: "unknown",
      test_runner: null,
      package_manager: null,
      monorepo: false,
    });
    expect(summary.file_counts).toEqual({ critical: 0, important: 0, routine: 0, total_analyzed: 0 });
    expect(summary.conventions_summary).toBeNull();
    expect(summary.dependency_health).toBeNull();
  });

  it("summarizes each framework convention profile shape", () => {
    const cases: Array<[string, Partial<ProjectProfile>, Record<string, unknown>]> = [
      ["hono", {
        conventions: {
          middleware_chains: [{ scope: "app", file: "src/app.ts", chain: [] }],
          rate_limits: [{ file: "src/app.ts", line: 1, max: 10, window: 60, applied_to_path: "/api", method: "GET" }],
          route_mounts: [{ file: "src/app.ts", line: 2, mount_path: "/api", imported_from: "./routes", exported_as: "routes" }],
          auth_patterns: { auth_middleware: "auth", groups: { admin: { requires_auth: true, middleware: ["auth"] } } },
        },
      }, { middleware_chains: 1, rate_limits: 1, route_mounts: 1, auth_groups: 1 }],
      ["nestjs", {
        nest_conventions: {
          modules: [{ name: "AppModule", file: "app.module.ts", line: 1, imported_from: null, is_global: false }],
          global_guards: [],
          global_filters: [],
          global_pipes: [],
          global_interceptors: [],
          controllers: ["AppController"],
          throttler: null,
          middleware_chains: [],
        },
      }, {
        type: "nestjs",
        modules: 1,
        global_guards: 0,
        global_filters: 0,
        global_interceptors: 0,
        controllers: 1,
        has_throttler: false,
      }],
      ["nextjs", {
        next_conventions: {
          pages: [{ path: "app/page.tsx", type: "page" }],
          middleware: null,
          api_routes: [{ path: "app/api/users/route.ts", methods: ["GET"], file: "app/api/users/route.ts" }],
          services_count: 2,
          inngest_functions: ["src/inngest/sync.ts"],
          webhooks: ["app/api/webhook/route.ts"],
          client_component_count: 1,
          server_action_count: 1,
          config: { app_router: true, src_dir: true, i18n: false },
        },
      }, {
        type: "nextjs",
        pages: 1,
        api_routes: 1,
        services: 2,
        inngest_functions: 1,
        webhooks: 1,
        has_middleware: false,
        app_router: true,
        i18n: false,
      }],
      ["php", {
        php_conventions: {
          controllers: ["SiteController"],
          models: ["User"],
          migrations_count: 2,
          middleware: ["AuthMiddleware"],
          framework_type: "php",
        },
      }, { type: "php", controllers: 1, middleware: 1, models: 1, migrations: 2 }],
    ];

    for (const [, patch, expected] of cases) {
      expect(buildConventionsSummary(patch as ProjectProfile)).toEqual(expected);
    }
  });
});

describe("project profile extractors", () => {
  it("strips credentials from persisted git remote identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-identity-"));
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      await execFileAsync("git", ["remote", "add", "origin", "https://user:p@ssword@github.com/org/repo.git"], { cwd: root });

      const identity = await extractIdentity(root);

      expect(identity.git_remote).toBe("https://github.com/org/repo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes project profiles atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-write-"));
    try {
      const profile = {
        version: "1.0",
        generated_at: "2026-07-06T00:00:00.000Z",
        generated_by: { tool: "codesift", tool_version: "1.0.0", extractor_versions: {} },
        compatible_with: ">=1.0, <2.0",
        status: "complete",
        generation_metadata: { files_analyzed: 0, files_skipped: 0, skip_reasons: {}, duration_ms: 1 },
      } as ProjectProfile;

      const profilePath = await writeProfileToDisk(root, profile);
      const persisted = JSON.parse(await readFile(profilePath, "utf-8")) as ProjectProfile;
      const leftovers = (await readdir(join(root, ".zuvo"))).filter((name) => name.endsWith(".tmp"));

      expect(persisted.status).toBe("complete");
      expect(leftovers).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts imports from full file source when symbols omit module prologues", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-imports-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/entry.ts"), [
        "/** moved from \"./fake\" */",
        'const text = "require(\\"./fake\\")";',
        'import "dotenv/config";',
        'const rows = await sql`SELECT * from "fake"`;',
        'const obj = {}; // require("./fake")',
        "import {",
        "  aliased,",
        '} from "@/aliased";',
        'import { hub } from "./hub";',
        'import { runtime } from "./runtime.ts";',
        'export { reexported } from "./reexport";',
        'export * from "~/star";',
        'const lazy = import("./lazy.js");',
        "export const value = hub;",
      ].join("\n"));
      await writeFile(join(root, "src/hub.ts"), "export const hub = 1;\n");
      await writeFile(join(root, "src/aliased.ts"), "export const aliased = 1;\n");
      await writeFile(join(root, "src/reexport.ts"), "export const reexported = 1;\n");
      await writeFile(join(root, "src/star.ts"), "export const star = 1;\n");
      await writeFile(join(root, "src/runtime.js"), "export const runtime = 1;\n");
      await writeFile(join(root, "src/lazy.ts"), "export const lazy = 1;\n");
      await writeFile(join(root, "src/fake.ts"), "export const fake = 1;\n");
      const index = {
        repo: "local/test",
        root,
        files: [
          { path: "src/entry.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "src/hub.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "src/aliased.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "src/reexport.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "src/star.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "src/runtime.js", language: "javascript", symbol_count: 1, last_modified: 1 },
          { path: "src/lazy.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "src/fake.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        ],
        symbols: [],
        created_at: 1,
        updated_at: 1,
        symbol_count: 2,
        file_count: 2,
      } as CodeIndex;

      const importerCount = await buildImporterCount(index);
      expect(importerCount.get("src/hub.ts")).toBe(1);
      expect(importerCount.get("src/aliased.ts")).toBe(1);
      expect(importerCount.get("src/reexport.ts")).toBe(1);
      expect(importerCount.get("src/star.ts")).toBe(1);
      expect(importerCount.get("src/runtime.js")).toBe(1);
      expect(importerCount.get("src/lazy.ts")).toBe(1);
      expect(importerCount.get("src/fake.ts")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats malformed JSON as missing for graceful profile detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-json-"));
    try {
      await writeFile(join(root, "package.json"), "{bad json");

      await expect(readJson(join(root, "package.json"))).resolves.toBeNull();
      await expect(readJson(join(root, "missing.json"))).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts dependency graph and known gotchas independently of project-tools", () => {
    const index = {
      repo: "local/test",
      root: "/tmp/test",
      files: [
        { path: "src/index.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        { path: "server.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        { path: "src/a.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        { path: "src/other.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        { path: "src/b/index.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        { path: "src/view.test.tsx", language: "typescript", symbol_count: 1, last_modified: 1 },
        { path: ".eslintignore", language: "text", symbol_count: 0, last_modified: 1 },
      ],
      symbols: [
        {
          name: "loadEnv",
          kind: "function",
          file: "src/a.ts",
          line: 1,
          source: 'import "./b"; export function loadEnv() { return process.env.API_URL; }',
        },
        {
          name: "loadOtherEnv",
          kind: "function",
          file: "src/other.ts",
          line: 1,
          source: "export function loadOtherEnv() { return process.env.OTHER_URL; }",
        },
        {
          name: "usesEnvInTest",
          kind: "function",
          file: "src/view.test.tsx",
          line: 1,
          source: "export function usesEnvInTest() { return process.env.TEST_URL; }",
        },
      ],
      created_at: 1,
      updated_at: 1,
      symbol_count: 1,
      file_count: 4,
    } as CodeIndex;

    const graph = extractDependencyGraph(index);
    const gotchas = extractKnownGotchas(index);

    expect(graph.entry_points).toEqual(["src/index.ts", "server.ts"]);
    expect(graph.leaf_modules).toContain("src/a.ts");
    expect(graph.leaf_modules).not.toContain("src/b/index.ts");
    expect(gotchas.auto_detected.map((gotcha) => gotcha.gotcha)).toEqual([
      "scattered process.env access outside config module",
      ".eslintignore present — some files bypass linting",
    ]);
    expect(gotchas.auto_detected[0]?.evidence).toEqual(["src/a.ts", "src/other.ts"]);
  });

  it("extracts dependency health from package manifests and returns null without manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-health-"));
    try {
      expect(await extractDependencyHealth(root)).toBeNull();

      await writeFile(join(root, "pyproject.toml"), "[project]\ndependencies = [\"fastapi\"]\n");
      expect(await extractDependencyHealth(root)).toEqual({
        total: 0,
        prod: 0,
        dev: 0,
        key_versions: {},
      });

      await writeFile(join(root, "package.json"), JSON.stringify({
        dependencies: { hono: "^4.0.0" },
        devDependencies: { typescript: "^5.7.0", vitest: "^3.0.0", unknown: "1.0.0" },
      }));

      expect(await extractDependencyHealth(root)).toEqual({
        total: 4,
        prod: 1,
        dev: 3,
        key_versions: {
          hono: "^4.0.0",
          typescript: "^5.7.0",
          vitest: "^3.0.0",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates test setup convention files", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-tests-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }));
      const index = {
        repo: "local/test",
        root,
        files: [
          { path: "vitest.setup.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
          { path: "src/service.test.ts", language: "typescript", symbol_count: 1, last_modified: 1 },
        ],
        symbols: [],
        created_at: 1,
        updated_at: 1,
        symbol_count: 2,
        file_count: 2,
      } as CodeIndex;

      const conventions = await extractTestConventions(root, index);

      expect(conventions.setup_files).toEqual(["vitest.setup.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to component-style test files when sampling mock conventions", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-project-profile-component-tests-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }));
      await writeFile(join(root, "src/Button.test.tsx"), 'vi.mock("./api");\n');
      const index = {
        repo: "local/test",
        root,
        files: [
          { path: "src/Button.test.tsx", language: "typescript", symbol_count: 1, last_modified: 1 },
        ],
        symbols: [],
        created_at: 1,
        updated_at: 1,
        symbol_count: 1,
        file_count: 1,
      } as CodeIndex;

      const conventions = await extractTestConventions(root, index);

      expect(conventions.mock_style).toBe("vi.mock");
      expect(conventions.common_mocks).toEqual(["./api"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
