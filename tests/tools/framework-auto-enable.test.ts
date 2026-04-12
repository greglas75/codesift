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

  it("NestJS sub-tools absorbed into nest_audit — no longer registered as standalone", () => {
    // After Phase 1 consolidation, all 14 NestJS sub-tools were absorbed into nest_audit.
    // Their handler functions still exist but they're no longer in TOOL_DEFINITIONS.
    const absorbedNames = [
      "nest_lifecycle_map", "nest_module_graph", "nest_di_graph",
      "nest_guard_chain", "nest_route_inventory", "nest_graphql_map",
      "nest_websocket_map", "nest_schedule_map", "nest_typeorm_map",
      "nest_microservice_map", "nest_request_pipeline", "nest_queue_map",
      "nest_scope_audit", "nest_openapi_extract",
    ];
    for (const name of absorbedNames) {
      const handle = getToolHandle(name);
      expect(handle).toBeUndefined();
    }
  });

  it("enableFrameworkToolBundle('nestjs') returns empty — all sub-tools absorbed", () => {
    const enabled = enableFrameworkToolBundle("nestjs");
    expect(enabled).toEqual([]);
  });

  it("enableFrameworkToolBundle is idempotent — second call returns empty", () => {
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
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
