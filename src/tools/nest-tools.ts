/**
 * Compatibility facade: public NestJS analysis exports remain stable while
 * implementations live in per-capability modules.
 */

export { detectCycles } from "./nest-shared-tools.js";
export type { NestToolError } from "./nest-shared-tools.js";

export { nestLifecycleMap } from "./nest-lifecycle-tools.js";
export type { NestLifecycleEntry, NestLifecycleMapResult } from "./nest-lifecycle-tools.js";

export { nestModuleGraph } from "./nest-module-tools.js";
export type { NestModuleGraphResult, NestModuleNode } from "./nest-module-tools.js";

export { nestDIGraph } from "./nest-di-tools.js";
export type { NestDIEdge, NestDIGraphResult, NestDINode } from "./nest-di-tools.js";

export { nestGuardChain } from "./nest-guard-tools.js";
export type { NestGuardChainEntry, NestGuardChainResult } from "./nest-guard-tools.js";

export { nestRouteInventory } from "./nest-route-tools.js";
export type { NestRouteEntry, NestRouteInventoryResult } from "./nest-route-tools.js";

export { nestRequestPipeline } from "./nest-pipeline-tools.js";
export type { NestPipelineStep, NestRequestPipelineResult } from "./nest-pipeline-tools.js";

export { nestAudit } from "./nest-audit-tools.js";
export type { NestAuditResult } from "./nest-audit-tools.js";
