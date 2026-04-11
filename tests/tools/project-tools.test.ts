import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock index-tools so analyzeProject tests don't need a real registry
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";

import {
  detectStack,
  classifyFiles,
  extractHonoConventions,
  extractNestConventions,
  getExtractorVersions,
  EXTRACTOR_VERSIONS,
  analyzeProject,
  buildConventionsSummary,
} from "../../src/tools/project-tools.js";
import type { ProfileSummary, ProjectProfile } from "../../src/tools/project-tools.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), "codesift-project-tools-test");

async function createFixture(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(TMP_ROOT, name, Date.now().toString());
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  return dir;
}

function mockIndex(root: string, files: string[]): CodeIndex {
  return {
    repo: "local/test",
    root,
    symbols: [],
    files: files.map((f) => ({
      path: f,
      language: f.endsWith(".ts") ? "typescript" : "javascript",
      symbol_count: 3,
      last_modified: Date.now(),
    })),
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: files.length * 3,
    file_count: files.length,
  };
}

// ---------------------------------------------------------------------------
// Stack Detector Tests (Task 3)
// ---------------------------------------------------------------------------

describe("detectStack", () => {
  it("detects Hono project", async () => {
    const root = await createFixture("hono", {
      "package.json": JSON.stringify({
        name: "test-hono",
        dependencies: { hono: "^4.12.1" },
        devDependencies: { vitest: "^3.0.0" },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022" } }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
    });

    const stack = await detectStack(root);
    expect(stack.framework).toBe("hono");
    expect(stack.framework_version).toBe("4.12.1");
    expect(stack.language).toBe("typescript");
    expect(stack.test_runner).toBe("vitest");
    expect(stack.package_manager).toBe("pnpm");
    expect(stack.detected_from).toContain("package.json:dependencies.hono");
  });

  it("detects NestJS project", async () => {
    const root = await createFixture("nestjs", {
      "package.json": JSON.stringify({
        dependencies: { "@nestjs/core": "^10.0.0" },
      }),
    });
    const stack = await detectStack(root);
    expect(stack.framework).toBe("nestjs");
  });

  it("detects React project", async () => {
    const root = await createFixture("react", {
      "package.json": JSON.stringify({
        dependencies: { react: "^18.0.0" },
      }),
    });
    const stack = await detectStack(root);
    expect(stack.framework).toBe("react");
  });

  it("returns null framework when none detected", async () => {
    const root = await createFixture("empty", {
      "package.json": JSON.stringify({ name: "plain", dependencies: {} }),
    });
    const stack = await detectStack(root);
    expect(stack.framework).toBeNull();
  });

  it("detects monorepo with turborepo", async () => {
    const root = await createFixture("monorepo", {
      "package.json": JSON.stringify({
        name: "monorepo",
        dependencies: { hono: "^4.0.0" },
        workspaces: ["apps/*", "packages/*"],
      }),
      "turbo.json": JSON.stringify({ tasks: {} }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
    });
    const stack = await detectStack(root);
    expect(stack.monorepo).toEqual({
      tool: "turborepo",
      workspaces: ["apps/*", "packages/*"],
    });
  });

  it("detects test runner from devDependencies", async () => {
    const root = await createFixture("jest", {
      "package.json": JSON.stringify({
        devDependencies: { jest: "^29.0.0" },
      }),
    });
    const stack = await detectStack(root);
    expect(stack.test_runner).toBe("jest");
  });

  it("detects package manager from lock file", async () => {
    const root = await createFixture("yarn", {
      "package.json": JSON.stringify({ name: "test" }),
      "yarn.lock": "# yarn lockfile\n",
    });
    const stack = await detectStack(root);
    expect(stack.package_manager).toBe("yarn");
  });

  it("scans workspace package.json in monorepo when root has no framework", async () => {
    const root = await createFixture("monorepo-scan", {
      "package.json": JSON.stringify({
        name: "monorepo",
        workspaces: ["apps/*", "packages/*"],
      }),
      "turbo.json": JSON.stringify({ tasks: {} }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "apps/api/package.json": JSON.stringify({
        name: "api",
        dependencies: { hono: "^4.12.1" },
        devDependencies: { vitest: "^3.0.0" },
      }),
      "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022" } }),
      "apps/web/package.json": JSON.stringify({
        name: "web",
        dependencies: { astro: "^4.0.0" },
      }),
    });
    const stack = await detectStack(root);
    expect(stack.framework).toBe("hono");
    expect(stack.framework_version).toBe("4.12.1");
    expect(stack.test_runner).toBe("vitest");
    expect(stack.language).toBe("typescript");
    expect(stack.detected_from).toContain("apps/api/package.json:dependencies.hono");
  });

  it("detects TypeScript from tsconfig.base.json", async () => {
    const root = await createFixture("tsconfig-base", {
      "package.json": JSON.stringify({ name: "test" }),
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { target: "ES2022" } }),
    });
    const stack = await detectStack(root);
    expect(stack.language).toBe("typescript");
    expect(stack.detected_from).toContain("tsconfig.base.json");
  });
});

// ---------------------------------------------------------------------------
// File Classifier Tests (Task 4)
// ---------------------------------------------------------------------------

describe("classifyFiles", () => {
  it("classifies app.ts as critical ORCHESTRATOR", async () => {
    const index = mockIndex("/tmp/test", [
      "apps/api/src/app.ts",
      "apps/api/src/services/contest.service.ts",
      "apps/api/src/utils/helpers.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.critical.some((f) => f.path === "apps/api/src/app.ts")).toBe(true);
    const appFile = result.critical.find((f) => f.path === "apps/api/src/app.ts")!;
    expect(appFile.code_type).toBe("ORCHESTRATOR");
  });

  it("classifies middleware as critical", async () => {
    const index = mockIndex("/tmp/test", ["src/middleware/auth.ts"]);
    const result = classifyFiles(index);
    expect(result.critical.some((f) => f.path === "src/middleware/auth.ts")).toBe(true);
  });

  it("classifies service files as important", async () => {
    const index = mockIndex("/tmp/test", [
      "apps/api/src/services/contest.service.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.important.count).toBeGreaterThan(0);
    expect(result.important.top.some((f) => f.path.includes("contest.service.ts"))).toBe(true);
  });

  it("classifies utils as routine", async () => {
    const index = mockIndex("/tmp/test", [
      "src/utils/constants.ts",
      "src/utils/helpers.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.routine.count).toBeGreaterThan(0);
  });

  it("produces aggregate counts for routine tier", async () => {
    const index = mockIndex("/tmp/test", [
      "src/utils/a.ts",
      "src/utils/b.ts",
      "src/types/index.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.routine.by_type).toBeDefined();
    expect(typeof result.routine.count).toBe("number");
  });

  it("detects has_tests flag", async () => {
    const index = mockIndex("/tmp/test", [
      "src/app.ts",
      "src/app.test.ts",
    ]);
    const result = classifyFiles(index);
    const appFile = result.critical.find((f) => f.path === "src/app.ts");
    expect(appFile?.has_tests).toBe(true);
  });

  it("classifies shallow index.ts as critical (entry point)", async () => {
    const index = mockIndex("/tmp/test", [
      "src/index.ts",
      "apps/api/src/index.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.critical.some((f) => f.path === "src/index.ts")).toBe(true);
    expect(result.critical.some((f) => f.path === "apps/api/src/index.ts")).toBe(true);
  });

  it("does NOT classify deep index.ts as critical (barrel re-export)", async () => {
    const index = mockIndex("/tmp/test", [
      "app/projects/components/AgentReview/index.ts",
      "app/projects/components/context/index.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.critical.some((f) => f.path.includes("AgentReview"))).toBe(false);
    expect(result.critical.some((f) => f.path.includes("context/index"))).toBe(false);
  });

  it("skips test files from classification", async () => {
    const index = mockIndex("/tmp/test", [
      "src/app.test.ts",
      "src/services/order.spec.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.critical.length).toBe(0);
    expect(result.important.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hono Extractor Tests (Tasks 5, 6, 7)
// ---------------------------------------------------------------------------

const HONO_APP_SOURCE = `import { Hono } from "hono";
import { requestId } from "./middleware/request-id.js";
import { errorHandler } from "./middleware/error.js";
import { corsMiddleware } from "./middleware/cors.js";
import { dbMiddleware } from "./middleware/db.js";
import { clerkAuth } from "./middleware/auth.js";
import { tenantResolver } from "./middleware/tenant.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { publicTenantResolver } from "./middleware/public-tenant.js";
import adminContests from "./routes/admin/contests/index.js";
import publicContests from "./routes/public/contests.js";
import webhookSurvey from "./routes/webhooks/survey.js";

export const app = new Hono();

// Global middleware
app.use("*", requestId);
app.use("*", errorHandler);
app.use("*", corsMiddleware);
app.use("*", dbMiddleware);

// Admin routes
app.use("/api/admin/*", clerkAuth);
app.use("/api/admin/*", tenantResolver);
app.route("/api/admin/contests", adminContests);

// Public routes
app.use("/api/contests/*", publicTenantResolver);
app.use("/api/contests/*/register", rateLimit(3, 3600));
app.use("/api/contests/*/verify-email", rateLimit(5, 3600));
app.route("/api/contests", publicContests);

// Webhooks
app.route("/api/webhooks", webhookSurvey);

// Health
app.get("/api/health", (c) => c.json({ status: "ok" }));
`;

describe("extractHonoConventions", () => {
  // Task 5: Middleware chain tests
  it("extracts global middleware with correct order", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const global = conv.middleware_chains.find((c) => c.scope === "global");
    expect(global).toBeDefined();
    expect(global!.chain.length).toBe(4);
    expect(global!.chain.map((m) => m.name)).toEqual([
      "requestId", "errorHandler", "corsMiddleware", "dbMiddleware",
    ]);
    expect(global!.chain[0].order).toBe(1);
    expect(global!.chain[3].order).toBe(4);
  });

  it("extracts scoped admin middleware", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const admin = conv.middleware_chains.find((c) => c.scope === "admin");
    expect(admin).toBeDefined();
    expect(admin!.chain.map((m) => m.name)).toEqual(["clerkAuth", "tenantResolver"]);
  });

  it("includes file:line evidence for each middleware entry", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const global = conv.middleware_chains.find((c) => c.scope === "global")!;
    for (const mw of global.chain) {
      expect(mw.line).toBeGreaterThan(0);
    }
    expect(conv.middleware_chains[0].file).toBe("apps/api/src/app.ts");
  });

  it("extracts public scoped middleware", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const pub = conv.middleware_chains.find((c) => c.scope === "public");
    expect(pub).toBeDefined();
    expect(pub!.chain.some((m) => m.name === "publicTenantResolver")).toBe(true);
  });

  it("returns empty middleware_chains for source with no .use() calls", async () => {
    const conv = await extractHonoConventions("const x = 1;\n", "test.ts");
    expect(conv.middleware_chains).toEqual([]);
  });

  // Task 6: Rate limits and route mounts
  it("extracts rate limit registrations with max and window", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.rate_limits.length).toBe(2); // 3/3600 and 5/3600 in fixture
    expect(conv.rate_limits[0]).toMatchObject({ max: 3, window: 3600 });
    expect(conv.rate_limits[1]).toMatchObject({ max: 5, window: 3600 });
  });

  it("includes applied_to_path for rate limits", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    const registerLimit = conv.rate_limits.find((r) => r.max === 3);
    expect(registerLimit?.applied_to_path).toContain("register");
  });

  it("extracts route mounts with mount_path and imported_from", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.route_mounts.length).toBeGreaterThan(0);
    const adminContest = conv.route_mounts.find((r) => r.mount_path === "/api/admin/contests");
    expect(adminContest).toBeDefined();
    expect(adminContest!.exported_as).toBe("adminContests");
    expect(adminContest!.imported_from).toBe("./routes/admin/contests/index.js");
  });

  it("captures all route mounts", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    const paths = conv.route_mounts.map((r) => r.mount_path);
    expect(paths).toContain("/api/admin/contests");
    expect(paths).toContain("/api/contests");
    expect(paths).toContain("/api/webhooks");
  });

  it("handles rate limit without clear path as null", async () => {
    const source = 'app.use("*", rateLimit(100, 60));\n';
    const conv = await extractHonoConventions(source, "test.ts");
    expect(conv.rate_limits[0].applied_to_path).toBeNull();
  });

  // Task 7: Auth boundaries
  it("detects auth middleware", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.auth_patterns.auth_middleware).toBe("clerkAuth");
  });

  it("identifies admin group as requiring auth", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.auth_patterns.groups["admin"]?.requires_auth).toBe(true);
    expect(conv.auth_patterns.groups["admin"]?.middleware).toContain("clerkAuth");
  });

  it("identifies public group as not requiring auth", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    // Public group should exist but not require auth (no clerkAuth)
    expect(conv.auth_patterns.groups["public"]).toBeDefined();
    expect(conv.auth_patterns.groups["public"]?.middleware).not.toContain("clerkAuth");
  });

  it("identifies webhook group", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.auth_patterns.groups["webhook"]).toBeDefined();
    expect(conv.auth_patterns.groups["webhook"]?.requires_auth).toBe(false);
  });

  // Bug fix: dedup same middleware on different paths
  it("deduplicates same middleware applied to different paths in same scope", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    const pub = conv.middleware_chains.find((c) => c.scope === "public");
    expect(pub).toBeDefined();
    // publicTenantResolver appears on 3 paths but should be listed once in the chain
    const ptNames = pub!.chain.filter((m) => m.name === "publicTenantResolver");
    expect(ptNames.length).toBe(1);
  });

  it("deduplicates middleware in auth group lists", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    const pubGroup = conv.auth_patterns.groups["public"];
    expect(pubGroup).toBeDefined();
    const ptCount = pubGroup!.middleware.filter((m) => m === "publicTenantResolver").length;
    expect(ptCount).toBe(1);
  });

  it("resolves imported_from for route mounts via import map", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    const webhook = conv.route_mounts.find((r) => r.exported_as === "webhookSurvey");
    expect(webhook).toBeDefined();
    expect(webhook!.imported_from).toBe("./routes/webhooks/survey.js");
  });
});

// ---------------------------------------------------------------------------
// get_extractor_versions (Task 9)
// ---------------------------------------------------------------------------

describe("getExtractorVersions", () => {
  it("returns profile_frameworks with hono, stack_detector, file_classifier keys", async () => {
    const response = getExtractorVersions();
    expect(response.profile_frameworks).toHaveProperty("hono");
    expect(response.profile_frameworks).toHaveProperty("stack_detector");
    expect(response.profile_frameworks).toHaveProperty("file_classifier");
  });

  it("all profile_frameworks values are semver strings", async () => {
    const response = getExtractorVersions();
    const semverRegex = /^\d+\.\d+\.\d+$/;
    for (const value of Object.values(response.profile_frameworks)) {
      expect(value).toMatch(semverRegex);
    }
  });

  it("returns parser_languages with tree-sitter supported languages", async () => {
    const response = getExtractorVersions();
    expect(response.parser_languages).toContain("typescript");
    expect(response.parser_languages).toContain("python");
    expect(response.parser_languages).toContain("go");
    expect(response.parser_languages).toContain("rust");
  });

  it("includes a note clarifying text tools work on all indexed files", async () => {
    const response = getExtractorVersions();
    expect(response.note).toContain("ALL indexed files");
    expect(response.note).toContain("search_text");
  });

  it("returns kotlin in parser_languages (full parser support)", async () => {
    const response = getExtractorVersions();
    expect(response.parser_languages).toContain("kotlin");
  });

  it("returns text_stub_languages including swift and dart", async () => {
    const response = getExtractorVersions();
    expect(response.text_stub_languages).not.toContain("kotlin");
    expect(response.text_stub_languages).toContain("swift");
    expect(response.text_stub_languages).toContain("dart");
  });

  it("keeps legacy versions field for backward compatibility", async () => {
    const response = getExtractorVersions();
    expect(response.versions).toHaveProperty("hono");
    expect(response.versions).toHaveProperty("nestjs");
  });
});

// ---------------------------------------------------------------------------
// Schema conformance (Task 10)
// ---------------------------------------------------------------------------

describe("profile schema conformance", () => {
  it("complete profile has Phase 1A sections", async () => {
    // Simulate a complete Hono profile by testing extractHonoConventions output structure
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv).toHaveProperty("middleware_chains");
    expect(conv).toHaveProperty("rate_limits");
    expect(conv).toHaveProperty("route_mounts");
    expect(conv).toHaveProperty("auth_patterns");
  });

  it("convention-level facts have file and line fields", async () => {
    const conv = await extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    for (const chain of conv.middleware_chains) {
      expect(chain.file).toBeDefined();
      for (const mw of chain.chain) {
        expect(mw.line).toBeGreaterThan(0);
      }
    }
    for (const rl of conv.rate_limits) {
      expect(rl.file).toBeDefined();
      expect(rl.line).toBeGreaterThan(0);
    }
  });

  it("extractors include nestjs version", async () => {
    const response = getExtractorVersions();
    expect(response.profile_frameworks).toHaveProperty("nestjs");
  });

  it("stack-level facts have detected_from (not line)", async () => {
    const root = await createFixture("schema-test", {
      "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
    });
    const stack = await detectStack(root);
    expect(stack.detected_from.length).toBeGreaterThan(0);
    expect(stack.detected_from[0]).toContain("package.json");
  });
});

// ---------------------------------------------------------------------------
// NestJS Extractor Tests
// ---------------------------------------------------------------------------

const NEST_MODULE_SOURCE = `import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SurveyModule } from './modules/survey/survey.module';
import { HealthController } from './health.controller';
import { ClerkAuthGuard } from './auth/clerk.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [{ ttl: 60000, limit: 60 }],
      }),
    }),
    PrismaModule,
    AuthModule,
    SurveyModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ClerkAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
`;

describe("extractNestConventions", () => {
  it("extracts module imports", async () => {
    const conv = extractNestConventions(NEST_MODULE_SOURCE, "app.module.ts");
    expect(conv.modules.length).toBeGreaterThanOrEqual(5);
    const prisma = conv.modules.find((m) => m.name === "PrismaModule");
    expect(prisma).toBeDefined();
    expect(prisma!.imported_from).toBe("./prisma/prisma.module");
  });

  it("extracts global guards with APP_GUARD token", async () => {
    const conv = extractNestConventions(NEST_MODULE_SOURCE, "app.module.ts");
    expect(conv.global_guards.length).toBe(3);
    const names = conv.global_guards.map((g) => g.name);
    expect(names).toContain("ClerkAuthGuard");
    expect(names).toContain("RolesGuard");
    expect(names).toContain("ThrottlerGuard");
  });

  it("extracts global filters", async () => {
    const conv = extractNestConventions(NEST_MODULE_SOURCE, "app.module.ts");
    expect(conv.global_filters.length).toBe(1);
    expect(conv.global_filters[0]!.name).toBe("SentryGlobalFilter");
  });

  it("extracts controllers", async () => {
    const conv = extractNestConventions(NEST_MODULE_SOURCE, "app.module.ts");
    expect(conv.controllers).toContain("HealthController");
  });

  it("extracts throttler config", async () => {
    const conv = extractNestConventions(NEST_MODULE_SOURCE, "app.module.ts");
    expect(conv.throttler).toBeDefined();
    expect(conv.throttler!.ttl).toBe(60000);
  });

  it("resolves imported_from for guards", async () => {
    const conv = extractNestConventions(NEST_MODULE_SOURCE, "app.module.ts");
    const clerk = conv.global_guards.find((g) => g.name === "ClerkAuthGuard");
    expect(clerk!.imported_from).toBe("./auth/clerk.guard");
  });

  it("handles source with no @Module decorator", async () => {
    const conv = extractNestConventions("const x = 1;\n", "plain.ts");
    expect(conv.modules).toEqual([]);
    expect(conv.global_guards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Astro branch in analyzeProject + buildConventionsSummary (Task 14)
// ---------------------------------------------------------------------------

import { initParser } from "../../src/parser/parser-manager.js";

const ASTRO_CONFIG_SOURCE = `import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  output: "server",
  adapter: vercel(),
  integrations: [tailwind()],
  site: "https://example.com",
});
`;

describe("analyzeProject — astro branch", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("returns status: complete for Astro project", async () => {
    const root = await createFixture("astro-analyze", {
      "package.json": JSON.stringify({
        name: "test-astro",
        dependencies: { astro: "^4.0.0" },
      }),
      "astro.config.mjs": ASTRO_CONFIG_SOURCE,
    });

    const mockedGetCodeIndex = vi.mocked(getCodeIndex);
    mockedGetCodeIndex.mockResolvedValueOnce({
      repo: "local/test-astro",
      root,
      symbols: [],
      files: [
        { path: "astro.config.mjs", language: "javascript", symbol_count: 1, last_modified: Date.now() },
        { path: "package.json", language: "json", symbol_count: 0, last_modified: Date.now() },
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
      symbol_count: 1,
      file_count: 2,
    } as CodeIndex);

    const summary = await analyzeProject("local/test-astro");
    expect(summary.status).toBe("complete");

    await rm(root, { recursive: true, force: true });
  });

  it("response includes astro_conventions with populated fields", async () => {
    const root = await createFixture("astro-analyze-conv", {
      "package.json": JSON.stringify({
        name: "test-astro-conv",
        dependencies: { astro: "^4.0.0" },
      }),
      "astro.config.mjs": ASTRO_CONFIG_SOURCE,
    });

    const mockedGetCodeIndex = vi.mocked(getCodeIndex);
    mockedGetCodeIndex.mockResolvedValueOnce({
      repo: "local/test-astro-conv",
      root,
      symbols: [],
      files: [
        { path: "astro.config.mjs", language: "javascript", symbol_count: 1, last_modified: Date.now() },
        { path: "package.json", language: "json", symbol_count: 0, last_modified: Date.now() },
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
      symbol_count: 1,
      file_count: 2,
    } as CodeIndex);

    const summary = await analyzeProject("local/test-astro-conv");
    const conv = (summary.conventions_summary as any);
    expect(conv).toBeDefined();
    expect(conv.type).toBe("astro");
    expect(conv.output_mode).toBe("server");
    expect(conv.adapter).toBe("@astrojs/vercel");
    expect(conv.integrations).toBeGreaterThanOrEqual(1);

    await rm(root, { recursive: true, force: true });
  });
});

describe("buildConventionsSummary — astro branch", () => {
  it("produces astro section from profile with astro_conventions", async () => {
    const fakeProfile = {
      astro_conventions: {
        output_mode: "server",
        adapter: "@astrojs/vercel",
        integrations: ["@astrojs/tailwind", "@astrojs/react"],
        site: "https://example.com",
        base: null,
        i18n: null,
        redirects: {},
        config_resolution: "static",
        config_file: "astro.config.mjs",
      },
    } as unknown as ProjectProfile;

    const summary = buildConventionsSummary(fakeProfile);
    expect(summary).toBeDefined();
    expect((summary as any).type).toBe("astro");
    expect((summary as any).output_mode).toBe("server");
    expect((summary as any).adapter).toBe("@astrojs/vercel");
    expect((summary as any).integrations).toBe(2);
    expect((summary as any).has_i18n).toBe(false);
    expect((summary as any).config_resolution).toBe("static");
  });
});
