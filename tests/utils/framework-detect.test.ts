import { describe, it, expect } from "vitest";
import { isFrameworkEntryPoint, detectFrameworks, type Framework } from "../../src/utils/framework-detect.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

function sym(name: string, file: string): Pick<CodeSymbol, "name" | "file"> {
  return { name, file };
}

function nestFrameworks(): Set<Framework> {
  return new Set(["nestjs"]);
}

describe("isFrameworkEntryPoint — NestJS", () => {
  // --- Lifecycle hooks (already implemented, regression tests) ---

  it.each([
    "onModuleInit",
    "onModuleDestroy",
    "onApplicationBootstrap",
    "onApplicationShutdown",
    "beforeApplicationShutdown",
  ])("returns true for lifecycle hook %s", (hook) => {
    expect(isFrameworkEntryPoint(sym(hook, "src/auth/auth.service.ts"), nestFrameworks())).toBe(true);
  });

  // --- Controller/resolver/gateway files (already implemented, regression) ---

  it.each([
    "src/users/users.controller.ts",
    "src/auth/auth.resolver.ts",
    "src/events/events.gateway.ts",
  ])("returns true for any symbol in %s", (file) => {
    expect(isFrameworkEntryPoint(sym("someMethod", file), nestFrameworks())).toBe(true);
  });

  // --- NEW: guard/interceptor/pipe/filter files (the gap) ---

  it.each([
    "src/auth/roles.guard.ts",
    "src/common/logging.interceptor.ts",
    "src/common/validation.pipe.ts",
    "src/common/http-exception.filter.ts",
    "src/auth/jwt.guard.js",
  ])("returns true for any symbol in %s", (file) => {
    expect(isFrameworkEntryPoint(sym("canActivate", file), nestFrameworks())).toBe(true);
  });

  // --- NEW: main.ts bootstrap ---

  it("returns true for bootstrap in main.ts", () => {
    expect(isFrameworkEntryPoint(sym("bootstrap", "src/main.ts"), nestFrameworks())).toBe(true);
  });

  it("returns true for bootstrap in root main.ts", () => {
    expect(isFrameworkEntryPoint(sym("bootstrap", "main.ts"), nestFrameworks())).toBe(true);
  });

  it("returns false for bootstrap in non-main file", () => {
    expect(isFrameworkEntryPoint(sym("bootstrap", "src/utils/bootstrap-helper.ts"), nestFrameworks())).toBe(false);
  });

  // --- Negative cases ---

  it("returns false for partial lifecycle hook match (onModuleInitialize)", () => {
    expect(isFrameworkEntryPoint(sym("onModuleInitialize", "src/app.service.ts"), nestFrameworks())).toBe(false);
  });

  it("returns false when nestjs is not in frameworks", () => {
    const reactOnly = new Set<Framework>(["react"]);
    expect(isFrameworkEntryPoint(sym("onModuleInit", "src/app.service.ts"), reactOnly)).toBe(false);
    expect(isFrameworkEntryPoint(sym("someMethod", "src/users.controller.ts"), reactOnly)).toBe(false);
  });

  it("returns false for .controller.spec.ts (test files excluded by regex)", () => {
    // The regex requires .[jt]sx? after the dot, so .spec.ts won't match
    expect(isFrameworkEntryPoint(sym("someMethod", "src/users/users.controller.spec.ts"), nestFrameworks())).toBe(false);
  });

  it("returns false for regular service file", () => {
    expect(isFrameworkEntryPoint(sym("findAll", "src/users/users.service.ts"), nestFrameworks())).toBe(false);
  });

  // Task 5: G7/G8 — scheduled jobs and event handlers as entry points
  it.each([
    "handleCron",
    "handleInterval",
    "handleTimeout",
    "handleEvent",
  ])("returns true for scheduled/event hook %s", (name) => {
    expect(isFrameworkEntryPoint(sym(name, "src/jobs/billing.service.ts"), nestFrameworks())).toBe(true);
  });

  it("returns false for partial match handleCronJob (not in regex)", () => {
    expect(isFrameworkEntryPoint(sym("handleCronJob", "src/jobs/billing.service.ts"), nestFrameworks())).toBe(false);
  });
});

describe("detectFrameworks", () => {
  function mockIndex(sources: string[]): CodeIndex {
    return {
      root: "/tmp/test",
      files: [],
      symbols: sources.map((source, i) => ({
        id: `s${i}`,
        name: `sym${i}`,
        kind: "function" as const,
        file: `file${i}.ts`,
        start_line: 1,
        end_line: 1,
        source,
      })),
    } as unknown as CodeIndex;
  }

  it("detects nestjs from @nestjs/ import", () => {
    const index = mockIndex(["import { Module } from '@nestjs/common';"]);
    const frameworks = detectFrameworks(index);
    expect(frameworks.has("nestjs")).toBe(true);
  });

  it("detects nestjs from NestFactory", () => {
    const index = mockIndex(["const app = await NestFactory.create(AppModule);"]);
    const frameworks = detectFrameworks(index);
    expect(frameworks.has("nestjs")).toBe(true);
  });

  it("does not detect nestjs without indicators", () => {
    const index = mockIndex(["const x = 1;"]);
    const frameworks = detectFrameworks(index);
    expect(frameworks.has("nestjs")).toBe(false);
  });

  // G7/G8 — NestJS sub-packages
  it("detects nestjs from @nestjs/schedule import", () => {
    const index = mockIndex(["import { Cron } from '@nestjs/schedule';"]);
    expect(detectFrameworks(index).has("nestjs")).toBe(true);
  });

  it("detects nestjs from @nestjs/event-emitter import", () => {
    const index = mockIndex(["import { OnEvent } from '@nestjs/event-emitter';"]);
    expect(detectFrameworks(index).has("nestjs")).toBe(true);
  });

  it("detects nestjs from @nestjs/graphql import", () => {
    const index = mockIndex(["import { Resolver, Query } from '@nestjs/graphql';"]);
    expect(detectFrameworks(index).has("nestjs")).toBe(true);
  });

  it("detects nestjs from @nestjs/websockets import", () => {
    const index = mockIndex(["import { WebSocketGateway } from '@nestjs/websockets';"]);
    expect(detectFrameworks(index).has("nestjs")).toBe(true);
  });

  it("detects nestjs from @nestjs/microservices import", () => {
    const index = mockIndex(["import { MessagePattern } from '@nestjs/microservices';"]);
    expect(detectFrameworks(index).has("nestjs")).toBe(true);
  });
});
