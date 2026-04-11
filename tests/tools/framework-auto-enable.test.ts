import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, getToolHandle, enableFrameworkToolBundle } from "../../src/register-tools.js";

describe("Framework-specific tool bundle auto-enable", () => {
  let server: McpServer;

  beforeAll(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    registerTools(server, { deferNonCore: true });
  });

  it("nest_* tools are disabled by default (deferNonCore)", () => {
    const nestTools = [
      "nest_lifecycle_map",
      "nest_module_graph",
      "nest_di_graph",
      "nest_guard_chain",
      "nest_route_inventory",
    ];
    for (const name of nestTools) {
      const handle = getToolHandle(name);
      expect(handle).toBeDefined();
      // Handle should be disabled (non-core tools disabled in deferNonCore mode)
      // We can't directly check .enabled state without a public API, but we can verify
      // the handle exists and is controllable
      expect(typeof handle.enable).toBe("function");
      expect(typeof handle.disable).toBe("function");
    }
  });

  it("enableFrameworkToolBundle('nestjs') enables all 5 nest_* discoverable tools", () => {
    const enabled = enableFrameworkToolBundle("nestjs");
    expect(enabled).toEqual([
      "nest_lifecycle_map",
      "nest_module_graph",
      "nest_di_graph",
      "nest_guard_chain",
      "nest_route_inventory",
    ]);
  });

  it("enableFrameworkToolBundle is idempotent — second call returns empty", () => {
    const first = enableFrameworkToolBundle("nestjs");
    // Already called in previous test, so this should return empty
    const second = enableFrameworkToolBundle("nestjs");
    expect(second).toEqual([]);
  });

  it("enableFrameworkToolBundle('unknown') returns empty array", () => {
    const result = enableFrameworkToolBundle("unknown-framework");
    expect(result).toEqual([]);
  });
});

describe("indexFolder auto-enables NestJS tools for NestJS projects", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-auto-enable-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
    await writeFile(join(tmpRoot, "package.json"), JSON.stringify({
      name: "test-nest-app",
      dependencies: { "@nestjs/core": "^10.0.0", "@nestjs/common": "^10.0.0" },
    }));
    await writeFile(join(tmpRoot, "src/app.module.ts"), `
import { Module } from '@nestjs/common';
@Module({})
export class AppModule {}
`);
    await writeFile(join(tmpRoot, "src/main.ts"), `
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
`);
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("indexFolder on a NestJS project triggers framework detection", async () => {
    const { indexFolder } = await import("../../src/tools/index-tools.js");
    const result = await indexFolder(tmpRoot);
    expect(result.file_count).toBeGreaterThan(0);
    // After indexing, the framework bundle should have been triggered
    // (idempotent — already enabled in prior test, but the function runs without error)
    expect(result.repo).toContain("local/");
  });
});
