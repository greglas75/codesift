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
  classifyRendering,
} from "../../src/tools/nextjs-route-tools.js";
import type { RouteSegmentConfig } from "../../src/tools/nextjs-route-tools.js";
import { parseFile } from "../../src/parser/parser-manager.js";

const baseConfig = (): RouteSegmentConfig => ({ has_generate_static_params: false });

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

describe("classifyRendering", () => {
  it("row 1: App Router, force-dynamic -> ssr", () => {
    expect(
      classifyRendering({ ...baseConfig(), dynamic: "force-dynamic" }, "app"),
    ).toBe("ssr");
  });

  it("row 2: App Router, force-static -> static", () => {
    expect(
      classifyRendering({ ...baseConfig(), dynamic: "force-static" }, "app"),
    ).toBe("static");
  });

  it("row 3: App Router, revalidate = 60 -> isr", () => {
    expect(classifyRendering({ ...baseConfig(), revalidate: 60 }, "app")).toBe(
      "isr",
    );
  });

  it("row 4: App Router, runtime = edge -> edge", () => {
    expect(classifyRendering({ ...baseConfig(), runtime: "edge" }, "app")).toBe(
      "edge",
    );
  });

  it("row 5: App Router, has_generate_static_params -> static", () => {
    expect(
      classifyRendering({ ...baseConfig(), has_generate_static_params: true }, "app"),
    ).toBe("static");
  });

  it("row 6: App Router, no config -> static (Next.js default)", () => {
    expect(classifyRendering(baseConfig(), "app")).toBe("static");
  });

  it("row 7: Pages Router, hasGetServerSideProps -> ssr", () => {
    expect(
      classifyRendering(baseConfig(), "pages", { hasGetServerSideProps: true }),
    ).toBe("ssr");
  });

  it("row 8: Pages Router, hasGetStaticProps without revalidate -> static", () => {
    expect(
      classifyRendering(baseConfig(), "pages", {
        hasGetStaticProps: true,
        hasRevalidateInReturn: false,
      }),
    ).toBe("static");
  });
});
