/**
 * The Astro tools resolved through `repo` on a REAL index (ADR-004 stage 2).
 *
 * The existing Astro suites drive the `*FromIndex` / `project_root` paths with hand-built fixtures,
 * so the `repo` entry points — which now read the summary, plus the page files' symbols for routes —
 * had no test at all. Each one is checked against the answer it gives with the root handed over
 * directly, or against the full-index path it replaced, so a narrowed read that drops rows shows up
 * as a difference rather than as a smaller, plausible result.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config.js";
import { getCodeIndex, indexFolder } from "../../src/tools/index-tools.js";
import { astroRouteMap, buildRouteEntries } from "../../src/tools/astro-routes.js";
import {
  analyzeIslandsFromIndex,
  astroAnalyzeIslands,
  astroHydrationAudit,
  hydrationAuditFromIndex,
} from "../../src/tools/astro-islands.js";
import { astroActionsAudit, auditAstroActionsFromIndex } from "../../src/tools/astro-actions.js";
import { astroAudit, astroAuditFromIndex } from "../../src/tools/astro-audit.js";
import { astroMiddlewareAudit } from "../../src/tools/astro-middleware.js";
import { astroSessionsAudit } from "../../src/tools/astro-sessions.js";
import { astroDbAudit } from "../../src/tools/astro-db-audit.js";
import { astroEnvValidator } from "../../src/tools/astro-env-validator.js";
import { astroImageAudit } from "../../src/tools/astro-image-audit.js";
import { astroSvgComponents } from "../../src/tools/astro-svg-components.js";
import { astroConfigAnalyze } from "../../src/tools/astro-config.js";
import { astroContentCollections } from "../../src/tools/astro-content-collections.js";
import { ASTRO_TOOL_ENTRIES } from "../../src/register-tool-groups/astro.js";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "astro-narrow", dependencies: { astro: "^5.0.0" } }),
  "astro.config.mjs": `import { defineConfig } from "astro/config";
export default defineConfig({ output: "static" });
`,
  "src/components/Counter.tsx": `export function Counter() {
  return <button>count</button>;
}
`,
  "src/pages/index.astro": `---
import Counter from "../components/Counter.tsx";
---
<html><body><Counter client:load /><img src="/a.png" /></body></html>
`,
  "src/pages/blog/[slug].astro": `---
const { slug } = Astro.params;
---
<h1>{slug}</h1>
`,
  "src/pages/api/hello.ts": `export async function GET() {
  return new Response("hi");
}
`,
  "src/middleware.ts": `import { defineMiddleware } from "astro:middleware";
export const onRequest = defineMiddleware(async (context, next) => next());
`,
  "src/actions/index.ts": `import { defineAction } from "astro:actions";
import { z } from "astro:zod";
export const server = {
  like: defineAction({
    input: z.object({ id: z.string() }),
    handler: async ({ id }) => {
      return { id };
    },
  }),
};
`,
  "src/content.config.ts": `import { defineCollection } from "astro:content";
export const collections = { blog: defineCollection({ type: "content" }) };
`,
};

const MISSING = "local/no-such-astro-repo";

let tmpDir = "";
let projDir = "";
let repo = "";

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-astro-narrow-"));
  projDir = join(tmpDir, "astro-narrow-project");
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  for (const [rel, content] of Object.entries(FILES)) {
    const full = join(projDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  repo = (await indexFolder(projDir, { watch: false })).repo;
}, 60_000);

afterAll(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function handlerOf(name: string): (args: Record<string, unknown>) => Promise<unknown> {
  const entry = ASTRO_TOOL_ENTRIES.find((e) => e.definition.name === name);
  if (!entry) throw new Error(`no tool ${name}`);
  return entry.definition.handler as (args: Record<string, unknown>) => Promise<unknown>;
}

describe("Astro tools resolve `repo` through narrow reads", () => {
  // Runs FIRST, before anything loads the full index: the page-symbol lookups must be served by
  // the database. The oracle (getCodeIndex) is loaded only after the narrow answers are in hand.
  it("astro_route_map and astro_audit match the full-index path", async () => {
    const map = await astroRouteMap({ repo });
    const skip = ["patterns"];
    const audit = await astroAudit({ repo, skip });

    expect(map.routes.map((r) => r.path).sort()).toEqual(["/", "/api/hello", "/blog/:slug"]);
    expect(map.routes.find((r) => r.path === "/api/hello")!.methods).toEqual(["GET"]);
    expect(map.warnings.some((w) => w.includes("/blog/:slug") && w.includes("getStaticPaths"))).toBe(true);

    const full = await getCodeIndex(repo);
    expect(full).not.toBeNull();
    const oracle = buildRouteEntries(full!);
    expect(map.routes).toEqual(oracle.routes);
    expect(map.warnings).toEqual(oracle.warnings);
    expect(audit).toEqual(await astroAuditFromIndex(full!, new Set(skip)));
  });

  it("astro_analyze_islands and astro_hydration_audit read the .astro files", async () => {
    const islands = await astroAnalyzeIslands({ repo });
    expect(islands.islands.map((i) => [i.component_name, i.directive])).toEqual([["Counter", "client:load"]]);
    const full = (await getCodeIndex(repo))!;
    expect(islands).toEqual(analyzeIslandsFromIndex(full));
    expect(await astroHydrationAudit({ repo })).toEqual(hydrationAuditFromIndex(full));
  });

  it("astro_actions_audit finds the action", async () => {
    const result = await astroActionsAudit({ repo });
    expect(result.actions.map((a) => a.name)).toEqual(["like"]);
    expect(result).toEqual(await auditAstroActionsFromIndex((await getCodeIndex(repo))!));
  });

  it("the root-only tools answer for `repo` exactly as for its root", async () => {
    const middleware = await astroMiddlewareAudit({ repo });
    expect(middleware.middleware_file).toBe("src/middleware.ts");
    expect(middleware).toEqual(await astroMiddlewareAudit({ project_root: projDir }));
    expect(await astroSessionsAudit({ repo })).toEqual(await astroSessionsAudit({ project_root: projDir }));
    expect(await astroDbAudit({ repo })).toEqual(await astroDbAudit({ project_root: projDir }));
    expect(await astroEnvValidator({ repo })).toEqual(await astroEnvValidator({ project_root: projDir }));
    const images = await astroImageAudit({ repo });
    expect(images.raw_img_count).toBe(1);
    expect(images).toEqual(await astroImageAudit({ project_root: projDir }));
    expect(await astroSvgComponents({ repo })).toEqual(await astroSvgComponents({ project_root: projDir }));
    const content = await astroContentCollections({ repo });
    expect(content.collections.map((c) => c.name)).toEqual(["blog"]);
  });

  it("astro_config_analyze and astro_content_collections handlers resolve the root", async () => {
    const config = await handlerOf("astro_config_analyze")({ repo });
    expect(config).toEqual(await astroConfigAnalyze({ project_root: projDir }));
    const content = await handlerOf("astro_content_collections")({ repo }) as { collections: Array<{ name: string }> };
    expect(content.collections.map((c) => c.name)).toEqual(["blog"]);
  });

  it("keeps each tool's not-found behaviour", async () => {
    await expect(astroRouteMap({ repo: MISSING })).rejects.toThrow("Repository not found");
    await expect(handlerOf("astro_config_analyze")({ repo: MISSING })).rejects.toThrow(
      "Repository not found — run index_folder first",
    );
    await expect(handlerOf("astro_content_collections")({ repo: MISSING })).rejects.toThrow(
      "Repository not found — run index_folder first",
    );
    expect((await astroAnalyzeIslands({ repo: MISSING })).islands).toEqual([]);
    expect((await astroActionsAudit({ repo: MISSING })).actions).toEqual([]);
    expect((await astroAudit({ repo: MISSING })).score).toBe("D");
    expect((await astroMiddlewareAudit({ repo: MISSING })).middleware_file).toBeNull();
  });
});
