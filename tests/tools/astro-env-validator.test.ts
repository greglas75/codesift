import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroEnvValidator } from "../../src/tools/astro-env-validator.js";

beforeAll(async () => {
  await initParser();
});

async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-env-"));
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

describe("astro_env_validator", () => {
  it("happy path — all declared vars used, no errors", async () => {
    const config = `
import { defineConfig, envField } from "astro/config";
export default defineConfig({
  env: {
    schema: {
      API_URL: envField.string({ context: "server", access: "secret" }),
      PUBLIC_KEY: envField.string({ context: "client", access: "public" }),
    },
  },
});
`;
    const page = `---
import { API_URL } from "astro:env/server";
const url = API_URL;
const k = import.meta.env.PUBLIC_KEY;
---
<p>{k}</p>
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/index.astro": page },
      async (root) => {
        const result = await astroEnvValidator({ project_root: root });
        expect(result.declared_vars.length).toBe(2);
        expect(result.declared_vars.find((v) => v.name === "API_URL")?.context).toBe("server");
        expect(result.missing).toEqual([]);
        expect(result.unused).toEqual([]);
        expect(result.issues.length).toBe(0);
      },
    );
  });

  it("EV01 — variable used but not declared in schema", async () => {
    const config = `
import { defineConfig, envField } from "astro/config";
export default defineConfig({
  env: {
    schema: {
      DECLARED: envField.string({ context: "client", access: "public" }),
    },
  },
});
`;
    const page = `---
const x = import.meta.env.MISSING_VAR;
const y = import.meta.env.DECLARED;
---
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/x.astro": page },
      async (root) => {
        const result = await astroEnvValidator({ project_root: root });
        expect(result.missing).toContain("MISSING_VAR");
        expect(result.issues.some((i) => i.code === "EV01" && i.var === "MISSING_VAR")).toBe(true);
      },
    );
  });

  it("EV02 — client-only var used in server-only file", async () => {
    const config = `
import { defineConfig, envField } from "astro/config";
export default defineConfig({
  env: {
    schema: {
      CLIENT_KEY: envField.string({ context: "client", access: "public" }),
    },
  },
});
`;
    const endpoint = `
import { CLIENT_KEY } from "astro:env/server";
export const GET = () => new Response(CLIENT_KEY);
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/api/x.ts": endpoint },
      async (root) => {
        const result = await astroEnvValidator({ project_root: root });
        expect(result.issues.some((i) => i.code === "EV02")).toBe(true);
      },
    );
  });

  it("EV03 — declared but unused", async () => {
    const config = `
import { defineConfig, envField } from "astro/config";
export default defineConfig({
  env: {
    schema: {
      UNUSED: envField.string({ context: "server", access: "secret" }),
    },
  },
});
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/x.astro": `---\nconst x = 1;\n---\n` },
      async (root) => {
        const result = await astroEnvValidator({ project_root: root });
        expect(result.unused).toContain("UNUSED");
        expect(result.issues.some((i) => i.code === "EV03" && i.var === "UNUSED")).toBe(true);
      },
    );
  });

  it("no env schema in config → empty declared_vars, no issues", async () => {
    await withProject(
      { "astro.config.mjs": `export default {};` },
      async (root) => {
        const result = await astroEnvValidator({ project_root: root });
        expect(result.declared_vars).toEqual([]);
        expect(result.issues).toEqual([]);
      },
    );
  });

  it("aliased imports `{ X as Y }` resolve to the schema name", async () => {
    const config = `
import { defineConfig, envField } from "astro/config";
export default defineConfig({
  env: {
    schema: {
      API_TOKEN: envField.string({ context: "server", access: "secret" }),
    },
  },
});
`;
    const endpoint = `
import { API_TOKEN as Token } from "astro:env/server";
export const GET = () => new Response(Token);
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/api/x.ts": endpoint },
      async (root) => {
        const result = await astroEnvValidator({ project_root: root });
        expect(result.unused).not.toContain("API_TOKEN");
        expect(result.missing).not.toContain("API_TOKEN");
      },
    );
  });

  it("missing astro.config → empty result, no throw", async () => {
    await withProject({ "package.json": "{}" }, async (root) => {
      const result = await astroEnvValidator({ project_root: root });
      expect(result.config_found).toBe(false);
      expect(result.declared_vars).toEqual([]);
    });
  });
});
