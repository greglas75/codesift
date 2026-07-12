import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractExpressConventions,
  extractNextConventions,
  extractPythonConventions,
} from "../../src/tools/project-tools.js";

describe("project profile convention extractors", () => {
  it("extracts Next.js routing, directives, services, and integrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-next-conventions-"));
    try {
      await mkdir(join(root, "app/dashboard"), { recursive: true });
      await mkdir(join(root, "app/[locale]"), { recursive: true });
      await mkdir(join(root, "app/api/users"), { recursive: true });
      await mkdir(join(root, "app/api/webhook"), { recursive: true });
      await mkdir(join(root, "src/inngest"), { recursive: true });
      await mkdir(join(root, "src/services"), { recursive: true });
      await writeFile(join(root, "app/dashboard/page.tsx"), '"use client";\nexport default function Page() {}');
      await writeFile(join(root, "app/[locale]/layout.tsx"), "export default function Layout() {}");
      await writeFile(join(root, "app/api/users/route.ts"), '"use server";\nexport async function GET() {}');
      await writeFile(join(root, "app/api/webhook/route.ts"), "export async function POST() {}");
      await writeFile(join(root, "src/inngest/sync.ts"), "export const sync = {};");
      await writeFile(join(root, "src/services/users.ts"), "export const users = {};");
      await writeFile(join(root, "src/middleware.ts"), "export function middleware() {}");

      const conventions = extractNextConventions(root, [
        { path: "app/dashboard/page.tsx" },
        { path: "app/[locale]/layout.tsx" },
        { path: "app/api/users/route.ts" },
        { path: "app/api/webhook/route.ts" },
        { path: "src/inngest/sync.ts" },
        { path: "src/services/users.ts" },
        { path: "src/middleware.ts" },
      ]);

      expect(conventions.pages).toEqual([
        { path: "app/dashboard/page.tsx", type: "page" },
        { path: "app/[locale]/layout.tsx", type: "layout" },
      ]);
      expect(conventions.api_routes).toEqual([
        { path: "app/api/users/route.ts", methods: [], file: "app/api/users/route.ts" },
        { path: "app/api/webhook/route.ts", methods: [], file: "app/api/webhook/route.ts" },
      ]);
      expect(conventions.middleware).toEqual({ file: "src/middleware.ts", matchers: [] });
      expect(conventions.services_count).toBe(1);
      expect(conventions.inngest_functions).toEqual(["src/inngest/sync.ts"]);
      expect(conventions.webhooks).toEqual(["app/api/webhook/route.ts"]);
      expect(conventions.client_component_count).toBe(1);
      expect(conventions.server_action_count).toBe(1);
      expect(conventions.config).toEqual({ app_router: true, src_dir: true, i18n: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts Express middleware, router mounts, and error handlers", () => {
    const source = [
      'import router from "./routes.js";',
      'const auth = require("./auth.js");',
      "app.use(auth);",
      'app.use("/api", router);',
      "app.use((err, req, res, next) => next(err));",
    ].join("\n");

    expect(extractExpressConventions(source, "src/app.ts")).toEqual({
      middleware: [{ name: "auth", file: "src/app.ts", line: 3 }],
      routers: [{ mount_path: "/api", file: "src/app.ts", line: 4, imported_from: "./routes.js" }],
      error_handlers: [{ file: "src/app.ts", line: 5 }],
    });
  });

  it("extracts Python routers, middleware, models, and test framework", () => {
    expect(extractPythonConventions([
      { path: "app/routes.py" },
      { path: "app/views.py" },
      { path: "app/middleware/auth.py" },
      { path: "app/models.py" },
      { path: "tests/test_api.py" },
    ])).toEqual({
      framework_type: "fastapi",
      routers: [
        { path: "app/routes.py", file: "app/routes.py" },
        { path: "app/views.py", file: "app/views.py" },
      ],
      middleware: ["app/middleware/auth.py"],
      models_dir: "app",
      test_framework: "pytest",
    });
  });
});
