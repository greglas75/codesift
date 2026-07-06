/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getCodeIndex } from "./index-tools.js";

// 7h. find_php_n_plus_one — detect foreach + relation access without ->with()
// ---------------------------------------------------------------------------

/**
 * Common ActiveRecord scalar field names. Property access like $user->id or
 * $user->created_at inside a foreach is NOT a relation (no N+1 risk), so we
 * allow-list these to cut false positives.
 */
const SCALAR_FIELD_NAMES = new Set([
  "id", "name", "title", "created_at", "updated_at", "deleted_at", "status",
  "email", "slug", "code", "type", "value", "label", "description", "enabled",
  "active", "position", "sort", "order", "count", "total", "amount", "price",
  "uuid", "hash", "token", "key", "url", "path", "image", "avatar",
]);

/**
 * PHP method names that look like `get*` but are NOT ActiveRecord relation
 * getters. `$item->save()` / `$item->validate()` inside a foreach is fine;
 * flagging them as N+1 would be a false positive. These names are stripped
 * from the `get\w+()` method-call detection before the eager-load check.
 */
const METHOD_CALL_BLOCKLIST = new Set([
  "save", "validate", "delete", "refresh", "load", "populate", "toArray",
  "afterSave", "beforeSave", "beforeDelete", "afterDelete",
  "getAttributes", "getAttribute", "getIsNewRecord", "getErrors", "getFirstError",
  "getOldAttributes", "getDirtyAttributes", "getPrimaryKey", "getTableSchema",
]);

export interface NPlusOneFinding {
  file: string;
  method: string;
  line: number;
  relation: string;
  pattern: string;
}

/**
 * Detect N+1 query patterns in Yii2/Eloquent controllers.
 *
 * Pattern: `foreach ($items as $item) { $item->relation->... }` without a
 * prior `->with('relation')` call in the same method scope. This is the
 * most common N+1 anti-pattern in Yii2 ActiveRecord code.
 *
 * Known limitations (acceptable for a "discovery" tool, not a gate):
 * - Regex-based — can miss multi-line foreach bodies split across nested blocks
 * - Doesn't cross function boundaries — eager loading in caller is invisible
 * - False positives on nested loops if the outer collection is already eager-loaded
 */
export async function findPhpNPlusOne(
  repo: string,
  options?: { limit?: number; file_pattern?: string },
): Promise<{ findings: NPlusOneFinding[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const findings: NPlusOneFinding[] = [];
  const limit = options?.limit ?? 100;
  const filePattern = options?.file_pattern;

  // Normalize `getProfile` → `profile` so the ->with() check matches whether
  // the relation is accessed as a property or via its auto-generated getter.
  const normalizeGetter = (name: string): string => {
    const bare = name.replace(/^get/, "");
    return bare.length > 0 ? bare.charAt(0).toLowerCase() + bare.slice(1) : "";
  };

  // A finding is emitted exactly once per (foreach × relation-name) tuple so
  // that chained patterns don't double-report the same relation that the
  // property pattern already caught in the same loop body.
  const emitFinding = (
    sym: { file: string; name: string; source: string; start_line: number },
    foreachIdx: number,
    relation: string,
    pattern: string,
    seen: Set<string>,
  ): boolean => {
    if (!relation || seen.has(relation)) return findings.length >= limit;
    seen.add(relation);

    if (SCALAR_FIELD_NAMES.has(relation.toLowerCase())) return findings.length >= limit;

    const beforeForeach = sym.source.slice(0, foreachIdx);
    const withRe = new RegExp(`\\bwith\\s*\\(\\s*['"]${relation}['"]`);
    if (withRe.test(beforeForeach)) return findings.length >= limit;

    const lineOffset = beforeForeach.split("\n").length - 1;
    findings.push({
      file: sym.file,
      method: sym.name,
      line: sym.start_line + lineOffset,
      relation,
      pattern,
    });
    return findings.length >= limit;
  };

  // Helper: scan a single chunk of source (a method body OR a view file) for
  // all 4 N+1 patterns. Returns true once `limit` is hit so the caller can
  // short-circuit.
  function scanChunk(
    file: string,
    methodName: string,
    src: string,
    startLine: number,
  ): boolean {
    const foreachRe = /foreach\s*\(\s*\$(\w+)\s+as\s+(?:\$\w+\s*=>\s*)?\$(\w+)\s*\)/g;
    let fm: RegExpExecArray | null;
    while ((fm = foreachRe.exec(src)) !== null) {
      const itemVar = fm[2]!;
      const foreachIdx = fm.index;
      const after = src.slice(foreachIdx);
      const seen = new Set<string>();

      // Pattern 1 — property access: $item->profile
      const propRe = new RegExp(`\\$${itemVar}->(\\w+)(?![\\w(])`, "g");
      let m: RegExpExecArray | null;
      while ((m = propRe.exec(after)) !== null) {
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            m[1]!,
            "foreach-access-without-with",
            seen,
          )
        ) {
          return true;
        }
      }

      // Pattern 2 — getter method call: $item->getProfile()
      const getterRe = new RegExp(
        `\\$${itemVar}->(get\\w+)\\s*\\(\\s*\\)`,
        "g",
      );
      while ((m = getterRe.exec(after)) !== null) {
        const rawMethod = m[1]!;
        if (METHOD_CALL_BLOCKLIST.has(rawMethod)) continue;
        const normalized = normalizeGetter(rawMethod);
        if (!normalized || METHOD_CALL_BLOCKLIST.has(normalized.toLowerCase()))
          continue;
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            normalized,
            "foreach-getter-without-with",
            seen,
          )
        ) {
          return true;
        }
      }

      // Pattern 3 — chained access: $item->rel->sub
      const chainRe = new RegExp(`\\$${itemVar}->(\\w+)->\\w`, "g");
      while ((m = chainRe.exec(after)) !== null) {
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            m[1]!,
            "foreach-chained-without-with",
            seen,
          )
        ) {
          return true;
        }
      }

      // Pattern 4 (Sprint 3) — explicit lookup in loop body. Inside the foreach,
      // a `Model::findOne(...)` / `Model::findAll(...)` / `->find()` is the
      // lazy-load smell — each iteration hits the database.
      //
      // We scan a bounded 2000-char window after the foreach header to keep
      // the regex cost predictable on large methods. A nested foreach inside
      // the window will still match on its own /g iteration, and the outer
      // `seen` set deduplicates so we never double-report a single class+method.
      const body = after.slice(0, Math.min(after.length, 2000));

      const findOneRe =
        /(\w+)::(findOne|findAll|find|findBySql)\s*\(/g;
      let lm: RegExpExecArray | null;
      while ((lm = findOneRe.exec(body)) !== null) {
        const targetClass = lm[1]!;
        const method = lm[2]!;
        // Filter common false positives: top-level utility classes that
        // happen to expose static `find*` methods but aren't AR.
        if (
          targetClass === "Yii" ||
          targetClass === "ArrayHelper" ||
          targetClass === "self" ||
          targetClass === "static"
        ) {
          continue;
        }
        const synthetic = `${targetClass}::${method}`;
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            synthetic,
            "foreach-findone-in-loop",
            seen,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // Method-level scan (Patterns 1-4 inside class methods, the original surface).
  for (const sym of index.symbols) {
    if (sym.kind !== "method" || !sym.file.endsWith(".php") || !sym.source) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (scanChunk(sym.file, sym.name, sym.source, sym.start_line)) {
      return { findings, total: findings.length };
    }
  }

  // View-level scan (Sprint 3 Pattern 5) — Yii2 views/**/*.php files render
  // lists of models at module level. They're not class methods so they have
  // no symbol; scan the raw file content. `views/**/*.php` is the canonical
  // path; `_*.php` partials live at the same level.
  const viewFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    // Standard Yii2 view paths (basic + advanced + module-scoped layouts).
    return /(?:^|\/)(?:views|widgets|layouts)\//.test(f.path);
  });

  await Promise.all(
    viewFiles.map(async (file) => {
      if (findings.length >= limit) return;
      let content: string;
      try {
        content = await readFile(join(index.root, file.path), "utf-8");
      } catch {
        return;
      }
      // For views the "method name" is just the file basename — that's what
      // the caller sees in the finding when there is no enclosing function.
      const methodName = file.path.split("/").pop() ?? file.path;
      scanChunk(file.path, methodName, content, 1);
    }),
  );

  return { findings, total: findings.length };
}

// ---------------------------------------------------------------------------
