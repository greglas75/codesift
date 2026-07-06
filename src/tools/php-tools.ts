/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Compatibility facade: public exports remain stable while implementations
 * live in per-tool modules.
 */
export { resolvePhpNamespace } from "./php-namespace-tools.js";
export type { PhpNamespaceResolution } from "./php-namespace-tools.js";

export { analyzeActiveRecord } from "./php-active-record-tools.js";
export type { ActiveRecordAnalysis, ActiveRecordModel } from "./php-active-record-tools.js";

export { tracePhpEvent } from "./php-event-tools.js";
export type { PhpEventChain } from "./php-event-tools.js";

export { findPhpViews } from "./php-view-tools.js";
export type {
  FindPhpViewsResult,
  PhpAssetBundleRef,
  PhpLayoutMapping,
  PhpRenderKind,
  PhpViewMapping,
  PhpWidgetReference,
} from "./php-view-tools.js";

export { resolvePhpService } from "./php-service-tools.js";
export type { PhpServiceResolution } from "./php-service-tools.js";

export { phpSecurityScan } from "./php-security-tools.js";
export type { PhpSecurityFinding, PhpSecurityScanResult } from "./php-security-tools.js";

export { findPhpNPlusOne } from "./php-nplus1-tools.js";
export type { NPlusOneFinding } from "./php-nplus1-tools.js";

export { findPhpGodModel } from "./php-god-model-tools.js";
export type { GodModelFinding } from "./php-god-model-tools.js";

export { phpProjectAudit } from "./php-project-audit-tools.js";
export type { AuditGate, PhpProjectAudit } from "./php-project-audit-tools.js";
