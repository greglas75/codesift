/**
 * Astro Actions audit facade.
 *
 * The implementation is split by responsibility under `astro-actions/` while
 * this module preserves the lazy-loader path and every public export.
 */

import { getCodeIndex } from "./index-tools.js";
import { ALL_ACTION_CODES, auditAstroActionsFromIndex } from "./astro-actions/audit.js";
import type { ActionsAuditResult } from "./astro-actions/types.js";

export type {
  ActionDescriptor,
  ActionsAuditIssue,
  ActionsAuditResult,
} from "./astro-actions/types.js";
export { auditAstroActionsFromIndex } from "./astro-actions/audit.js";

export async function astroActionsAudit(args: {
  repo?: string;
  severity?: "all" | "warnings" | "errors";
}): Promise<ActionsAuditResult> {
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) {
    return {
      actions: [],
      issues: [],
      anti_patterns_checked: ALL_ACTION_CODES,
      summary: { total_actions: 0, total_issues: 0, score: "A" },
    };
  }
  return auditAstroActionsFromIndex(index, args.severity);
}
