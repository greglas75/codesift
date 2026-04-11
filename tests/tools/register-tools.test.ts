import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getToolDefinitions, CORE_TOOL_NAMES } from "../../src/register-tools.js";

const ASTRO_TOOL_NAMES = [
  "astro_analyze_islands",
  "astro_hydration_audit",
  "astro_route_map",
  "astro_config_analyze",
] as const;

describe("register-tools — astro tools registration", () => {
  const defs = getToolDefinitions();

  it("all 4 astro tools exist in TOOL_DEFINITIONS", () => {
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

  it("all 4 astro tools are in CORE_TOOL_NAMES", () => {
    for (const toolName of ASTRO_TOOL_NAMES) {
      expect(
        CORE_TOOL_NAMES.has(toolName),
        `${toolName} should be in CORE_TOOL_NAMES`,
      ).toBe(true);
    }
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
        await rm(dir, { recursive: true, force: true });
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
        await rm(dir, { recursive: true, force: true });
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
        await rm(dir, { recursive: true, force: true });
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
        await rm(dir, { recursive: true, force: true });
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
        await rm(dir, { recursive: true, force: true });
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
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
