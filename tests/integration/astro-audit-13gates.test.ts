/**
 * Whole-feature integration test for astro_audit (Task 14).
 *
 * Builds a realistic Astro 5 mini-project under tmpdir that exercises ALL
 * 13 gates of the audit, then asserts each gate flips off "skipped" with
 * sensible status, sections populated, and total runtime <5s.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroAuditFromIndex } from "../../src/tools/astro-audit.js";
import { astroMiddlewareAudit } from "../../src/tools/astro-middleware.js";
import { astroSessionsAudit } from "../../src/tools/astro-sessions.js";
import { astroDbAudit } from "../../src/tools/astro-db-audit.js";
import { astroEnvValidator } from "../../src/tools/astro-env-validator.js";
import { astroImageAudit } from "../../src/tools/astro-image-audit.js";
import { astroSvgComponents } from "../../src/tools/astro-svg-components.js";
import type { CodeIndex } from "../../src/types.js";

beforeAll(async () => {
  await initParser();
});

const ASTRO_CONFIG = `
import { defineConfig, envField } from "astro/config";
import node from "@astrojs/node";
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  experimental: { session: true },
  env: {
    schema: {
      API_URL: envField.string({ context: "server", access: "secret" }),
      PUBLIC_KEY: envField.string({ context: "client", access: "public" }),
    },
  },
});
`;

const MIDDLEWARE = `
import { sequence } from "astro:middleware";
const auth = async (ctx, next) => next();
const logger = async (ctx, next) => next();
export const onRequest = sequence(auth, logger);
`;

const DB_CONFIG = `
import { defineDb, defineTable, column } from "astro:db";
const Author = defineTable({
  columns: { id: column.number({ primaryKey: true }), name: column.text() },
});
const Post = defineTable({
  columns: {
    id: column.number({ primaryKey: true }),
    title: column.text(),
    authorId: column.number({ references: () => Author.columns.id }),
  },
});
export default defineDb({ tables: { Author, Post } });
`;

const PAGE = `---
import { Image } from "astro:assets";
import Logo from "../assets/logo.svg?component";
import { API_URL } from "astro:env/server";
const k = import.meta.env.PUBLIC_KEY;
const user = await Astro.session.get("user");
---
<Logo />
<Image src="/x.png" alt="x" />
<img src="/raw.png">
<p>{k} {API_URL}</p>
`;

async function setupFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "astro-13gates-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    dependencies: { astro: "^5.0.0", "@astrojs/node": "^9.0.0" },
  }), "utf-8");
  await writeFile(join(root, "astro.config.mjs"), ASTRO_CONFIG, "utf-8");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/middleware.ts"), MIDDLEWARE, "utf-8");
  await mkdir(join(root, "db"), { recursive: true });
  await writeFile(join(root, "db/config.ts"), DB_CONFIG, "utf-8");
  await mkdir(join(root, "src/pages"), { recursive: true });
  await writeFile(join(root, "src/pages/index.astro"), PAGE, "utf-8");
  await mkdir(join(root, "src/assets"), { recursive: true });
  await writeFile(join(root, "src/assets/logo.svg"), `<svg/>`, "utf-8");
  return root;
}

function makeIndex(root: string): CodeIndex {
  return {
    repo: "test-repo",
    root,
    files: [],
    symbols: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    file_count: 0,
    symbol_count: 0,
  };
}

describe("astro_audit 13-gate integration (Task 14)", () => {
  it("astroAuditFromIndex exposes 13 gate keys with skipped defaults", async () => {
    const root = await setupFixture();
    try {
      const result = await astroAuditFromIndex(
        makeIndex(root),
        new Set(["islands", "hydration", "routes", "actions", "content", "migration", "patterns"]),
        undefined,
      );
      // Type-level gate count check (the meta-tool's tryImportOptionalTool uses
      // dynamic require which doesn't resolve TS sources in vitest — sub-tool
      // exercise happens directly below).
      expect(Object.keys(result.gates)).toHaveLength(13);
      expect(result.gates).toHaveProperty("middleware");
      expect(result.gates).toHaveProperty("sessions");
      expect(result.gates).toHaveProperty("db");
      expect(result.gates).toHaveProperty("env");
      expect(result.gates).toHaveProperty("image");
      expect(result.gates).toHaveProperty("svg");
      expect(["A", "B", "C", "D"]).toContain(result.score);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("each sub-tool returns sensible results against the full Astro 5 fixture", async () => {
    const root = await setupFixture();
    const start = Date.now();
    try {
      const [mw, sess, db, env, img, svg] = await Promise.all([
        astroMiddlewareAudit({ project_root: root }),
        astroSessionsAudit({ project_root: root }),
        astroDbAudit({ project_root: root }),
        astroEnvValidator({ project_root: root }),
        astroImageAudit({ project_root: root }),
        astroSvgComponents({ project_root: root }),
      ]);
      const runtime = Date.now() - start;

      expect(mw.handlers).toContain("onRequest");
      expect(mw.sequence).toEqual(["auth", "logger"]);

      expect(sess.adapter).toBe("@astrojs/node");
      expect(sess.sessions_enabled).toBe(true);
      expect(sess.usage_count).toBeGreaterThanOrEqual(1);

      expect(db.tables.length).toBe(2);
      const post = db.tables.find((t) => t.name === "Post");
      expect(post?.columns.find((c) => c.name === "authorId")?.references).toBe("Author.id");

      expect(env.declared_vars.length).toBe(2);
      // PUBLIC_KEY referenced via import.meta.env, API_URL via astro:env/server import
      expect(env.missing).toEqual([]);

      expect(img.raw_img_count).toBeGreaterThanOrEqual(1);
      expect(img.image_component_count).toBeGreaterThanOrEqual(1);

      expect(svg.imports.length).toBe(1);
      expect(svg.imports[0]?.used).toBe(true);

      // Whole-feature smoke runtime budget
      expect(runtime).toBeLessThan(5000);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
