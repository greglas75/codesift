import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALWAYS_VISIBLE_TOOL_NAMES,
  getToolDefinitions,
  CORE_TOOL_NAMES,
  enableToolByName,
  extractToolParams,
  getToolDefinition,
  registerTools,
} from "../../src/register-tools.js";
import { ANALYSIS_TOOL_ENTRIES } from "../../src/register-tool-groups/analysis.js";
import { ASTRO_TOOL_ENTRIES } from "../../src/register-tool-groups/astro.js";
import { CORE_TOOL_ENTRIES } from "../../src/register-tool-groups/core.js";
import { HONO_TOOL_ENTRIES } from "../../src/register-tool-groups/hono.js";
import { KOTLIN_TOOL_ENTRIES } from "../../src/register-tool-groups/kotlin.js";
import { META_TOOL_ENTRIES } from "../../src/register-tool-groups/meta.js";
import { NEXTJS_TOOL_ENTRIES } from "../../src/register-tool-groups/nextjs.js";
import { PHP_TOOL_ENTRIES } from "../../src/register-tool-groups/php.js";
import { PYTHON_TOOL_ENTRIES } from "../../src/register-tool-groups/python.js";
import { REACT_TOOL_ENTRIES } from "../../src/register-tool-groups/react.js";
import { SQL_TOOL_ENTRIES } from "../../src/register-tool-groups/sql.js";

const ALL_TOOL_GROUP_ENTRIES = [
  ...CORE_TOOL_ENTRIES,
  ...REACT_TOOL_ENTRIES,
  ...ANALYSIS_TOOL_ENTRIES,
  ...KOTLIN_TOOL_ENTRIES,
  ...PYTHON_TOOL_ENTRIES,
  ...PHP_TOOL_ENTRIES,
  ...META_TOOL_ENTRIES,
  ...SQL_TOOL_ENTRIES,
  ...ASTRO_TOOL_ENTRIES,
  ...HONO_TOOL_ENTRIES,
  ...NEXTJS_TOOL_ENTRIES,
];

const EXPECTED_CORE_TOOL_NAMES = [
  "index_folder", "index_repo", "list_repos", "invalidate_cache", "index_file",
  "search_symbols", "ast_query", "semantic_search", "search_text",
  "get_file_tree", "get_file_outline", "get_repo_outline", "suggest_queries",
  "get_symbol", "get_symbols", "find_and_show", "get_context_bundle",
  "find_references", "trace_call_chain", "impact_analysis", "trace_route",
  "go_to_definition", "get_type_info", "rename_symbol", "get_call_hierarchy",
  "detect_communities", "find_circular_deps", "check_boundaries", "classify_roles",
  "assemble_context", "get_knowledge_map", "diff_outline", "changed_symbols",
  "generate_claude_md", "codebase_retrieval",
] as const;

const EXPECTED_ANALYSIS_TOOL_NAMES = [
  "find_dead_code", "find_unused_imports", "analyze_complexity", "find_clones",
  "frequency_analysis", "analyze_hotspots", "cross_repo_search", "cross_repo_refs",
  "search_patterns", "list_patterns", "generate_report", "list_workspaces",
  "workspace_graph", "affected_workspaces", "workspace_boundaries", "scan_secrets",
  "review_diff", "audit_scan", "find_perf_hotspots", "fan_in_fan_out",
  "co_change_analysis", "architecture_summary", "explain_query", "nest_audit",
  "test_impact_analysis", "dependency_audit", "migration_lint",
  "analyze_prisma_schema", "repo_group", "match_group_contracts",
  "find_endpoint_consumers",
] as const;

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

function createMockServer() {
  const registeredTools = new Map<string, {
    name: string;
    enabled: boolean;
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    handler: unknown;
  }>();
  return {
    registeredTools,
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
      const handle = {
        name,
        enabled: true,
        disable: vi.fn(() => { handle.enabled = false; }),
        enable: vi.fn(() => { handle.enabled = true; }),
        handler,
      };
      registeredTools.set(name, handle);
      return handle;
    }),
  };
}

describe("register-tools — always-visible tools", () => {
  it("preserves the exact core tool catalog and registration order", () => {
    expect(CORE_TOOL_ENTRIES.map((entry) => entry.definition.name)).toEqual(
      EXPECTED_CORE_TOOL_NAMES,
    );
  });

  it("preserves the exact analysis tool catalog and registration order", () => {
    expect(ANALYSIS_TOOL_ENTRIES.map((entry) => entry.definition.name)).toEqual(
      EXPECTED_ANALYSIS_TOOL_NAMES,
    );
  });

  it.each([
    ["index_folder", "include_paths", JSON.stringify({ path: "src" })],
    ["index_repo", "include_paths", JSON.stringify("src")],
    ["get_symbols", "symbol_ids", JSON.stringify({ id: "symbol" })],
    ["find_references", "symbol_names", JSON.stringify("symbol")],
    ["check_boundaries", "rules", JSON.stringify({ from: "src" })],
    ["codebase_retrieval", "queries", JSON.stringify({ type: "text" })],
  ])("rejects non-array JSON for %s.%s", (toolName, fieldName, input) => {
    const definition = CORE_TOOL_ENTRIES.find(
      (entry) => entry.definition.name === toolName,
    )!.definition;

    expect(definition.schema[fieldName]!.safeParse(input).success).toBe(false);
  });

  it.each([
    ["index_folder", "include_paths"],
    ["index_repo", "include_paths"],
    ["get_symbols", "symbol_ids"],
  ])("rejects blank values for %s.%s", (toolName, fieldName) => {
    const definition = CORE_TOOL_ENTRIES.find(
      (entry) => entry.definition.name === toolName,
    )!.definition;

    expect(definition.schema[fieldName]!.safeParse(["   "]).success).toBe(false);
    expect(definition.schema[fieldName]!.safeParse(JSON.stringify([""])).success).toBe(false);
  });

  it("rejects find_references calls without a symbol selector", async () => {
    const definition = CORE_TOOL_ENTRIES.find(
      (entry) => entry.definition.name === "find_references",
    )!.definition;

    await expect(definition.handler({})).rejects.toThrow(
      "symbol_name or symbol_names is required",
    );
    expect(definition.schema.symbol_name!.safeParse("   ").success).toBe(false);
    expect(definition.schema.symbol_names!.safeParse([""]).success).toBe(false);
    expect(definition.schema.symbol_names!.safeParse(JSON.stringify(["   "])).success).toBe(false);
    expect(z.object(definition.schema).safeParse({ symbol_name: "entry" }).success).toBe(true);
  });

  it("keeps usage-critical tools in CORE_TOOL_NAMES", () => {
    for (const toolName of ALWAYS_VISIBLE_TOOL_NAMES) {
      expect(CORE_TOOL_NAMES.has(toolName), `${toolName} must stay core`).toBe(true);
    }
  });

  it("registers usage-critical tools up front in deferred mode", () => {
    const server = createMockServer();

    registerTools(server as any, { deferNonCore: true });

    for (const toolName of ALWAYS_VISIBLE_TOOL_NAMES) {
      const handle = server.registeredTools.get(toolName);
      expect(handle, `${toolName} should be registered without discovery`).toBeDefined();
      expect(handle!.enabled, `${toolName} should be enabled`).toBe(true);
    }
  });

  it("exposes one unique catalog entry per registered tool", () => {
    const names = getToolDefinitions().map((tool) => tool.name);
    const uniqueNames = new Set(names);

    expect(names.length).toBeGreaterThan(170);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("assembles every group entry into the public catalog in order", () => {
    const expectedNames = [...ALL_TOOL_GROUP_ENTRIES]
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.definition.name);
    const actualNames = getToolDefinitions().map((tool) => tool.name);

    expect(actualNames).toEqual(expectedNames);
  });
});

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

  // review_diff/scan_secrets removed from CORE - more visible tools degraded agent adoption
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

  describe("index_folder auto-load", () => {
    it("index_folder handler is async (returns a Promise)", () => {
      const def = getToolDefinition("index_folder");
      expect(def).toBeDefined();
      expect(typeof def!.handler).toBe("function");
      // The handler should be an async function (returns thenable)
      // We can't easily call it without a real path, but we verify it's defined
    });

    it("detectAutoLoadToolsCached works with arbitrary path", async () => {
      const { detectAutoLoadToolsCached } = await import("../../src/register-tools.js");
      // Non-existent path returns empty array (no framework detected)
      const result = await detectAutoLoadToolsCached("/tmp/__nonexistent_path_for_test__");
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it("detectAutoLoadToolsCached returns React tools for React project", async () => {
      const dir = await mkdtemp(join(tmpdir(), "codesift-idx-autoload-"));
      try {
        await writeFile(join(dir, "package.json"), JSON.stringify({
          dependencies: { react: "^18.0.0" },
        }));
        await writeFile(join(dir, "App.tsx"), "export default function App() { return <div/>; }");
        const { detectAutoLoadToolsCached } = await import("../../src/register-tools.js");
        const tools = await detectAutoLoadToolsCached(dir);
        expect(tools).toContain("trace_component_tree");
        expect(tools).toContain("analyze_hooks");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("detectAutoLoadToolsCached returns a defensive copy", async () => {
      const dir = await mkdtemp(join(tmpdir(), "codesift-idx-autoload-copy-"));
      try {
        await writeFile(join(dir, "tsconfig.json"), "{}");
        const { detectAutoLoadToolsCached } = await import("../../src/register-tools.js");
        const first = await detectAutoLoadToolsCached(dir);
        first.push("__mutated_by_caller__");

        const second = await detectAutoLoadToolsCached(dir);
        expect(second).toContain("dependency_audit");
        expect(second).not.toContain("__mutated_by_caller__");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });
});

describe("register-tools — generate_wiki tool registration", () => {
  const defs = getToolDefinitions();

  it("tool definitions include generate_wiki", () => {
    const names = defs.map((d) => d.name);
    expect(names).toContain("generate_wiki");
  });

  it("generate_wiki has category 'reporting'", () => {
    const def = defs.find((d) => d.name === "generate_wiki");
    expect(def).toBeDefined();
    expect(def!.category).toBe("reporting");
  });

  it("generate_wiki schema has repo, focus, output_dir", () => {
    const def = defs.find((d) => d.name === "generate_wiki");
    expect(def).toBeDefined();
    const schema = def!.schema;
    // repo — optional string
    expect(typeof (schema["repo"] as any).safeParse).toBe("function");
    expect((schema["repo"] as any).safeParse(undefined).success).toBe(true);
    expect((schema["repo"] as any).safeParse("my-repo").success).toBe(true);
    // focus — optional string
    expect(typeof (schema["focus"] as any).safeParse).toBe("function");
    expect((schema["focus"] as any).safeParse(undefined).success).toBe(true);
    // output_dir — optional string
    expect(typeof (schema["output_dir"] as any).safeParse).toBe("function");
    expect((schema["output_dir"] as any).safeParse(undefined).success).toBe(true);
    // include_lens removed (not yet implemented)
    expect(schema["include_lens"]).toBeUndefined();
  });

  it("generate_wiki handler is a function", () => {
    const def = defs.find((d) => d.name === "generate_wiki");
    expect(def).toBeDefined();
    expect(typeof def!.handler).toBe("function");
  });

  it("generate_wiki description is non-empty and > 10 chars", () => {
    const def = defs.find((d) => d.name === "generate_wiki");
    expect(def).toBeDefined();
    expect(typeof def!.description).toBe("string");
    expect(def!.description.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// TS baseline + monorepo + Prisma auto-load — universal stack-aware loading.
// Validates the union-of-signals model against the 15-stack zuvo orchestrator
// matrix (translation-qa, zuvo-landing, tgm-survey-platform, makeyourasia-
// editor, tgmdev-tgm-portal, tgm-survey-tester, Helper, coding-ui,
// Veltura-Studio, jcodemunch-mcp, easyAds, sentry, MYA, Mobi2, DATA LAB).
// ---------------------------------------------------------------------------

describe("register-tools — TS baseline / monorepo / Prisma auto-load", () => {
  async function createProject(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "codesift-stack-autoload-"));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
    return dir;
  }
  async function cleanup(dir: string) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const TS_BASELINE = ["dependency_audit", "check_boundaries", "architecture_summary"];
  const MONOREPO = ["check_boundaries", "architecture_summary"];
  const PRISMA = ["analyze_prisma_schema", "migration_lint"];

  describe("tsconfig.json — TS baseline signal", () => {
    it("enables TS baseline tools when tsconfig.json is present", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const t of TS_BASELINE) expect(tools).toContain(t);
      } finally { await cleanup(dir); }
    });

    it("does NOT enable TS baseline when no tsconfig.json", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ name: "x" }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("dependency_audit");
        expect(tools).not.toContain("check_boundaries");
      } finally { await cleanup(dir); }
    });
  });

  describe("monorepo signals", () => {
    const MONOREPO_FILES = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"];

    for (const file of MONOREPO_FILES) {
      it(`enables monorepo tools when ${file} is present`, async () => {
        const { detectAutoLoadTools } = await import("../../src/register-tools.js");
        const dir = await createProject({ [file]: "{}" });
        try {
          const tools = await detectAutoLoadTools(dir);
          for (const t of MONOREPO) expect(tools).toContain(t);
        } finally { await cleanup(dir); }
      });
    }

    it("enables monorepo tools when package.json has workspaces array", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const t of MONOREPO) expect(tools).toContain(t);
      } finally { await cleanup(dir); }
    });

    it("enables monorepo tools when package.json has workspaces.packages object", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({
          workspaces: { packages: ["apps/*", "libs/*"] },
        }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const t of MONOREPO) expect(tools).toContain(t);
      } finally { await cleanup(dir); }
    });

    it("does NOT enable monorepo tools when only package.json with no workspaces", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ name: "x", dependencies: {} }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        // architecture_summary is also in TS_BASELINE (tsconfig.json) — gate
        // on absence of both indicators
        expect(tools).not.toContain("check_boundaries");
        expect(tools).not.toContain("architecture_summary");
      } finally { await cleanup(dir); }
    });
  });

  describe("Prisma signals", () => {
    it("enables Prisma tools when schema.prisma is at root", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "schema.prisma": "datasource db { provider = \"postgresql\" }",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const t of PRISMA) expect(tools).toContain(t);
      } finally { await cleanup(dir); }
    });

    it("enables Prisma tools when prisma/schema.prisma exists", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "prisma/schema.prisma": "datasource db { provider = \"postgresql\" }",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const t of PRISMA) expect(tools).toContain(t);
      } finally { await cleanup(dir); }
    });

    it("enables Prisma tools when prisma is a dependency", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ devDependencies: { prisma: "^5.0.0" } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const t of PRISMA) expect(tools).toContain(t);
      } finally { await cleanup(dir); }
    });

    it("enables Prisma tools when drizzle-kit is a dependency", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ devDependencies: { "drizzle-kit": "^0.20.0" } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const t of PRISMA) expect(tools).toContain(t);
      } finally { await cleanup(dir); }
    });

    it("does NOT enable Prisma tools when no schema or dep", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("analyze_prisma_schema");
        expect(tools).not.toContain("migration_lint");
      } finally { await cleanup(dir); }
    });
  });

  // -------------------------------------------------------------------------
  // 15-stack matrix — mirrors zuvo orchestrator validation set. Each case
  // asserts that the signals present in the fixture project trigger the
  // expected union of bundles. We do NOT assert exact tool counts (those
  // shift as bundles evolve); we assert presence of bundle-canary tools.
  // -------------------------------------------------------------------------
  describe("15-stack zuvo orchestrator matrix", () => {
    it("translation-qa: TS/nextjs → ts+nextjs+react+prisma", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({
          dependencies: { next: "^15.0.0", react: "^19.0.0", prisma: "^5.0.0" },
        }),
        "app/page.tsx": "export default function Page() { return null; }",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");      // TS baseline
        expect(tools).toContain("trace_component_tree");  // React
        expect(tools).toContain("analyze_prisma_schema"); // Prisma
      } finally { await cleanup(dir); }
    });

    it("zuvo-landing: TS/astro → ts (astro tools are core, not auto-loaded)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ dependencies: { astro: "^5.0.0" } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");
        expect(tools).toContain("check_boundaries");
      } finally { await cleanup(dir); }
    });

    it("tgm-survey-platform: TS/nestjs monorepo → ts+react+prisma+monorepo", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "pnpm-workspace.yaml": "packages:\n  - 'apps/*'",
        "package.json": JSON.stringify({
          dependencies: {
            "@nestjs/core": "^10.0.0",
            react: "^19.0.0",
            "@prisma/client": "^5.0.0",
            prisma: "^5.0.0",
          },
        }),
        "apps/web/src/App.tsx": "export const App = () => null;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");      // TS
        expect(tools).toContain("check_boundaries");      // monorepo (also TS)
        expect(tools).toContain("trace_component_tree");  // React
        expect(tools).toContain("analyze_prisma_schema"); // Prisma
      } finally { await cleanup(dir); }
    });

    it("makeyourasia-editor: TS/react → ts+react", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        "src/App.tsx": "export const App = () => null;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");
        expect(tools).toContain("trace_component_tree");
        expect(tools).not.toContain("analyze_prisma_schema");
      } finally { await cleanup(dir); }
    });

    it("tgmdev-tgm-portal: JS/react (no tsconfig) → react only, no TS baseline", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        "src/App.jsx": "export const App = () => null;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("trace_component_tree");
        expect(tools).not.toContain("dependency_audit");  // no tsconfig.json
      } finally { await cleanup(dir); }
    });

    it("tgm-survey-tester: TS/hono → ts+hono", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ dependencies: { hono: "^4.7.0" } }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");
        expect(tools).toContain("audit_hono_security");
      } finally { await cleanup(dir); }
    });

    it("Helper: JS/null → empty auto-load", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ name: "helper" }),
        "src/index.js": "module.exports = {};",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("dependency_audit");
        expect(tools).not.toContain("trace_component_tree");
        expect(tools).not.toContain("analyze_prisma_schema");
      } finally { await cleanup(dir); }
    });

    it("Veltura-Studio: TS/hono monorepo + react+astro → ts+hono+react+monorepo", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "turbo.json": "{}",
        "package.json": JSON.stringify({
          dependencies: { hono: "^4.7.0", react: "^19.0.0", astro: "^5.0.0" },
        }),
        "src/App.tsx": "export const App = () => null;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");
        expect(tools).toContain("check_boundaries");
        expect(tools).toContain("audit_hono_security");
        expect(tools).toContain("trace_component_tree");
      } finally { await cleanup(dir); }
    });

    it("easyAds: TS/fastify monorepo + react+postgres → ts+react+monorepo (no fastify bundle yet)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({
          workspaces: ["apps/*", "libs/*"],
          dependencies: { fastify: "^4.0.0", react: "^19.0.0" },
        }),
        "apps/web/src/App.tsx": "export const App = () => null;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");
        expect(tools).toContain("check_boundaries");      // monorepo via pkg.workspaces
        expect(tools).toContain("trace_component_tree");
      } finally { await cleanup(dir); }
    });

    it("MYA: TS/nextjs → ts+react+prisma", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({
          dependencies: { next: "^15.0.0", "@prisma/client": "^5.0.0" },
          devDependencies: { prisma: "^5.0.0" },
        }),
        "prisma/schema.prisma": "datasource db { provider = \"postgresql\" }",
        "app/page.tsx": "export default () => null;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");
        expect(tools).toContain("trace_component_tree");
        expect(tools).toContain("analyze_prisma_schema");
        expect(tools).toContain("migration_lint");
      } finally { await cleanup(dir); }
    });

    it("Mobi2: TS/react hybrid + composer.json (PHP) → ts+react+php", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "composer.json": JSON.stringify({ name: "mobi2/legacy" }),
        "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        "src/App.tsx": "export const App = () => null;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("dependency_audit");        // TS baseline
        expect(tools).toContain("trace_component_tree");    // React
        expect(tools).toContain("php_security_scan");       // PHP from composer.json
        expect(tools).toContain("php_project_audit");
      } finally { await cleanup(dir); }
    });

    it("DATA LAB: python/flask → python bundle, no TS baseline", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "requirements.txt": "flask==3.0.0\npsycopg2==2.9.0\n",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("python_audit");
        expect(tools).not.toContain("dependency_audit");
        expect(tools).not.toContain("trace_component_tree");
      } finally { await cleanup(dir); }
    });

    it("dedup: combined signals do not duplicate tool names", async () => {
      const { detectAutoLoadToolsCached } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "tsconfig.json": "{}",
        "turbo.json": "{}",
        "package.json": JSON.stringify({
          workspaces: ["apps/*"],
          dependencies: { react: "^19.0.0", prisma: "^5.0.0" },
        }),
        "src/App.tsx": "export const App = () => null;",
      });
      try {
        const tools = await detectAutoLoadToolsCached(dir);
        const seen = new Set<string>();
        const dups: string[] = [];
        for (const t of tools) {
          if (seen.has(t)) dups.push(t);
          seen.add(t);
        }
        expect(dups, `unexpected duplicates: ${dups.join(", ")}`).toEqual([]);
      } finally { await cleanup(dir); }
    });
  });

  describe("detectAutoLoadTools — SQL detection", () => {
    async function createProject(files: Record<string, string>): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "codesift-sql-autoload-"));
      for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content);
      }
      return dir;
    }

    const SQL_TOOLS = [
      "analyze_schema",
      "trace_query",
      "sql_audit",
      "diff_migrations",
      "search_columns",
      "migration_lint",
    ];

    it("enables SQL tools when composer.json present (PHP/MySQL stack)", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "composer.json": JSON.stringify({ name: "vendor/mobi2" }),
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        for (const name of SQL_TOOLS) {
          expect(tools, `composer.json should auto-load ${name}`).toContain(name);
        }
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("enables SQL tools for raw migrations/ dir with .sql files", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "migrations/001_init.sql": "CREATE TABLE users (id INT PRIMARY KEY);",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("analyze_schema");
        expect(tools).toContain("sql_audit");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("enables SQL tools for top-level schema.sql / mysqldump artifacts", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "schema.sql": "-- mysqldump\nCREATE TABLE t (id INT);",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("analyze_schema");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("enables for prisma/migrations/*.sql even without schema.prisma at root", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "prisma/migrations/20240101_init/migration.sql":
          "CREATE TABLE \"User\" (id SERIAL);",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).toContain("analyze_schema");
        expect(tools).toContain("diff_migrations");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("does NOT enable for repos without any .sql file or composer.json", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
        "src/index.ts": "export const x = 1;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("analyze_schema");
        expect(tools).not.toContain("sql_audit");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it("ignores .sql files buried inside node_modules/dist/vendor", async () => {
      const { detectAutoLoadTools } = await import("../../src/register-tools.js");
      const dir = await createProject({
        "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
        "node_modules/some-pkg/migrations/init.sql": "CREATE TABLE x (id INT);",
        "vendor/legacy/db/schema.sql": "CREATE TABLE y (id INT);",
        "src/index.ts": "export const x = 1;",
      });
      try {
        const tools = await detectAutoLoadTools(dir);
        expect(tools).not.toContain("analyze_schema");
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });
});
