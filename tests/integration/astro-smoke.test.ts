/**
 * SMOKE — Full Astro 5 pipeline: schema invariants across all 6 new tools
 * + auto-load detection + tool registration. Runs end-to-end against a
 * shared realistic fixture. This is Phase Final per zuvo:execute SMOKE1.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { detectAutoLoadTools } from "../../src/register-tools.js";
import { astroMiddlewareAudit } from "../../src/tools/astro-middleware.js";
import { astroSessionsAudit } from "../../src/tools/astro-sessions.js";
import { astroDbAudit } from "../../src/tools/astro-db-audit.js";
import { astroEnvValidator } from "../../src/tools/astro-env-validator.js";
import { astroImageAudit } from "../../src/tools/astro-image-audit.js";
import { astroSvgComponents } from "../../src/tools/astro-svg-components.js";

beforeAll(async () => {
  await initParser();
});

async function setupFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "astro-smoke-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "astro-smoke",
    dependencies: { astro: "^5.0.0", "@astrojs/node": "^9.0.0" },
  }), "utf-8");
  await writeFile(join(root, "astro.config.mjs"), `
import { defineConfig, envField } from "astro/config";
import node from "@astrojs/node";
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  experimental: { session: true },
  env: { schema: { API_URL: envField.string({ context: "server", access: "secret" }) } },
});
`, "utf-8");
  await mkdir(join(root, "src/pages/api"), { recursive: true });
  await mkdir(join(root, "db"), { recursive: true });
  await mkdir(join(root, "src/assets"), { recursive: true });
  await writeFile(join(root, "src/middleware.ts"), `
import { sequence } from "astro:middleware";
const auth = async (ctx, next) => next();
export const onRequest = sequence(auth);
`, "utf-8");
  await writeFile(join(root, "db/config.ts"), `
import { defineDb, defineTable, column } from "astro:db";
const T = defineTable({ columns: { id: column.number({ primaryKey: true }) } });
export default defineDb({ tables: { T } });
`, "utf-8");
  await writeFile(join(root, "src/pages/index.astro"), `---
import Logo from "../assets/logo.svg?component";
import { API_URL } from "astro:env/server";
const v = await Astro.session.get("v");
---
<Logo />
<img src="/x.png">
<p>{API_URL}</p>
`, "utf-8");
  await writeFile(join(root, "src/assets/logo.svg"), `<svg/>`, "utf-8");
  return root;
}

describe("SMOKE — Full Astro 5 pipeline", () => {
  it("end-to-end: detection + 6 sub-tools all produce schema-valid results", async () => {
    const root = await setupFixture();
    try {
      // 1. Auto-load detection fires for astro.config.mjs
      const enabled = await detectAutoLoadTools(root);
      expect(enabled).toContain("astro_audit");
      expect(enabled).toContain("astro_middleware");
      expect(enabled).toContain("astro_sessions");
      expect(enabled).toContain("astro_db_audit");
      expect(enabled).toContain("astro_env_validator");
      expect(enabled).toContain("astro_image_audit");
      expect(enabled).toContain("astro_svg_components");

      // 2. Each sub-tool returns a schema-valid result.
      const results = await Promise.all([
        astroMiddlewareAudit({ project_root: root }),
        astroSessionsAudit({ project_root: root }),
        astroDbAudit({ project_root: root }),
        astroEnvValidator({ project_root: root }),
        astroImageAudit({ project_root: root }),
        astroSvgComponents({ project_root: root }),
      ]);

      // Every result has an `issues` array, no thrown exceptions
      for (const r of results) {
        expect(r).toBeDefined();
        const obj = r as { issues?: unknown[] };
        expect(Array.isArray(obj.issues)).toBe(true);
      }

      // 3. Issue schema invariants — every issue has code/severity/file
      for (const r of results) {
        const issues = (r as { issues: { code: string; severity: string; file: string }[] }).issues;
        for (const issue of issues) {
          expect(typeof issue.code).toBe("string");
          expect(["error", "warning", "info"]).toContain(issue.severity);
          expect(typeof issue.file).toBe("string");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
