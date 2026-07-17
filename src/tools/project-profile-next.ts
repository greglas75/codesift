import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NextConventions } from "./project-profile-types.js";

export function extractNextConventions(
  _projectRoot: string,
  files: { path: string }[],
): NextConventions {
  const pages: NextConventions["pages"] = [];
  const api_routes: NextConventions["api_routes"] = [];
  const inngest_functions: string[] = [];
  const webhooks: string[] = [];
  let services_count = 0;
  let client_component_count = 0;
  let server_action_count = 0;
  let middleware: NextConventions["middleware"] = null;

  const hasAppDir = files.some((f) => f.path.includes("app/"));
  const hasSrcDir = files.some((f) => f.path.startsWith("src/"));
  const hasI18n = files.some((f) => f.path.includes("[locale]") || f.path.includes("i18n"));

  for (const file of files) {
    const p = file.path;

    // Middleware
    if (/^(src\/)?middleware\.(ts|js)$/.test(p)) {
      middleware = { file: p, matchers: [] };
    }

    // App Router pages (paths from index have no leading /)
    if (/app\/.*\/page\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "page" });
    }
    if (/app\/.*\/layout\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "layout" });
    }
    if (/app\/.*\/loading\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "loading" });
    }
    if (/app\/.*\/error\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "error" });
    }
    if (/app\/.*\/not-found\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "not-found" });
    }
    if (/app\/.*\/global-error\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "global-error" });
    }
    if (/app\/.*\/default\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "default" });
    }
    if (/app\/.*\/template\.(tsx|jsx|ts|js)$/.test(p)) {
      pages.push({ path: p, type: "template" });
    }

    // API routes (App Router — route.ts files under app/api/)
    if (/app\/api\/.*route\.(ts|js)$/.test(p)) {
      api_routes.push({ path: p, methods: [], file: p });
    }

    // Pages Router API routes
    if (/pages\/api\//.test(p)) {
      api_routes.push({ path: p, methods: [], file: p });
    }

    // Inngest functions
    if (/inngest\/.*\.(ts|js)$/.test(p) && !/\.test\./.test(p) && !/\.spec\./.test(p) && !/index\./.test(p)) {
      inngest_functions.push(p);
    }

    // Services
    if (/services?\/[^/]+\.(ts|js)$/.test(p) && !/\.test\./.test(p) && !/\.spec\./.test(p) && !/\.d\.ts$/.test(p) && !/index\./.test(p)) {
      services_count++;
    }

    // Webhooks
    if (/webhook/.test(p) && /route\.(ts|js)$/.test(p)) {
      webhooks.push(p);
    }

    // Directive scanning — check first line for "use client" / "use server"
    if (/\.(tsx|ts|jsx|js)$/.test(p) && /app\//.test(p)) {
      try {
        const head = readFileSync(join(_projectRoot, p), { encoding: "utf8", flag: "r" }).slice(0, 80);
        if (/['"]use client['"]/.test(head)) client_component_count++;
        if (/['"]use server['"]/.test(head)) server_action_count++;
      } catch {
        // file may have been deleted since indexing
      }
    }
  }

  return {
    pages,
    middleware,
    api_routes,
    services_count,
    client_component_count,
    server_action_count,
    inngest_functions,
    webhooks,
    config: { app_router: hasAppDir, src_dir: hasSrcDir, i18n: hasI18n },
  };
}
