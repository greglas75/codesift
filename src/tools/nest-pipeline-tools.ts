/**
 * NestJS request pipeline visualization.
 */

import { getCodeIndex } from "./index-tools.js";
import { nestGuardChain } from "./nest-guard-tools.js";
import { nestRouteInventory } from "./nest-route-tools.js";
import type { NestToolError } from "./nest-shared-tools.js";

// ---------------------------------------------------------------------------
// Wave 3: nest_request_pipeline — full execution chain viz for a single route
// ---------------------------------------------------------------------------

export interface NestPipelineStep {
  layer: "middleware" | "global-guard" | "global-filter" | "global-pipe" | "global-interceptor"
       | "controller-guard" | "controller-interceptor" | "controller-pipe" | "controller-filter"
       | "method-guard" | "method-interceptor" | "method-pipe" | "method-filter"
       | "custom-metadata" | "handler";
  name: string;
  file?: string;
  note?: string;
}

export interface NestRequestPipelineResult {
  route: string;
  method: string;
  controller: string;
  handler: string;
  file: string;
  steps: NestPipelineStep[];
  mermaid?: string;
  errors?: NestToolError[];
}

/**
 * Wave 3 Feature 1: visualize the full NestJS request pipeline for a single route.
 * Walks middleware.configure() chain, global guards/filters/pipes/interceptors,
 * controller-level decorators, method-level decorators, and the handler itself.
 * Returns ordered steps + optional mermaid diagram.
 */
export async function nestRequestPipeline(
  repo: string,
  options: { route: string; method?: string; output_format?: "json" | "mermaid" },
): Promise<NestRequestPipelineResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const targetRoute = options.route;
  const targetMethod = (options.method ?? "GET").toUpperCase();

  // Reuse nestGuardChain for the chain + nestRouteInventory for handler name + file
  const [chainResult, inventoryResult] = await Promise.all([
    nestGuardChain(repo, { path: targetRoute }),
    nestRouteInventory(repo),
  ]);

  const matchingRoute = chainResult.routes.find(
    (r) => r.route === targetRoute && r.method === targetMethod,
  );
  const inventoryEntry = inventoryResult.routes.find(
    (r) => r.path === targetRoute && r.method === targetMethod,
  );

  if (!matchingRoute) {
    return {
      route: targetRoute,
      method: targetMethod,
      controller: "NotFound",
      handler: "NotFound",
      file: "",
      steps: [],
      ...(chainResult.errors ? { errors: chainResult.errors } : {}),
    };
  }

  const resolvedHandler = inventoryEntry?.handler ?? "anonymous";

  // Convert chain items to pipeline steps in canonical execution order:
  //   middleware → global guards → controller guards → method guards
  //   → global pipes → controller pipes → method pipes → inline pipes
  //   → global interceptors (pre) → controller interceptors (pre) → method interceptors (pre)
  //   → handler
  //   → method interceptors (post) → controller interceptors (post) → global interceptors (post)
  //   → global filters → controller filters → method filters
  const steps: NestPipelineStep[] = [];

  const byLayerAndType = (layer: string, type: string) =>
    matchingRoute.chain.filter((c) => c.layer === layer && c.type === type);

  // 1. Middleware layer (runs first in NestJS request pipeline)
  for (const c of byLayerAndType("middleware", "guard")) {
    steps.push({ layer: "middleware", name: c.name, ...(c.file ? { file: c.file } : {}), note: "module.configure()" });
  }

  // 2. Guards (global → controller → method)
  for (const c of byLayerAndType("global", "guard")) steps.push({ layer: "global-guard", name: c.name, ...(c.file ? { file: c.file } : {}) });
  for (const c of byLayerAndType("controller", "guard")) steps.push({ layer: "controller-guard", name: c.name });
  for (const c of byLayerAndType("method", "guard")) steps.push({ layer: "method-guard", name: c.name });

  // 3. Pipes (global → controller → method)
  for (const c of byLayerAndType("global", "pipe")) steps.push({ layer: "global-pipe", name: c.name, ...(c.file ? { file: c.file } : {}) });
  for (const c of byLayerAndType("controller", "pipe")) steps.push({ layer: "controller-pipe", name: c.name });
  for (const c of byLayerAndType("method", "pipe")) steps.push({ layer: "method-pipe", name: c.name });

  // 4. Interceptors (pre-handler; global → controller → method)
  for (const c of byLayerAndType("global", "interceptor")) steps.push({ layer: "global-interceptor", name: c.name, ...(c.file ? { file: c.file } : {}), note: "pre-handler" });
  for (const c of byLayerAndType("controller", "interceptor")) steps.push({ layer: "controller-interceptor", name: c.name, note: "pre-handler" });
  for (const c of byLayerAndType("method", "interceptor")) steps.push({ layer: "method-interceptor", name: c.name, note: "pre-handler" });

  // 5. Custom metadata decorators (@Roles, @Public, etc. — informational, don't execute)
  for (const c of byLayerAndType("method", "metadata")) {
    steps.push({
      layer: "custom-metadata",
      name: c.name,
      note: c.args ? `args: ${c.args}` : "metadata only",
    });
  }

  // 6. Handler (the method itself)
  steps.push({
    layer: "handler",
    name: resolvedHandler,
    file: matchingRoute.file,
    note: `${matchingRoute.method} ${matchingRoute.route}`,
  });

  // 7. Filters (for exception handling — run if handler throws)
  for (const c of byLayerAndType("global", "filter")) steps.push({ layer: "global-filter", name: c.name, ...(c.file ? { file: c.file } : {}), note: "exception handler" });
  for (const c of byLayerAndType("controller", "filter")) steps.push({ layer: "controller-filter", name: c.name, note: "exception handler" });
  for (const c of byLayerAndType("method", "filter")) steps.push({ layer: "method-filter", name: c.name, note: "exception handler" });

  const result: NestRequestPipelineResult = {
    route: matchingRoute.route,
    method: matchingRoute.method,
    controller: matchingRoute.controller,
    handler: resolvedHandler,
    file: matchingRoute.file,
    steps,
    ...(chainResult.errors ? { errors: chainResult.errors } : {}),
  };

  // Optional mermaid output
  if (options.output_format === "mermaid") {
    const lines = ["flowchart TD"];
    lines.push(`    Request["${matchingRoute.method} ${matchingRoute.route}"]`);
    let prev = "Request";
    let idx = 0;
    for (const step of steps) {
      idx++;
      const id = `S${idx}`;
      const label = step.note ? `${step.name}<br/>${step.note}` : step.name;
      const shape = step.layer === "handler" ? `(["${label}"])` : `["${label}"]`;
      lines.push(`    ${id}${shape}`);
      lines.push(`    ${prev} --> ${id}`);
      prev = id;
    }
    result.mermaid = lines.join("\n");
  }

  return result;
}
