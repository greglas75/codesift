import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAutoLoadTools } from "../../src/register-tools.js";

async function withTmpdir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-autoload-"));
  try { await fn(root); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

const EXPECTED_ASTRO_TOOLS = [
  "astro_route_map",
  "astro_config_analyze",
  "astro_content_collections",
  "astro_actions_audit",
  "astro_migration_check",
  "astro_analyze_islands",
  "astro_audit",
  "astro_middleware",
  "astro_sessions",
  "astro_db_audit",
  "astro_env_validator",
  "astro_image_audit",
  "astro_svg_components",
];

describe("Astro auto-load via astro.config.* (Task 13)", () => {
  for (const cfg of ["astro.config.mjs", "astro.config.ts", "astro.config.cjs", "astro.config.js"]) {
    it(`detects ${cfg} and enables 13 Astro tools`, async () => {
      await withTmpdir(async (root) => {
        await writeFile(join(root, cfg), "export default {};", "utf-8");
        const enabled = await detectAutoLoadTools(root);
        for (const t of EXPECTED_ASTRO_TOOLS) {
          expect(enabled, `expected ${t} to be enabled by ${cfg}`).toContain(t);
        }
      });
    });
  }

  it("empty CWD does NOT enable any Astro tools", async () => {
    await withTmpdir(async (root) => {
      await mkdir(join(root, "src"));
      const enabled = await detectAutoLoadTools(root);
      for (const t of EXPECTED_ASTRO_TOOLS) {
        expect(enabled).not.toContain(t);
      }
    });
  });
});
