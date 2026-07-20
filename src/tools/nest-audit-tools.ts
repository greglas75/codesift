/**
 * NestJS audit meta-orchestrator.
 */

import { getCodeIndex } from "./index-tools.js";
import { nestDIGraph, type NestDIGraphResult } from "./nest-di-tools.js";
import { nestGuardChain, type NestGuardChainResult } from "./nest-guard-tools.js";
import { nestLifecycleMap, type NestLifecycleMapResult } from "./nest-lifecycle-tools.js";
import { nestModuleGraph, type NestModuleGraphResult } from "./nest-module-tools.js";
import { nestRouteInventory, type NestRouteInventoryResult } from "./nest-route-tools.js";
import type { NestToolError } from "./nest-shared-tools.js";

// ---------------------------------------------------------------------------
// C: nest_audit — types (implementation in Task 10)
// ---------------------------------------------------------------------------

export interface NestAuditResult {
  framework_detected: boolean;
  lifecycle_map?: NestLifecycleMapResult;
  module_graph?: NestModuleGraphResult;
  di_graph?: NestDIGraphResult;
  guard_chain?: NestGuardChainResult;
  route_inventory?: NestRouteInventoryResult;
  // Wave 2 sub-results
  graphql_map?: import("./nest-ext-tools.js").NestGraphQLMapResult;
  websocket_map?: import("./nest-ext-tools.js").NestWebSocketMapResult;
  schedule_map?: import("./nest-ext-tools.js").NestScheduleMapResult;
  typeorm_map?: import("./nest-ext-tools.js").NestTypeOrmMapResult;
  microservice_map?: import("./nest-ext-tools.js").NestMicroserviceMapResult;
  anti_patterns?: Array<{ pattern: string; count: number }>;
  summary: {
    total_routes: number;
    cycles: number;
    violations: number;
    anti_pattern_hits: number;
    failed_checks: number;
    truncated_checks: string[];
  };
  warnings?: NestToolError[];
  errors?: Array<{ check: string; reason: string }>;
}

const ALL_NEST_CHECKS = [
  "modules", "routes", "di", "guards", "lifecycle", "patterns",
  "graphql", "websocket", "schedule", "typeorm", "microservice",
] as const;
type NestCheck = (typeof ALL_NEST_CHECKS)[number];

export async function nestAudit(
  repo: string,
  options?: { checks?: string[] },
): Promise<NestAuditResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  // Check if this is a NestJS repo
  const { detectFrameworks } = await import("../utils/framework-detect.js");
  const frameworks = detectFrameworks(index);
  if (!frameworks.has("nestjs")) {
    return {
      framework_detected: false,
      summary: { total_routes: 0, cycles: 0, violations: 0, anti_pattern_hits: 0, failed_checks: 0, truncated_checks: [] },
    };
  }

  const enabledChecks = new Set<NestCheck>(
    (options?.checks ?? [...ALL_NEST_CHECKS]) as NestCheck[],
  );

  // Run all enabled checks in parallel via Promise.allSettled
  type CheckResult = {
    name: NestCheck;
    result?: unknown;
    error?: string;
  };

  const tasks: Array<Promise<CheckResult>> = [];

  if (enabledChecks.has("lifecycle")) {
    tasks.push(
      nestLifecycleMap(repo).then((r) => ({ name: "lifecycle" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "lifecycle" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("modules")) {
    tasks.push(
      nestModuleGraph(repo).then((r) => ({ name: "modules" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "modules" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("di")) {
    tasks.push(
      nestDIGraph(repo).then((r) => ({ name: "di" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "di" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("guards")) {
    tasks.push(
      nestGuardChain(repo).then((r) => ({ name: "guards" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "guards" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("routes")) {
    tasks.push(
      nestRouteInventory(repo).then((r) => ({ name: "routes" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "routes" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("patterns")) {
    tasks.push(
      (async () => {
        const { searchPatterns, listPatterns } = await import("./pattern-tools.js");
        const nestPatterns = listPatterns().filter((p) => p.name.startsWith("nest-"));
        const results: Array<{ pattern: string; count: number }> = [];
        for (const p of nestPatterns) {
          const r = await searchPatterns(repo, p.name);
          if (r.matches.length > 0) results.push({ pattern: p.name, count: r.matches.length });
        }
        return { name: "patterns" as NestCheck, result: results };
      })().catch((e: unknown) => ({ name: "patterns" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }

  // Wave 2 checks — lazy import to avoid eager loading if nest-ext-tools isn't needed
  if (enabledChecks.has("graphql")) {
    tasks.push(
      (async () => {
        const { nestGraphQLMap } = await import("./nest-ext-tools.js");
        return { name: "graphql" as NestCheck, result: await nestGraphQLMap(repo) };
      })().catch((e: unknown) => ({ name: "graphql" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("websocket")) {
    tasks.push(
      (async () => {
        const { nestWebSocketMap } = await import("./nest-ext-tools.js");
        return { name: "websocket" as NestCheck, result: await nestWebSocketMap(repo) };
      })().catch((e: unknown) => ({ name: "websocket" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("schedule")) {
    tasks.push(
      (async () => {
        const { nestScheduleMap } = await import("./nest-ext-tools.js");
        return { name: "schedule" as NestCheck, result: await nestScheduleMap(repo) };
      })().catch((e: unknown) => ({ name: "schedule" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("typeorm")) {
    tasks.push(
      (async () => {
        const { nestTypeOrmMap } = await import("./nest-ext-tools.js");
        return { name: "typeorm" as NestCheck, result: await nestTypeOrmMap(repo) };
      })().catch((e: unknown) => ({ name: "typeorm" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("microservice")) {
    tasks.push(
      (async () => {
        const { nestMicroserviceMap } = await import("./nest-ext-tools.js");
        return { name: "microservice" as NestCheck, result: await nestMicroserviceMap(repo) };
      })().catch((e: unknown) => ({ name: "microservice" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }

  // Per-check wall clock. Previously this was a bare Promise.all, so ONE slow
  // sub-check held the entire audit open — telemetry (2026-07-20) measured a
  // 1,046,984 ms (~17.5 min) p95 for nest_audit, the worst tail in the fleet.
  // A timed-out check resolves to a placeholder; the audit returns with the
  // checks that did finish and names the ones that didn't.
  const NEST_CHECK_TIMEOUT_MS = Number(process.env["CODESIFT_NEST_CHECK_TIMEOUT_MS"] ?? 15_000);
  const TIMED_OUT = "__timed_out__" as NestCheck;
  const settled = await Promise.all(
    tasks.map((p) =>
      Promise.race<CheckResult>([
        p,
        new Promise<CheckResult>((ok) =>
          setTimeout(() => ok({ name: TIMED_OUT }), NEST_CHECK_TIMEOUT_MS).unref?.(),
        ),
      ]),
    ),
  );

  // Aggregate
  const auditErrors: Array<{ check: string; reason: string }> = [];
  const warnings: NestToolError[] = [];
  const truncatedChecks: string[] = [];

  // Attribute timeouts: any enabled check with no settled result is the one that
  // blew the budget (the placeholder carries no name of its own).
  const completedChecks = new Set(settled.map((s) => s.name));
  for (const check of enabledChecks) {
    if (!completedChecks.has(check)) {
      auditErrors.push({ check, reason: `check timed out after ${NEST_CHECK_TIMEOUT_MS}ms` });
    }
  }

  let lifecycleResult: NestLifecycleMapResult | undefined;
  let moduleResult: NestModuleGraphResult | undefined;
  let diResult: NestDIGraphResult | undefined;
  let guardResult: NestGuardChainResult | undefined;
  let routeResult: NestRouteInventoryResult | undefined;
  let patternResults: Array<{ pattern: string; count: number }> | undefined;
  let graphqlResult: import("./nest-ext-tools.js").NestGraphQLMapResult | undefined;
  let websocketResult: import("./nest-ext-tools.js").NestWebSocketMapResult | undefined;
  let scheduleResult: import("./nest-ext-tools.js").NestScheduleMapResult | undefined;
  let typeormResult: import("./nest-ext-tools.js").NestTypeOrmMapResult | undefined;
  let microserviceResult: import("./nest-ext-tools.js").NestMicroserviceMapResult | undefined;

  for (const item of settled) {
    if (item.name === TIMED_OUT) continue; // already recorded above
    if (item.error) {
      auditErrors.push({ check: item.name, reason: item.error });
      continue;
    }
    switch (item.name) {
      case "lifecycle": lifecycleResult = item.result as NestLifecycleMapResult; break;
      case "modules": {
        const r = item.result as NestModuleGraphResult;
        moduleResult = r;
        if (r.truncated) truncatedChecks.push("modules");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "di": {
        const r = item.result as NestDIGraphResult;
        diResult = r;
        if (r.truncated) truncatedChecks.push("di");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "guards": {
        const r = item.result as NestGuardChainResult;
        guardResult = r;
        if (r.truncated) truncatedChecks.push("guards");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "routes": {
        const r = item.result as NestRouteInventoryResult;
        routeResult = r;
        if (r.truncated) truncatedChecks.push("routes");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "patterns": patternResults = item.result as Array<{ pattern: string; count: number }>; break;
      case "graphql": {
        const r = item.result as import("./nest-ext-tools.js").NestGraphQLMapResult;
        graphqlResult = r;
        if (r.truncated) truncatedChecks.push("graphql");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "websocket": {
        const r = item.result as import("./nest-ext-tools.js").NestWebSocketMapResult;
        websocketResult = r;
        if (r.truncated) truncatedChecks.push("websocket");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "schedule": {
        const r = item.result as import("./nest-ext-tools.js").NestScheduleMapResult;
        scheduleResult = r;
        if (r.truncated) truncatedChecks.push("schedule");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "typeorm": {
        const r = item.result as import("./nest-ext-tools.js").NestTypeOrmMapResult;
        typeormResult = r;
        if (r.truncated) truncatedChecks.push("typeorm");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "microservice": {
        const r = item.result as import("./nest-ext-tools.js").NestMicroserviceMapResult;
        microserviceResult = r;
        if (r.truncated) truncatedChecks.push("microservice");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
    }
  }

  const totalRoutes = routeResult?.stats.total_routes ?? 0;
  const cycles = (moduleResult?.circular_deps.length ?? 0) + (diResult?.cycles.length ?? 0) + (typeormResult?.cycles.length ?? 0);
  const antiPatternHits = patternResults?.reduce((sum, p) => sum + p.count, 0) ?? 0;

  return {
    framework_detected: true,
    ...(lifecycleResult ? { lifecycle_map: lifecycleResult } : {}),
    ...(moduleResult ? { module_graph: moduleResult } : {}),
    ...(diResult ? { di_graph: diResult } : {}),
    ...(guardResult ? { guard_chain: guardResult } : {}),
    ...(routeResult ? { route_inventory: routeResult } : {}),
    ...(graphqlResult ? { graphql_map: graphqlResult } : {}),
    ...(websocketResult ? { websocket_map: websocketResult } : {}),
    ...(scheduleResult ? { schedule_map: scheduleResult } : {}),
    ...(typeormResult ? { typeorm_map: typeormResult } : {}),
    ...(microserviceResult ? { microservice_map: microserviceResult } : {}),
    ...(patternResults ? { anti_patterns: patternResults } : {}),
    summary: {
      total_routes: totalRoutes,
      cycles,
      violations: (moduleResult?.circular_deps.length ?? 0) + (diResult?.cross_module_warnings.length ?? 0),
      anti_pattern_hits: antiPatternHits,
      failed_checks: auditErrors.length,
      truncated_checks: truncatedChecks,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(auditErrors.length > 0 ? { errors: auditErrors } : {}),
  };
}
