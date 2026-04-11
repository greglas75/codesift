import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, getToolHandle, getToolDefinitions } from "../../src/register-tools.js";

function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lang-gate-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

describe("registerTools language gating", () => {
  beforeEach(() => {
    // Each test creates its own server — registrations reset
  });

  it("disables PHP tools when project has no .php files", () => {
    const root = createProject({
      "src/main.py": "def foo(): pass",
      "README.md": "# docs",
    });
    const server = makeServer();
    registerTools(server, { projectRoot: root });

    const phpTool = getToolHandle("php_security_scan");
    expect(phpTool).toBeDefined();
    // Disabled tools have enabled === false
    // @ts-expect-error — private property access for test
    expect(phpTool.enabled).toBe(false);
  });

  it("enables PHP tools when .php files present", () => {
    const root = createProject({
      "src/User.php": "<?php class User {}",
    });
    const server = makeServer();
    registerTools(server, { projectRoot: root });

    const phpTool = getToolHandle("php_security_scan");
    expect(phpTool).toBeDefined();
    // @ts-expect-error
    expect(phpTool.enabled).toBe(true);
  });

  it("disables Kotlin tools when project has no .kt/.kts files", () => {
    const root = createProject({
      "src/main.py": "def x(): pass",
    });
    const server = makeServer();
    registerTools(server, { projectRoot: root });

    const kotlinTool = getToolHandle("find_extension_functions");
    expect(kotlinTool).toBeDefined();
    // @ts-expect-error
    expect(kotlinTool.enabled).toBe(false);
  });

  it("enables Kotlin tools when .kt files present", () => {
    const root = createProject({
      "src/Main.kt": "fun main() {}",
    });
    const server = makeServer();
    registerTools(server, { projectRoot: root });

    const kotlinTool = getToolHandle("find_extension_functions");
    // @ts-expect-error
    expect(kotlinTool.enabled).toBe(true);
  });

  it("does not disable language-agnostic tools (search_symbols)", () => {
    const root = createProject({
      "src/main.py": "def x(): pass",
    });
    const server = makeServer();
    registerTools(server, { projectRoot: root });

    const searchTool = getToolHandle("search_symbols");
    expect(searchTool).toBeDefined();
    // @ts-expect-error
    expect(searchTool.enabled).toBe(true);
  });

  it("all gated tools in TOOL_DEFINITIONS have requiresLanguage set correctly", () => {
    const defs = getToolDefinitions();
    // PHP tools
    const phpTools = defs.filter((d) => d.name.includes("php"));
    expect(phpTools.length).toBeGreaterThan(0);
    for (const t of phpTools) {
      expect(t.requiresLanguage).toBe("php");
    }
    // Kotlin tools
    const kotlinTools = defs.filter((d) =>
      d.name === "find_extension_functions" || d.name === "analyze_sealed_hierarchy",
    );
    for (const t of kotlinTools) {
      expect(t.requiresLanguage).toBe("kotlin");
    }
  });
});
