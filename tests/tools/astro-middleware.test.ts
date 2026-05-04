import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroMiddlewareAudit } from "../../src/tools/astro-middleware.js";

beforeAll(async () => {
  await initParser();
});

async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-mw-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content, "utf-8");
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("astro_middleware", () => {
  it("happy path — onRequest = sequence(authGuard, logger)", async () => {
    const src = `
import { sequence } from "astro:middleware";
const authGuard = async (context, next) => {
  if (!context.locals.user) return new Response("forbidden", { status: 403 });
  return next();
};
const logger = async (_ctx, next) => next();
export const onRequest = sequence(authGuard, logger);
`;
    await withProject(
      { "src/middleware.ts": src },
      async (root) => {
        const result = await astroMiddlewareAudit({ project_root: root });
        expect(result.handlers).toContain("onRequest");
        expect(result.sequence).toEqual(["authGuard", "logger"]);
        expect(Array.isArray(result.issues)).toBe(true);
      },
    );
  });

  it("empty project — no middleware.ts → empty handlers, no issues", async () => {
    await withProject({ "package.json": "{}" }, async (root) => {
      const result = await astroMiddlewareAudit({ project_root: root });
      expect(result.handlers).toEqual([]);
      expect(result.sequence).toEqual([]);
      expect(result.issues).toEqual([]);
    });
  });

  it("malformed middleware → MW00 parse-fail or MW01 no-export, never throws", async () => {
    const broken = `export const onRequest = (((`;
    await withProject(
      { "src/middleware.ts": broken },
      async (root) => {
        const result = await astroMiddlewareAudit({ project_root: root });
        const codes = result.issues.map((i) => i.code);
        expect(codes.some((c) => c === "MW00" || c === "MW01")).toBe(true);
      },
    );
  });

  it("middleware without onRequest export → MW01", async () => {
    const src = `
const helper = () => 42;
export const notOnRequest = helper;
`;
    await withProject(
      { "src/middleware.ts": src },
      async (root) => {
        const result = await astroMiddlewareAudit({ project_root: root });
        expect(result.handlers).toEqual([]);
        expect(result.issues.some((i) => i.code === "MW01")).toBe(true);
      },
    );
  });

  it("guard without redirect/throw is flagged MW03", async () => {
    const src = `
export const onRequest = async (context, next) => {
  if (context.url.pathname === "/admin" && !context.locals.user) {
    // missing return / redirect — falls through to next()
  }
  return next();
};
`;
    await withProject(
      { "src/middleware.ts": src },
      async (root) => {
        const result = await astroMiddlewareAudit({ project_root: root });
        // MW03 surfaces as an issue (heuristic — exact line not asserted)
        expect(result.issues.some((i) => i.code === "MW03")).toBe(true);
      },
    );
  });

  it("middleware.js variant is also detected", async () => {
    const src = `export const onRequest = (ctx, next) => next();`;
    await withProject(
      { "src/middleware.js": src },
      async (root) => {
        const result = await astroMiddlewareAudit({ project_root: root });
        expect(result.handlers).toContain("onRequest");
      },
    );
  });
});
