import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock getCodeIndex for orchestrator integration tests (Task 30)
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import {
  nextjsRouteMap,
  readRouteSegmentConfig,
} from "../../src/tools/nextjs-route-tools.js";
import { parseFile } from "../../src/parser/parser-manager.js";

describe("nextjs-route-tools exports", () => {
  it("exports nextjsRouteMap function", () => {
    expect(typeof nextjsRouteMap).toBe("function");
  });
});

async function parseSource(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "nextjs-route-"));
  const p = join(dir, "x.tsx");
  await writeFile(p, source);
  const tree = await parseFile(p, source);
  if (!tree) throw new Error("parse failed");
  return { tree, source };
}

describe("readRouteSegmentConfig", () => {
  it("reads dynamic = 'force-dynamic'", async () => {
    const { tree, source } = await parseSource(
      `export const dynamic = "force-dynamic";\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.dynamic).toBe("force-dynamic");
  });

  it("reads revalidate = 60", async () => {
    const { tree, source } = await parseSource(`export const revalidate = 60;\n`);
    const config = readRouteSegmentConfig(tree, source);
    expect(config.revalidate).toBe(60);
  });

  it("reads revalidate = false", async () => {
    const { tree, source } = await parseSource(
      `export const revalidate = false;\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.revalidate).toBe(false);
  });

  it("reads runtime = 'edge'", async () => {
    const { tree, source } = await parseSource(`export const runtime = "edge";\n`);
    const config = readRouteSegmentConfig(tree, source);
    expect(config.runtime).toBe("edge");
  });

  it("marks dynamic = <identifier> as dynamic_non_literal", async () => {
    const { tree, source } = await parseSource(
      `export const dynamic = someVar;\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.dynamic).toBeUndefined();
    expect(config.dynamic_non_literal).toBe(true);
  });

  it("detects generateStaticParams", async () => {
    const { tree, source } = await parseSource(
      `export async function generateStaticParams() { return []; }\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.has_generate_static_params).toBe(true);
  });
});
