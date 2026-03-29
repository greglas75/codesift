import { getCodeIndex } from "./index-tools.js";
import { collectImportEdges } from "../utils/import-graph.js";

export interface BoundaryRule {
  from: string;
  cannot_import?: string[];
  can_only_import?: string[];
}

export interface BoundaryViolation {
  file: string;
  imports: string;
  rule_from: string;
  reason: string;
}

export interface CheckBoundariesResult {
  violations: BoundaryViolation[];
  edges_checked: number;
  rules_applied: number;
  passed: boolean;
}

/**
 * Check architecture boundary rules against the import graph.
 *
 * Rules use path substring matching:
 *   { from: "src/domain", cannot_import: ["src/infrastructure", "src/api"] }
 *   { from: "src/api", can_only_import: ["src/domain", "src/application"] }
 *
 * `cannot_import` — files matching `from` must NOT import files matching any listed pattern.
 * `can_only_import` — files matching `from` may ONLY import files matching one of the listed patterns.
 */
export async function checkBoundaries(
  repo: string,
  rules: BoundaryRule[],
  options?: { file_pattern?: string },
): Promise<CheckBoundariesResult> {
  if (!rules.length) {
    return { violations: [], edges_checked: 0, rules_applied: 0, passed: true };
  }

  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository not found: ${repo}`);

  const edges = await collectImportEdges(index);

  const violations: BoundaryViolation[] = [];
  let edgesChecked = 0;

  for (const edge of edges) {
    if (options?.file_pattern && !edge.from.includes(options.file_pattern)) continue;
    edgesChecked++;

    for (const rule of rules) {
      if (!edge.from.includes(rule.from)) continue;

      if (rule.cannot_import) {
        for (const forbidden of rule.cannot_import) {
          if (edge.to.includes(forbidden)) {
            violations.push({
              file: edge.from,
              imports: edge.to,
              rule_from: rule.from,
              reason: `"${rule.from}" cannot import "${forbidden}"`,
            });
          }
        }
      }

      if (rule.can_only_import) {
        const allowed = rule.can_only_import.some((pattern) => edge.to.includes(pattern));
        if (!allowed) {
          violations.push({
            file: edge.from,
            imports: edge.to,
            rule_from: rule.from,
            reason: `"${rule.from}" can only import [${rule.can_only_import.join(", ")}]`,
          });
        }
      }
    }
  }

  return {
    violations,
    edges_checked: edgesChecked,
    rules_applied: rules.length,
    passed: violations.length === 0,
  };
}
