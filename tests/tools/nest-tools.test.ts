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
import { nestLifecycleMap, nestModuleGraph, nestDIGraph, nestGuardChain, nestRouteInventory, nestAudit, detectCycles } from "../../src/tools/nest-tools.js";

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
// detectCycles export (Task 4 — prerequisite for G12 reuse)
// ---------------------------------------------------------------------------

describe("detectCycles export", () => {
  it("detects simple A → B → A cycle", () => {
    const cycles = detectCycles(["A", "B"], [{ from: "A", to: "B" }, { from: "B", to: "A" }]);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("A");
    expect(cycles[0]).toContain("B");
  });

  it("returns empty array for acyclic graph", () => {
    const cycles = detectCycles(["A", "B", "C"], [{ from: "A", to: "B" }, { from: "B", to: "C" }]);
    expect(cycles).toEqual([]);
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

// ---------------------------------------------------------------------------
// nest_di_graph tests (Task 7)
// ---------------------------------------------------------------------------

describe("nest_di_graph", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-di-graph-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
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

  it("builds DI graph with constructor injection edges", async () => {
    await writeFile(join(tmpRoot, "src/auth.service.ts"), `
import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly configService: ConfigService,
  ) {}
}
`);
    await writeFile(join(tmpRoot, "src/user.service.ts"), `
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  constructor(private readonly prismaService: PrismaService) {}
}
`);
    await writeFile(join(tmpRoot, "src/prisma.service.ts"), `
import { Injectable } from '@nestjs/common';

@Injectable()
export class PrismaService {
  constructor() {}
}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/auth.service.ts",
      "src/user.service.ts",
      "src/prisma.service.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestDIGraph("test-repo");

    expect(result.nodes.length).toBe(3);
    expect(result.nodes.map((n) => n.name).sort()).toEqual(["AuthService", "PrismaService", "UserService"]);

    // AuthService → UserService, AuthService → ConfigService
    expect(result.edges).toContainEqual({ from: "AuthService", to: "UserService", via: "inject" });
    expect(result.edges).toContainEqual({ from: "AuthService", to: "ConfigService", via: "inject" });

    // UserService → PrismaService
    expect(result.edges).toContainEqual({ from: "UserService", to: "PrismaService", via: "inject" });

    // PrismaService has no outgoing edges
    expect(result.edges.filter((e) => e.from === "PrismaService")).toEqual([]);
  });

  it("handles decorated constructor params (@InjectRepository, @Optional)", async () => {
    await writeFile(join(tmpRoot, "src/repo.service.ts"), `
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Optional } from '@nestjs/common';

@Injectable()
export class RepoService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    @Optional() private readonly logger: LoggerService,
  ) {}
}
`);

    const index = mockIndexWithRoot(tmpRoot, ["src/repo.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestDIGraph("test-repo");

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0]!.name).toBe("RepoService");
    // G3: Repository<User> should resolve to inner type "User" (container generic)
    expect(result.edges).toContainEqual({ from: "RepoService", to: "User", via: "inject" });
    // LoggerService is not a container generic — resolves to outer type
    expect(result.edges).toContainEqual({ from: "RepoService", to: "LoggerService", via: "inject" });
  });

  it("G3: extracts inner type from container generic (Repository<Article>, Model<Comment>)", async () => {
    await writeFile(join(tmpRoot, "src/article.service.ts"), `
import { Injectable } from '@nestjs/common';

@Injectable()
export class ArticleService {
  constructor(
    @InjectRepository(Article) private readonly articleRepo: Repository<Article>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly plainService: PlainService,
  ) {}
}
`);

    const index = mockIndexWithRoot(tmpRoot, ["src/article.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestDIGraph("test-repo");

    expect(result.nodes.length).toBe(1);
    // Container generics resolve to inner type — distinguishes different repositories
    expect(result.edges).toContainEqual({ from: "ArticleService", to: "Article", via: "inject" });
    expect(result.edges).toContainEqual({ from: "ArticleService", to: "Comment", via: "inject" });
    expect(result.edges).toContainEqual({ from: "ArticleService", to: "User", via: "inject" });
    // Non-container type — resolves to outer name
    expect(result.edges).toContainEqual({ from: "ArticleService", to: "PlainService", via: "inject" });
    // Regression: no edge for raw "Repository" or "Model" (now that G3 unwraps them)
    expect(result.edges).not.toContainEqual({ from: "ArticleService", to: "Repository", via: "inject" });
    expect(result.edges).not.toContainEqual({ from: "ArticleService", to: "Model", via: "inject" });
  });

  it("detects circular DI dependencies", async () => {
    await writeFile(join(tmpRoot, "src/a.service.ts"), `
import { Injectable, Inject, forwardRef } from '@nestjs/common';
@Injectable()
export class AService {
  constructor(@Inject(forwardRef(() => BService)) private bService: BService) {}
}
`);
    await writeFile(join(tmpRoot, "src/b.service.ts"), `
import { Injectable, Inject, forwardRef } from '@nestjs/common';
@Injectable()
export class BService {
  constructor(@Inject(forwardRef(() => AService)) private aService: AService) {}
}
`);

    const index = mockIndexWithRoot(tmpRoot, ["src/a.service.ts", "src/b.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestDIGraph("test-repo");
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  it("caps at max_nodes and sets truncated flag", async () => {
    await writeFile(join(tmpRoot, "src/a.service.ts"), `
@Injectable() export class AService { constructor() {} }
`);
    await writeFile(join(tmpRoot, "src/b.service.ts"), `
@Injectable() export class BService { constructor() {} }
`);

    const index = mockIndexWithRoot(tmpRoot, ["src/a.service.ts", "src/b.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestDIGraph("test-repo", { max_nodes: 1 });
    expect(result.nodes.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("handles unreadable file gracefully (CQ8)", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestDIGraph("test-repo");
    expect(result.nodes).toEqual([]);
    expect(result.errors!.length).toBe(1);
  });

  it("detects provider scope", async () => {
    await writeFile(join(tmpRoot, "src/scoped.service.ts"), `
import { Injectable, Scope } from '@nestjs/common';
@Injectable({ scope: Scope.REQUEST })
export class ScopedService {
  constructor() {}
}
`);

    const index = mockIndexWithRoot(tmpRoot, ["src/scoped.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestDIGraph("test-repo");
    expect(result.nodes[0]!.scope).toBe("REQUEST");
  });
});

// ---------------------------------------------------------------------------
// nest_guard_chain tests (Task 8)
// ---------------------------------------------------------------------------

describe("nest_guard_chain", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-guard-chain-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
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

  it("builds guard chain with global → controller → method layers", async () => {
    // Module with global guard
    await writeFile(join(tmpRoot, "src/app.module.ts"), `
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
`);
    // Controller with class-level + method-level guards
    await writeFile(join(tmpRoot, "src/users.controller.ts"), `
import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { LoggingInterceptor } from './logging.interceptor';

@UseGuards(AuthGuard)
@Controller('users')
export class UsersController {
  @UseGuards(RolesGuard)
  @UseInterceptors(LoggingInterceptor)
  @Get('admin')
  findAdmin() { return []; }

  @Get('public')
  findPublic() { return []; }
}
`);
    const index = mockIndexWithRoot(tmpRoot, [
      "src/app.module.ts",
      "src/users.controller.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestGuardChain("test-repo");

    // Should find 2 routes
    expect(result.routes.length).toBe(2);

    // Admin route has global + controller + method guards
    const adminRoute = result.routes.find((r) => r.route === "/users/admin");
    expect(adminRoute).toBeDefined();
    expect(adminRoute!.chain.some((c) => c.layer === "global" && c.name === "ThrottlerGuard")).toBe(true);
    expect(adminRoute!.chain.some((c) => c.layer === "controller" && c.name === "AuthGuard")).toBe(true);
    expect(adminRoute!.chain.some((c) => c.layer === "method" && c.name === "RolesGuard")).toBe(true);
    expect(adminRoute!.chain.some((c) => c.layer === "method" && c.type === "interceptor" && c.name === "LoggingInterceptor")).toBe(true);

    // Public route has global + controller guards only (no method-level)
    const publicRoute = result.routes.find((r) => r.route === "/users/public");
    expect(publicRoute).toBeDefined();
    expect(publicRoute!.chain.some((c) => c.layer === "global" && c.name === "ThrottlerGuard")).toBe(true);
    expect(publicRoute!.chain.some((c) => c.layer === "controller" && c.name === "AuthGuard")).toBe(true);
    expect(publicRoute!.chain.filter((c) => c.layer === "method")).toEqual([]);
  });

  it("returns empty chain for route with no guards", async () => {
    await writeFile(join(tmpRoot, "src/health.controller.ts"), `
@Controller('health')
export class HealthController {
  @Get()
  check() { return 'ok'; }
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/health.controller.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestGuardChain("test-repo");
    expect(result.routes.length).toBe(1);
    expect(result.routes[0]!.chain).toEqual([]);
  });

  it("handles @UseGuards() with empty args", async () => {
    await writeFile(join(tmpRoot, "src/test.controller.ts"), `
@UseGuards()
@Controller('test')
export class TestController {
  @Get('x')
  test() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/test.controller.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestGuardChain("test-repo");
    expect(result.routes.length).toBe(1);
    // Empty @UseGuards() should add no guards (not crash)
    const ctrlGuards = result.routes[0]!.chain.filter((c) => c.layer === "controller" && c.type === "guard");
    expect(ctrlGuards).toEqual([]);
  });

  it("G1: middleware-based auth appears in guard chain", async () => {
    // Module with middleware.configure(consumer) applying AuthMiddleware to users/*
    await writeFile(join(tmpRoot, "src/app.module.ts"), `
import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { AuthMiddleware } from './auth.middleware';

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes({ path: 'users/*', method: RequestMethod.ALL });
  }
}
`);
    // Users controller with protected routes — no @UseGuards, only middleware
    await writeFile(join(tmpRoot, "src/users.controller.ts"), `
import { Controller, Get } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get(':id')
  findOne() { return {}; }
}
`);
    // Health controller — should NOT receive middleware
    await writeFile(join(tmpRoot, "src/health.controller.ts"), `
@Controller('health')
export class HealthController {
  @Get()
  check() { return 'ok'; }
}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/app.module.ts",
      "src/users.controller.ts",
      "src/health.controller.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestGuardChain("test-repo");

    const usersRoute = result.routes.find((r) => r.route === "/users/:id");
    expect(usersRoute).toBeDefined();
    const middlewareEntries = usersRoute!.chain.filter((c) => c.layer === "middleware");
    expect(middlewareEntries.length).toBe(1);
    expect(middlewareEntries[0]!.name).toBe("AuthMiddleware");

    // Regression: health route has no middleware (not a "users/*" match)
    const healthRoute = result.routes.find((r) => r.route === "/health");
    expect(healthRoute).toBeDefined();
    const healthMiddleware = healthRoute!.chain.filter((c) => c.layer === "middleware");
    expect(healthMiddleware).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// nest_route_inventory tests (Task 9)
// ---------------------------------------------------------------------------

describe("nest_route_inventory", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-route-inv-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
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

  it("builds full route map with guards and params", async () => {
    await writeFile(join(tmpRoot, "src/users.controller.ts"), `
import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';

@UseGuards(AuthGuard)
@Controller('api/users')
export class UsersController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne(@Param('id') id: string) { return {}; }

  @Post()
  create(@Body() dto: CreateUserDto) { return {}; }
}
`);
    await writeFile(join(tmpRoot, "src/health.controller.ts"), `
@Controller('health')
export class HealthController {
  @Get()
  check() { return 'ok'; }
}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/users.controller.ts",
      "src/health.controller.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestRouteInventory("test-repo");

    // 4 routes total
    expect(result.stats.total_routes).toBe(4);

    // Users routes have guards
    const usersRoutes = result.routes.filter((r) => r.controller === "UsersController");
    expect(usersRoutes.length).toBe(3);
    for (const r of usersRoutes) {
      expect(r.guards).toContain("AuthGuard");
    }

    // Health route has no guards
    const healthRoute = result.routes.find((r) => r.controller === "HealthController");
    expect(healthRoute).toBeDefined();
    expect(healthRoute!.guards).toEqual([]);

    // Stats
    expect(result.stats.protected).toBe(3);
    expect(result.stats.unprotected).toBe(1);

    // Param decorators
    const findOne = result.routes.find((r) => r.handler === "findOne");
    expect(findOne!.params).toContainEqual({ decorator: "Param", name: "id" });

    const create = result.routes.find((r) => r.handler === "create");
    expect(create!.params).toContainEqual({ decorator: "Body", name: "" });
  });

  it("handles empty route inventory gracefully", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestRouteInventory("test-repo");
    expect(result.routes).toEqual([]);
    expect(result.stats.total_routes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nest_audit tests (Task 10)
// ---------------------------------------------------------------------------

describe("nest_audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns framework_detected: false for non-NestJS repo", async () => {
    const index = mockIndex([
      makeSymbol({ name: "app", file: "src/app.ts", kind: "function", source: "const x = 1;" }),
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestAudit("test-repo");
    expect(result.framework_detected).toBe(false);
    expect(result.summary.failed_checks).toBe(0);
  });

  it("runs all checks on NestJS repo and returns combined result", async () => {
    // Create a minimal NestJS index that detectFrameworks recognizes
    const index = {
      root: "/tmp/test",
      files: [],
      symbols: [
        makeSymbol({ name: "app", file: "src/main.ts", kind: "function", source: "import { Module } from '@nestjs/common';" }),
      ],
    } as unknown as CodeIndex;
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestAudit("test-repo");
    expect(result.framework_detected).toBe(true);
    expect(result.summary).toBeDefined();
    expect(typeof result.summary.total_routes).toBe("number");
    expect(typeof result.summary.cycles).toBe("number");
    expect(typeof result.summary.failed_checks).toBe("number");
    expect(Array.isArray(result.summary.truncated_checks)).toBe(true);
  });

  it("filters checks via options.checks", async () => {
    const index = {
      root: "/tmp/test",
      files: [],
      symbols: [
        makeSymbol({ name: "app", file: "src/main.ts", kind: "function", source: "import '@nestjs/common';" }),
      ],
    } as unknown as CodeIndex;
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestAudit("test-repo", { checks: ["lifecycle"] });
    expect(result.framework_detected).toBe(true);
    // Only lifecycle was requested — others should be undefined
    expect(result.lifecycle_map).toBeDefined();
    expect(result.module_graph).toBeUndefined();
    expect(result.di_graph).toBeUndefined();
    expect(result.guard_chain).toBeUndefined();
    expect(result.route_inventory).toBeUndefined();
  });
});
