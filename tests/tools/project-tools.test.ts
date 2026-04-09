import { describe, it, expect, beforeAll } from "vitest";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectStack,
  classifyFiles,
  extractHonoConventions,
  analyzeProject,
  getExtractorVersions,
  EXTRACTOR_VERSIONS,
} from "../../src/tools/project-tools.js";
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
});

// ---------------------------------------------------------------------------
// File Classifier Tests (Task 4)
// ---------------------------------------------------------------------------

describe("classifyFiles", () => {
  it("classifies app.ts as critical ORCHESTRATOR", () => {
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

  it("classifies middleware as critical", () => {
    const index = mockIndex("/tmp/test", ["src/middleware/auth.ts"]);
    const result = classifyFiles(index);
    expect(result.critical.some((f) => f.path === "src/middleware/auth.ts")).toBe(true);
  });

  it("classifies service files as important", () => {
    const index = mockIndex("/tmp/test", [
      "apps/api/src/services/contest.service.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.important.some((f) => f.path.includes("contest.service.ts"))).toBe(true);
  });

  it("classifies utils as routine", () => {
    const index = mockIndex("/tmp/test", [
      "src/utils/constants.ts",
      "src/utils/helpers.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.routine.count).toBeGreaterThan(0);
  });

  it("produces aggregate counts for routine tier", () => {
    const index = mockIndex("/tmp/test", [
      "src/utils/a.ts",
      "src/utils/b.ts",
      "src/types/index.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.routine.by_type).toBeDefined();
    expect(typeof result.routine.count).toBe("number");
  });

  it("detects has_tests flag", () => {
    const index = mockIndex("/tmp/test", [
      "src/app.ts",
      "src/app.test.ts",
    ]);
    const result = classifyFiles(index);
    const appFile = result.critical.find((f) => f.path === "src/app.ts");
    expect(appFile?.has_tests).toBe(true);
  });

  it("skips test files from classification", () => {
    const index = mockIndex("/tmp/test", [
      "src/app.test.ts",
      "src/services/order.spec.ts",
    ]);
    const result = classifyFiles(index);
    expect(result.critical.length).toBe(0);
    expect(result.important.length).toBe(0);
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
  it("extracts global middleware with correct order", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const global = conv.middleware_chains.find((c) => c.scope === "global");
    expect(global).toBeDefined();
    expect(global!.chain.length).toBe(4);
    expect(global!.chain.map((m) => m.name)).toEqual([
      "requestId", "errorHandler", "corsMiddleware", "dbMiddleware",
    ]);
    expect(global!.chain[0].order).toBe(1);
    expect(global!.chain[3].order).toBe(4);
  });

  it("extracts scoped admin middleware", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const admin = conv.middleware_chains.find((c) => c.scope === "admin");
    expect(admin).toBeDefined();
    expect(admin!.chain.map((m) => m.name)).toEqual(["clerkAuth", "tenantResolver"]);
  });

  it("includes file:line evidence for each middleware entry", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const global = conv.middleware_chains.find((c) => c.scope === "global")!;
    for (const mw of global.chain) {
      expect(mw.line).toBeGreaterThan(0);
    }
    expect(conv.middleware_chains[0].file).toBe("apps/api/src/app.ts");
  });

  it("extracts public scoped middleware", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "apps/api/src/app.ts");
    const pub = conv.middleware_chains.find((c) => c.scope === "public");
    expect(pub).toBeDefined();
    expect(pub!.chain.some((m) => m.name === "publicTenantResolver")).toBe(true);
  });

  it("returns empty middleware_chains for source with no .use() calls", () => {
    const conv = extractHonoConventions("const x = 1;\n", "test.ts");
    expect(conv.middleware_chains).toEqual([]);
  });

  // Task 6: Rate limits and route mounts
  it("extracts rate limit registrations with max and window", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.rate_limits.length).toBe(2); // 3/3600 and 5/3600 in fixture
    expect(conv.rate_limits[0]).toMatchObject({ max: 3, window: 3600 });
    expect(conv.rate_limits[1]).toMatchObject({ max: 5, window: 3600 });
  });

  it("includes applied_to_path for rate limits", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    const registerLimit = conv.rate_limits.find((r) => r.max === 3);
    expect(registerLimit?.applied_to_path).toContain("register");
  });

  it("extracts route mounts with mount_path", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.route_mounts.length).toBeGreaterThan(0);
    const adminContest = conv.route_mounts.find((r) => r.mount_path === "/api/admin/contests");
    expect(adminContest).toBeDefined();
    expect(adminContest!.exported_as).toBe("adminContests");
  });

  it("captures all route mounts", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    const paths = conv.route_mounts.map((r) => r.mount_path);
    expect(paths).toContain("/api/admin/contests");
    expect(paths).toContain("/api/contests");
    expect(paths).toContain("/api/webhooks");
  });

  it("handles rate limit without clear path as null", () => {
    const source = 'app.use("*", rateLimit(100, 60));\n';
    const conv = extractHonoConventions(source, "test.ts");
    expect(conv.rate_limits[0].applied_to_path).toBeNull();
  });

  // Task 7: Auth boundaries
  it("detects auth middleware", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.auth_patterns.auth_middleware).toBe("clerkAuth");
  });

  it("identifies admin group as requiring auth", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.auth_patterns.groups["admin"]?.requires_auth).toBe(true);
    expect(conv.auth_patterns.groups["admin"]?.middleware).toContain("clerkAuth");
  });

  it("identifies public group as not requiring auth", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    // Public group should exist but not require auth (no clerkAuth)
    expect(conv.auth_patterns.groups["public"]).toBeDefined();
    expect(conv.auth_patterns.groups["public"]?.middleware).not.toContain("clerkAuth");
  });

  it("identifies webhook group", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv.auth_patterns.groups["webhook"]).toBeDefined();
    expect(conv.auth_patterns.groups["webhook"]?.requires_auth).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_extractor_versions (Task 9)
// ---------------------------------------------------------------------------

describe("getExtractorVersions", () => {
  it("returns dict with hono, stack_detector, file_classifier keys", () => {
    const versions = getExtractorVersions();
    expect(versions).toHaveProperty("hono");
    expect(versions).toHaveProperty("stack_detector");
    expect(versions).toHaveProperty("file_classifier");
  });

  it("all values are semver strings", () => {
    const versions = getExtractorVersions();
    const semverRegex = /^\d+\.\d+\.\d+$/;
    for (const [key, value] of Object.entries(versions)) {
      expect(value).toMatch(semverRegex);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema conformance (Task 10)
// ---------------------------------------------------------------------------

describe("profile schema conformance", () => {
  it("complete profile has Phase 1A sections", () => {
    // Simulate a complete Hono profile by testing extractHonoConventions output structure
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
    expect(conv).toHaveProperty("middleware_chains");
    expect(conv).toHaveProperty("rate_limits");
    expect(conv).toHaveProperty("route_mounts");
    expect(conv).toHaveProperty("auth_patterns");
  });

  it("convention-level facts have file and line fields", () => {
    const conv = extractHonoConventions(HONO_APP_SOURCE, "app.ts");
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

  it("stack-level facts have detected_from (not line)", async () => {
    const root = await createFixture("schema-test", {
      "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
    });
    const stack = await detectStack(root);
    expect(stack.detected_from.length).toBeGreaterThan(0);
    expect(stack.detected_from[0]).toContain("package.json");
  });
});
