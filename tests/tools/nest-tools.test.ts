import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// Mock getCodeIndex before importing nest-tools
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestLifecycleMap, nestModuleGraph } from "../../src/tools/nest-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function makeSymbol(overrides: Partial<CodeSymbol> & { name: string; file: string; kind: string }): CodeSymbol {
  return {
    id: `${overrides.file}:${overrides.name}`,
    start_line: 1,
    end_line: 10,
    source: "",
    ...overrides,
  } as CodeSymbol;
}

function mockIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    root: "/tmp/test",
    files: [...new Set(symbols.map((s) => s.file))].map((p) => ({ path: p, size: 100 })),
    symbols,
  } as unknown as CodeIndex;
}

describe("nest_lifecycle_map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds lifecycle hooks in indexed symbols", async () => {
    const index = mockIndex([
      makeSymbol({
        name: "onModuleInit",
        file: "src/auth/auth.service.ts",
        kind: "method",
        source: "async onModuleInit() {",
        start_line: 10,
        end_line: 15,
      }),
      makeSymbol({
        name: "AuthService",
        file: "src/auth/auth.service.ts",
        kind: "class",
        start_line: 5,
        end_line: 50,
      }),
      makeSymbol({
        name: "onApplicationBootstrap",
        file: "src/app.module.ts",
        kind: "method",
        source: "onApplicationBootstrap() {",
        start_line: 20,
        end_line: 25,
      }),
      makeSymbol({
        name: "AppModule",
        file: "src/app.module.ts",
        kind: "class",
        start_line: 1,
        end_line: 30,
      }),
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestLifecycleMap("test-repo");
    expect(result.hooks.length).toBe(2);

    const initHook = result.hooks.find((h) => h.hook === "onModuleInit");
    expect(initHook).toBeDefined();
    expect(initHook!.class_name).toBe("AuthService");
    expect(initHook!.file).toBe("src/auth/auth.service.ts");
    expect(initHook!.is_async).toBe(true);

    const bootstrapHook = result.hooks.find((h) => h.hook === "onApplicationBootstrap");
    expect(bootstrapHook).toBeDefined();
    expect(bootstrapHook!.class_name).toBe("AppModule");
    expect(bootstrapHook!.is_async).toBe(false);
  });

  it("detects all 5 lifecycle hooks", async () => {
    const hooks = [
      "onModuleInit",
      "onModuleDestroy",
      "onApplicationBootstrap",
      "onApplicationShutdown",
      "beforeApplicationShutdown",
    ];
    const symbols: CodeSymbol[] = [];
    for (const hook of hooks) {
      symbols.push(
        makeSymbol({ name: hook, file: "src/app.service.ts", kind: "method", source: `${hook}() {` }),
        makeSymbol({ name: "AppService", file: "src/app.service.ts", kind: "class", start_line: 1, end_line: 100 }),
      );
    }
    mockedGetCodeIndex.mockResolvedValue(mockIndex(symbols));

    const result = await nestLifecycleMap("test-repo");
    expect(result.hooks.length).toBe(5);
    const hookNames = result.hooks.map((h) => h.hook);
    for (const hook of hooks) {
      expect(hookNames).toContain(hook);
    }
  });

  it("returns empty array when no lifecycle hooks present", async () => {
    const index = mockIndex([
      makeSymbol({ name: "findAll", file: "src/users.service.ts", kind: "method" }),
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestLifecycleMap("test-repo");
    expect(result.hooks).toEqual([]);
  });

  it("detects async hooks", async () => {
    const index = mockIndex([
      makeSymbol({
        name: "onModuleInit",
        file: "src/db.service.ts",
        kind: "method",
        source: "async onModuleInit() {\n  await this.connect();\n}",
      }),
      makeSymbol({ name: "DbService", file: "src/db.service.ts", kind: "class", start_line: 1, end_line: 50 }),
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestLifecycleMap("test-repo");
    expect(result.hooks[0]!.is_async).toBe(true);
  });

  it("handles multiple hooks on same class", async () => {
    const index = mockIndex([
      makeSymbol({ name: "onModuleInit", file: "src/cache.service.ts", kind: "method", source: "async onModuleInit() {", start_line: 10, end_line: 15 }),
      makeSymbol({ name: "onModuleDestroy", file: "src/cache.service.ts", kind: "method", source: "async onModuleDestroy() {", start_line: 20, end_line: 25 }),
      makeSymbol({ name: "CacheService", file: "src/cache.service.ts", kind: "class", start_line: 1, end_line: 50 }),
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestLifecycleMap("test-repo");
    expect(result.hooks.length).toBe(2);
    expect(result.hooks.every((h) => h.class_name === "CacheService")).toBe(true);
  });

  it("ignores non-method symbols with lifecycle hook names", async () => {
    const index = mockIndex([
      makeSymbol({ name: "onModuleInit", file: "src/types.ts", kind: "type" }),
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestLifecycleMap("test-repo");
    expect(result.hooks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// nest_module_graph tests (Task 6)
// ---------------------------------------------------------------------------

describe("nest_module_graph", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-module-graph-"));
    await mkdir(join(tmpRoot, "src/auth"), { recursive: true });
    await mkdir(join(tmpRoot, "src/prisma"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function mockIndexWithRoot(root: string, filePaths: string[]): CodeIndex {
    return {
      root,
      files: filePaths.map((p) => ({ path: p, size: 100 })),
      symbols: [],
    } as unknown as CodeIndex;
  }

  it("builds module graph with edges from imports", async () => {
    await writeFile(join(tmpRoot, "src/app.module.ts"), `
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
`);
    await writeFile(join(tmpRoot, "src/auth/auth.module.ts"), `
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
`);
    await writeFile(join(tmpRoot, "src/prisma/prisma.module.ts"), `
import { Module, Global } from '@nestjs/common';

@Global()
@Module({
  imports: [],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/app.module.ts",
      "src/auth/auth.module.ts",
      "src/prisma/prisma.module.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestModuleGraph("test-repo");

    // 3 modules detected
    expect(result.modules.length).toBe(3);
    expect(result.modules.map((m) => m.name).sort()).toEqual(["AppModule", "AuthModule", "PrismaModule"]);

    // Edges
    expect(result.edges).toContainEqual({ from: "AppModule", to: "AuthModule" });
    expect(result.edges).toContainEqual({ from: "AppModule", to: "PrismaModule" });
    expect(result.edges).toContainEqual({ from: "AuthModule", to: "PrismaModule" });

    // PrismaModule is @Global
    const prisma = result.modules.find((m) => m.name === "PrismaModule");
    expect(prisma!.is_global).toBe(true);

    // PrismaModule exports PrismaService
    expect(prisma!.exports).toContain("PrismaService");

    // No circular deps in this graph
    expect(result.circular_deps).toEqual([]);
  });

  it("detects circular module dependencies", async () => {
    await writeFile(join(tmpRoot, "src/app.module.ts"), `
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
@Module({
  imports: [
    AuthModule,
  ],
})
export class AppModule {}
`);
    await writeFile(join(tmpRoot, "src/auth/auth.module.ts"), `
import { Module } from '@nestjs/common';
import { AppModule } from '../app.module';
@Module({
  imports: [
    AppModule,
  ],
})
export class AuthModule {}
`);

    const index = mockIndexWithRoot(tmpRoot, ["src/app.module.ts", "src/auth/auth.module.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestModuleGraph("test-repo");
    expect(result.circular_deps.length).toBeGreaterThan(0);
  });

  it("returns truncated: true when max_modules exceeded", async () => {
    await writeFile(join(tmpRoot, "src/app.module.ts"), `
@Module({ imports: [] })
export class AppModule {}
`);
    await writeFile(join(tmpRoot, "src/auth/auth.module.ts"), `
@Module({ imports: [] })
export class AuthModule {}
`);
    await writeFile(join(tmpRoot, "src/prisma/prisma.module.ts"), `
@Module({ imports: [] })
export class PrismaModule {}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/app.module.ts",
      "src/auth/auth.module.ts",
      "src/prisma/prisma.module.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestModuleGraph("test-repo", { max_modules: 2 });
    expect(result.modules.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("returns empty graph for repo with no module files", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestModuleGraph("test-repo");
    expect(result.modules).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("handles unreadable module file gracefully (CQ8)", async () => {
    // Don't write the file — readFile will fail
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.module.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestModuleGraph("test-repo");
    expect(result.modules).toEqual([]);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0]!.file).toBe("src/missing.module.ts");
  });
});
