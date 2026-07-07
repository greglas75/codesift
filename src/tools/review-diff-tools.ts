/**
 * Public facade for the review_diff MCP tool.
 *
 * The implementation lives under ./review-diff/ so each check adapter can
 * evolve independently without making this high-churn entry point a conflict
 * magnet.
 */

export type {
  CheckResult,
  DiffStats,
  ReviewDiffOptions,
  ReviewDiffResult,
  ReviewFinding,
  ReviewMetadata,
} from "./review-diff/types.js";

export {
  calculateScore,
  determineVerdict,
  findingTier,
} from "./review-diff/scoring.js";

export { checkBlastRadius } from "./review-diff/checks/blast-radius.js";
export { checkSecrets } from "./review-diff/checks/secrets.js";
export { checkDeadCode } from "./review-diff/checks/dead-code.js";
export { checkAstroHydration } from "./review-diff/checks/astro-hydration.js";
export { checkBugPatterns } from "./review-diff/checks/bug-patterns.js";
export { checkHotspots } from "./review-diff/checks/hotspots.js";
export { checkComplexityDelta } from "./review-diff/checks/complexity.js";
export { checkCouplingGaps } from "./review-diff/checks/coupling.js";
export { checkBreakingChanges } from "./review-diff/checks/breaking.js";
export { checkTestGaps } from "./review-diff/checks/test-gaps.js";
export { reviewDiff } from "./review-diff/orchestrator.js";
