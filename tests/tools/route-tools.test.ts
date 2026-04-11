import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findNestJSHandlers } from "../../src/tools/route-tools.js";
import type { CodeIndex } from "../../src/types.js";

let tmpRoot: string;

function mockIndex(root: string, files: string[]): CodeIndex {
  return {
    root,
    files: files.map((p) => ({ path: p, size: 100 })),
    symbols: [],
  } as unknown as CodeIndex;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "nest-route-"));
  await mkdir(join(tmpRoot, "src/users"), { recursive: true });
  await mkdir(join(tmpRoot, "src/auth"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("findNestJSHandlers — string-literal paths (regression)", () => {
  it("finds handler with @Controller('api') + @Get('users')", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('api')
export class UsersController {
  @Get('users')
  findAll() { return []; }
}`;
    await writeFile(join(tmpRoot, "src/users/users.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/users.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/api/users");
    expect(handlers.length).toBe(1);
    expect(handlers[0]!.method).toBe("GET");
    expect(handlers[0]!.framework).toBe("nestjs");
  });
});

describe("findNestJSHandlers — empty decorators", () => {
  it("finds handler with @Get() (empty method decorator)", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() { return 'ok'; }
}`;
    await writeFile(join(tmpRoot, "src/users/health.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/health.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/health");
    expect(handlers.length).toBe(1);
    expect(handlers[0]!.method).toBe("GET");
  });

  it("finds handler with @Controller() (empty prefix) + @Get('users')", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('users')
  findUsers() { return []; }
}`;
    await writeFile(join(tmpRoot, "src/users/app.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/app.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/users");
    expect(handlers.length).toBe(1);
  });

  it("finds handler with @Controller() + @Get() (both empty)", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller()
export class RootController {
  @Get()
  root() { return 'hello'; }
}`;
    await writeFile(join(tmpRoot, "src/users/root.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/root.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/");
    expect(handlers.length).toBe(1);
  });
});

describe("findNestJSHandlers — parameterized paths", () => {
  it("finds handler with @Get(':id')", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('api/users')
export class UsersController {
  @Get(':id')
  findOne() { return {}; }
}`;
    await writeFile(join(tmpRoot, "src/users/users.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/users.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/api/users/123");
    expect(handlers.length).toBe(1);
    expect(handlers[0]!.method).toBe("GET");
  });
});

describe("findNestJSHandlers — edge cases", () => {
  it("does not throw on @Get with no parentheses", async () => {
    const source = `
import { Controller } from '@nestjs/common';

@Controller('test')
export class TestController {
  @Get
  noParens() { return 'x'; }
}`;
    await writeFile(join(tmpRoot, "src/users/test.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/test.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/test");
    // Should not throw, but may or may not find the handler (no parens is unusual)
    expect(handlers).toBeDefined();
  });

  it("returns empty array when no controller files exist", async () => {
    const index = mockIndex(tmpRoot, []);
    const handlers = await findNestJSHandlers(index, "/api/users");
    expect(handlers).toEqual([]);
  });
});
