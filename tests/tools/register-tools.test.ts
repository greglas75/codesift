import { describe, it, expect } from "vitest";
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
