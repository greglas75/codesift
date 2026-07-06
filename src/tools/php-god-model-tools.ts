/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { getCodeIndex } from "./index-tools.js";
import { analyzeActiveRecord } from "./php-active-record-tools.js";

// 7i. find_php_god_model — oversized ActiveRecord models
// ---------------------------------------------------------------------------

export interface GodModelFinding {
  name: string;
  file: string;
  method_count: number;
  relation_count: number;
  line_count: number;
  reasons: string[];
}

/**
 * Flag oversized PHP classes. Two scopes:
 *
 * - `scope: "activerecord"` (default) — only models extending ActiveRecord.
 *   Uses `analyzeActiveRecord` for model detection and counts relations as a
 *   third threshold alongside methods and lines. Classic Yii2 god-model case:
 *   Survey.php in Mobi2 with 175 methods, 30 relations, 2291 lines.
 *
 * - `scope: "all"` — every PHP class in the index, regardless of base class.
 *   Captures service god-classes (UserService with 80 methods), component
 *   aggregates, and any other PHP class that outgrew its responsibility.
 *   `relation_count` is 0 for non-AR classes — the `min_relations` check is
 *   skipped so a service with 60 methods isn't hidden by a relation threshold.
 *
 * Thresholds default to 50/15/500 but are configurable for both scopes.
 */
export async function findPhpGodModel(
  repo: string,
  options?: {
    min_methods?: number;
    min_relations?: number;
    min_lines?: number;
    scope?: "activerecord" | "all";
  },
): Promise<{ models: GodModelFinding[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const minM = options?.min_methods ?? 50;
  const minR = options?.min_relations ?? 15;
  const minL = options?.min_lines ?? 500;
  const scope = options?.scope ?? "activerecord";

  const models: GodModelFinding[] = [];

  if (scope === "activerecord") {
    const ar = await analyzeActiveRecord(repo);
    for (const m of ar.models) {
      // Look up the class symbol by (name, kind, file) — file match keeps
      // duplicate class names in different paths reported independently.
      const classSym = index.symbols.find(
        (s) => s.name === m.name && s.kind === "class" && s.file === m.file,
      );
      const lineCount = classSym ? classSym.end_line - classSym.start_line : 0;

      const reasons: string[] = [];
      if (m.methods.length > minM) reasons.push(`methods: ${m.methods.length} > ${minM}`);
      if (m.relations.length > minR) reasons.push(`relations: ${m.relations.length} > ${minR}`);
      if (lineCount > minL) reasons.push(`lines: ${lineCount} > ${minL}`);

      if (reasons.length > 0) {
        models.push({
          name: m.name,
          file: m.file,
          method_count: m.methods.length,
          relation_count: m.relations.length,
          line_count: lineCount,
          reasons,
        });
      }
    }
  } else {
    // scope === "all" — iterate every PHP class symbol directly.
    const classSyms = index.symbols.filter(
      (s) => s.kind === "class" && s.file.endsWith(".php"),
    );
    for (const cls of classSyms) {
      const methodCount = index.symbols.filter(
        (s) => s.parent === cls.id && s.kind === "method",
      ).length;
      const lineCount = cls.end_line - cls.start_line;

      const reasons: string[] = [];
      if (methodCount > minM) reasons.push(`methods: ${methodCount} > ${minM}`);
      if (lineCount > minL) reasons.push(`lines: ${lineCount} > ${minL}`);
      // min_relations intentionally skipped in "all" scope — not AR, no relations

      if (reasons.length > 0) {
        models.push({
          name: cls.name,
          file: cls.file,
          method_count: methodCount,
          relation_count: 0,
          line_count: lineCount,
          reasons,
        });
      }
    }
  }

  // Sort by severity (number of reasons desc, then methods desc)
  models.sort((a, b) => b.reasons.length - a.reasons.length || b.method_count - a.method_count);

  return { models, total: models.length };
}

// ---------------------------------------------------------------------------
