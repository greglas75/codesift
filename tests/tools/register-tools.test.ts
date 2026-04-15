import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getToolDefinitions, CORE_TOOL_NAMES, enableToolByName, extractToolParams, getToolDefinition } from "../../src/register-tools.js";

// All Astro tools (registered in TOOL_DEFINITIONS)
const ASTRO_TOOL_NAMES = [
  "astro_analyze_islands",
  "astro_hydration_audit",
  "astro_route_map",
  "astro_config_analyze",
  "astro_content_collections",
] as const;

// Core Astro tools (visible in ListTools by default — subset of ASTRO_TOOL_NAMES)
// astro_hydration_audit is demoted to discoverable since astro_audit provides full coverage
const ASTRO_CORE_TOOL_NAMES = [
  "astro_analyze_islands",
  "astro_route_map",
  "astro_config_analyze",
  "astro_content_collections",
] as const;

describe("register-tools — astro tools registration", () => {
  const defs = getToolDefinitions();

  it("all astro tools exist in TOOL_DEFINITIONS", () => {
    const names = defs.map((d) => d.name);
    for (const toolName of ASTRO_TOOL_NAMES) {
      expect(names, `${toolName} should be in TOOL_DEFINITIONS`).toContain(toolName);
    }
  });

  for (const toolName of ASTRO_TOOL_NAMES) {
    describe(`${toolName}`, () => {
      it("has required fields: name, category, description, schema, handler", () => {
        const def = defs.find((d) => d.name === toolName);
        expect(def).toBeDefined();
        expect(typeof def!.name).toBe("string");
        expect(typeof def!.category).toBe("string");
        expect(typeof def!.description).toBe("string");
        expect(def!.description.length).toBeGreaterThan(10);
        expect(typeof def!.schema).toBe("object");
        expect(typeof def!.handler).toBe("function");
      });

      it("schema is a valid Zod schema (each field has .safeParse)", () => {
        const def = defs.find((d) => d.name === toolName)!;
        for (const [key, zodType] of Object.entries(def.schema)) {
          expect(
            typeof (zodType as any).safeParse,
            `schema.${key} should be a Zod type with .safeParse`,
          ).toBe("function");
          // Should not throw when called
          expect(() => (zodType as any).safeParse(undefined)).not.toThrow();
        }
      });
    });
  }

  it("core astro tools are in CORE_TOOL_NAMES", () => {
    for (const toolName of ASTRO_CORE_TOOL_NAMES) {
      expect(
        CORE_TOOL_NAMES.has(toolName),
        `${toolName} should be in CORE_TOOL_NAMES`,
      ).toBe(true);
    }
  });

  it("astro_hydration_audit is NOT in CORE_TOOL_NAMES (demoted to discoverable)", () => {
    expect(CORE_TOOL_NAMES.has("astro_hydration_audit")).toBe(false);
  });
});

describe("register-tools — React tools registration & auto-load", () => {
  const defs = getToolDefinitions();
  const REACT_TOOLS = ["trace_component_tree", "analyze_hooks", "analyze_renders"];

  it("all 3 React tools exist in TOOL_DEFINITIONS", () => {
    const names = defs.map((d) => d.name);
    for (const name of REACT_TOOLS) {
      expect(names, `${name} should be registered`).toContain(name);
    }
  });

  for (const name of REACT_TOOLS) {
    it(`${name} has required fields`, () => {
      const def = defs.find((d) => d.name === name);
      expect(def).toBeDefined();
      expect(def!.description.length).toBeGreaterThan(20);
      expect(typeof def!.handler).toBe("function");
    });
  }

  describe("detectAutoLoadTools — React detection", () => {
    async function createProject(files: Record<string, string>): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "codesift-react-autoload-"));
      for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content);
      }
      return dir;
    }

    it("enables React tools when package.json has react + .tsx files exist", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        "src/App.tsx": "export function App() { return null; }",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("trace_component_tree");
        expect(tools).toContain("analyze_hooks");
        expect(tools).toContain("analyze_renders");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("enables React tools for nested .tsx (src/components/Foo.tsx)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        "src/components/Foo.tsx": "export function Foo() { return null; }",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("trace_component_tree");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does NOT enable when package.json has react but no .tsx/.jsx files", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        "src/index.ts": "export const x = 1;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("trace_component_tree");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does NOT enable when no react dep (even with .tsx files)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
        "src/App.tsx": "export const App = 1;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("trace_component_tree");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("enables for Next.js projects (next dep counts as react)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { next: "^15.0.0" } }),
        "app/page.tsx": "export default function Page() { return null; }",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("trace_component_tree");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("skips node_modules and dist directories", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        "node_modules/foo/App.tsx": "// transitive dep file",
        "dist/App.tsx": "// build output",
        "src/index.ts": "export const x = 1;",  // no .tsx in actual source
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("trace_component_tree");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });

  describe("detectAutoLoadTools — Hono detection", () => {
    async function createProject(files: Record<string, string>): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "codesift-hono-autoload-"));
      for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content);
      }
      return dir;
    }

    it("enables all 9 hidden Hono tools when package.json has hono dep", async () => {
      // After polish consolidation (13 → 11 tools):
      // - trace_conditional_middleware absorbed into trace_middleware_chain (core)
      // - detect_middleware_env_regression absorbed into audit_hono_security
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { hono: "^4.7.0" } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        // Phase 1 (5)
        expect(tools).toContain("trace_context_flow");
        expect(tools).toContain("extract_api_contract");
        expect(tools).toContain("trace_rpc_types");
        expect(tools).toContain("audit_hono_security");
        expect(tools).toContain("visualize_hono_routes");
        // Phase 2 additions that remained standalone (4)
        expect(tools).toContain("analyze_inline_handler");
        expect(tools).toContain("extract_response_types");
        expect(tools).toContain("detect_hono_modules");
        expect(tools).toContain("find_dead_hono_routes");
        // Merged tools should NOT appear anymore
        expect(tools).not.toContain("trace_conditional_middleware");
        expect(tools).not.toContain("detect_middleware_env_regression");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("Phase 2 remaining tools are defined in TOOL_DEFINITIONS and handler-resolvable", async () => {
      const { getToolDefinitions } = await import("../../src/register-tools.js");
      const defs = getToolDefinitions();
      const names = defs.map((d) => d.name);
      for (const phase2 of [
        "analyze_inline_handler",
        "extract_response_types",
        "detect_hono_modules",
        "find_dead_hono_routes",
      ]) {
        expect(names, `${phase2} should be registered`).toContain(phase2);
        const def = defs.find((d) => d.name === phase2)!;
        expect(def.description.length).toBeGreaterThan(50);
        expect(typeof def.handler).toBe("function");
      }
    });

    it("merged tools are gone from TOOL_DEFINITIONS", async () => {
      const { getToolDefinitions } = await import("../../src/register-tools.js");
      const names = getToolDefinitions().map((d) => d.name);
      expect(names).not.toContain("trace_conditional_middleware");
      expect(names).not.toContain("detect_middleware_env_regression");
    });

    it("enables for @hono/zod-openapi dep", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({
          dependencies: { "@hono/zod-openapi": "^0.16.0" },
        }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("extract_api_contract");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("enables for @hono/node-server dep (node deployment)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({
          dependencies: { "@hono/node-server": "^1.19.0" },
        }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("trace_rpc_types");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("enables when hono is in devDependencies", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({
          devDependencies: { hono: "^4.7.0" },
        }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("audit_hono_security");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does NOT enable when no hono dep present", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("trace_context_flow");
        expect(tools).not.toContain("audit_hono_security");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("coexists with React detection (both apply if both deps present)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({
          dependencies: { hono: "^4.7.0", react: "^19.0.0" },
        }),
        "src/App.tsx": "export function App() { return null; }",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("trace_component_tree"); // React
        expect(tools).toContain("audit_hono_security"); // Hono
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });

  describe("exported accessors", () => {
    it("enableToolByName returns false for unknown tool", () => {
      expect(enableToolByName("__not_a_tool__")).toBe(false);
    });

    it("getToolDefinition returns definition for known tool", () => {
      const def = getToolDefinition("search_text");
      expect(def).toBeDefined();
      expect(def!.name).toBe("search_text");
    });

    it("getToolDefinition returns undefined for unknown tool", () => {
      expect(getToolDefinition("__nonexistent__")).toBeUndefined();
    });

    it("extractToolParams returns param array with name/required/description", () => {
      const def = getToolDefinition("search_text");
      expect(def).toBeDefined();
      const params = extractToolParams(def!);
      expect(Array.isArray(params)).toBe(true);
      expect(params.length).toBeGreaterThan(0);
      for (const p of params) {
        expect(p).toHaveProperty("name");
        expect(p).toHaveProperty("required");
        expect(p).toHaveProperty("description");
      }
    });

    it("extractToolParams returns cached result on second call", () => {
      const def = getToolDefinition("search_text")!;
      const first = extractToolParams(def);
      const second = extractToolParams(def);
      expect(first).toBe(second); // same reference
    });
  });
});
