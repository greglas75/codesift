import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser } from "../../src/parser/parser-manager.js";
import { astroSessionsAudit } from "../../src/tools/astro-sessions.js";

beforeAll(async () => {
  await initParser();
});

async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "astro-sess-"));
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

describe("astro_sessions", () => {
  it("happy path — Sessions enabled with @astrojs/node adapter and matching usage", async () => {
    const config = `
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
export default defineConfig({
  adapter: node({ mode: "standalone" }),
  experimental: { session: true },
});
`;
    const page = `---
const user = await Astro.session.get("user");
Astro.session.set("user", { id: 1 });
---
<h1>Hi</h1>
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/index.astro": page },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.adapter).toBe("@astrojs/node");
        expect(result.sessions_enabled).toBe(true);
        expect(result.usage_count).toBeGreaterThanOrEqual(1);
        expect(result.adapter_compatibility["@astrojs/node"]).toBe(true);
        expect(result.issues).toEqual([]);
      },
    );
  });

  it("Sessions used without config → SE01", async () => {
    const config = `
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
export default defineConfig({ adapter: node({ mode: "standalone" }) });
`;
    const page = `---
const user = await Astro.session.get("user");
---
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/p.astro": page },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.sessions_enabled).toBe(false);
        expect(result.usage_count).toBeGreaterThanOrEqual(1);
        expect(result.issues.some((i) => i.code === "SE01")).toBe(true);
      },
    );
  });

  it("unsupported / unknown adapter is flagged SE02 when sessions used", async () => {
    const config = `
import { defineConfig } from "astro/config";
import weird from "@some/custom-adapter";
export default defineConfig({
  adapter: weird(),
  experimental: { session: true },
});
`;
    const page = `---
Astro.session.set("k", "v");
---`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/p.astro": page },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.issues.some((i) => i.code === "SE02")).toBe(true);
      },
    );
  });

  it("no session usage and no config → empty result, no issues", async () => {
    await withProject(
      { "astro.config.mjs": `export default { };`, "src/pages/x.astro": `---\n---\n<p/>` },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.usage_count).toBe(0);
        expect(result.sessions_enabled).toBe(false);
        expect(result.issues).toEqual([]);
      },
    );
  });

  it("missing astro.config → empty result, no throw", async () => {
    await withProject(
      { "package.json": "{}" },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.config_found).toBe(false);
        expect(result.usage_count).toBe(0);
        expect(result.issues).toEqual([]);
      },
    );
  });

  it("nested experimental (e.g. env: { schema:{} }, session: true) is correctly detected", async () => {
    const config = `
import node from "@astrojs/node";
export default {
  adapter: node({ mode: "standalone" }),
  experimental: {
    env: { schema: { API_URL: "string" } },
    session: true,
  },
};
`;
    const page = `---
Astro.session.set("k", "v");
---`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/p.astro": page },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.sessions_enabled).toBe(true);
        expect(result.issues.some((i) => i.code === "SE01")).toBe(false);
      },
    );
  });

  it("does NOT match unrelated session libraries (req.session, db.session)", async () => {
    const config = `
import node from "@astrojs/node";
export default { adapter: node({ mode: "standalone" }) };
`;
    const middleware = `
export const onRequest = (context, next) => {
  // express-style req.session — must NOT count
  const req = context.request;
  req.session.get("x");
  db.session.set("y", 1);
  return next();
};
`;
    await withProject(
      { "astro.config.mjs": config, "src/middleware.ts": middleware },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.usage_count).toBe(0);
        expect(result.issues.some((i) => i.code === "SE01")).toBe(false);
      },
    );
  });

  it("session as object config (Astro 5: session: { cookie: ... }) counts as enabled", async () => {
    const config = `
import node from "@astrojs/node";
export default {
  adapter: node({ mode: "standalone" }),
  experimental: { session: { cookie: { sameSite: "strict" } } },
};
`;
    const page = `---
Astro.session.set("k", "v");
---`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/p.astro": page },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.sessions_enabled).toBe(true);
      },
    );
  });

  it("sessions used without an SSR adapter → SE04", async () => {
    const config = `
export default {
  // no adapter — static mode
  experimental: { session: true },
};
`;
    const page = `---
Astro.session.set("k", "v");
---`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/p.astro": page },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.adapter).toBeNull();
        expect(result.issues.some((i) => i.code === "SE04")).toBe(true);
      },
    );
  });

  it("astro.config.ts (TypeScript syntax) parses correctly", async () => {
    const config = `
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import type { AstroUserConfig } from "astro";
export default defineConfig({
  adapter: node({ mode: "standalone" }),
  experimental: { session: true },
} satisfies AstroUserConfig);
`;
    const page = `---
Astro.session.set("k", "v");
---`;
    await withProject(
      { "astro.config.ts": config, "src/pages/p.astro": page },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.sessions_enabled).toBe(true);
        expect(result.adapter).toBe("@astrojs/node");
      },
    );
  });

  it("context.session.* (server endpoint) is also detected", async () => {
    const config = `
import node from "@astrojs/node";
export default { adapter: node({ mode: "standalone" }), experimental: { session: true } };
`;
    const endpoint = `
export const GET = ({ session }) => {
  session.set("foo", "bar");
  return new Response("ok");
};
export const POST = (context) => {
  context.session.get("foo");
  return new Response("ok");
};
`;
    await withProject(
      { "astro.config.mjs": config, "src/pages/api/u.ts": endpoint },
      async (root) => {
        const result = await astroSessionsAudit({ project_root: root });
        expect(result.usage_count).toBeGreaterThanOrEqual(1);
      },
    );
  });
});
