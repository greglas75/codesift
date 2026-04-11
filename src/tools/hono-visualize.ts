/**
 * visualize_hono_routes — produce Mermaid or ASCII tree of Hono routing topology.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md (Task 22)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { resolveHonoEntryFile } from "./hono-entry-resolver.js";
import { detectFrameworks } from "../utils/framework-detect.js";

export type VisualizeFormat = "mermaid" | "tree";

export interface VisualizeResult {
  format?: VisualizeFormat;
  output?: string;
  error?: string;
}

export async function visualizeHonoRoutes(
  repo: string,
  format: VisualizeFormat = "tree",
): Promise<VisualizeResult> {
  const index = await getCodeIndex(repo);
  if (!index) return { error: `Repository "${repo}" not found` };

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) return { error: "No Hono app detected" };

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) return { error: "No Hono entry file found" };

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse: ${msg}` };
  }

  if (format === "mermaid") {
    const lines: string[] = ["graph LR"];
    lines.push('  app["Hono app"]');
    for (const mount of model.mounts) {
      const id = mount.mount_path.replace(/[^a-zA-Z0-9]/g, "_");
      lines.push(`  app --> ${id}["${mount.mount_path}"]`);
    }
    for (const route of model.routes) {
      const id = `${route.method}_${route.path.replace(/[^a-zA-Z0-9]/g, "_")}`;
      lines.push(`  app -.-> ${id}["${route.method} ${route.path}"]`);
    }
    return { format, output: lines.join("\n") };
  }

  // Tree format (ASCII)
  const lines: string[] = ["Hono Application"];
  lines.push(`├── runtime: ${model.runtime}`);
  lines.push(`├── routes (${model.routes.length})`);
  for (let i = 0; i < model.routes.length; i++) {
    const route = model.routes[i]!;
    const isLast = i === model.routes.length - 1 && model.mounts.length === 0;
    const prefix = isLast ? "└──" : "├──";
    lines.push(`│   ${prefix} ${route.method} ${route.path}`);
  }
  if (model.mounts.length > 0) {
    lines.push(`├── mounts (${model.mounts.length})`);
    for (let i = 0; i < model.mounts.length; i++) {
      const mount = model.mounts[i]!;
      const isLast = i === model.mounts.length - 1;
      const prefix = isLast ? "└──" : "├──";
      lines.push(`│   ${prefix} ${mount.mount_path} → ${mount.child_var}`);
    }
  }
  lines.push(`└── middleware chains (${model.middleware_chains.length})`);

  return { format, output: lines.join("\n") };
}