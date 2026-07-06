/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { getCodeIndex } from "./index-tools.js";
import { extractPhpNamespace, extractPhpUseImports, resolvePhpClassReference } from "./php-import-utils.js";

// 7b. analyze_activerecord — Model schema
// ---------------------------------------------------------------------------

export interface ActiveRecordModel {
  name: string;
  file: string;
  table_name: string | null;
  relations: { name: string; type: "hasOne" | "hasMany" | "manyMany"; target_class: string }[];
  rules: string[];
  behaviors: string[];
  methods: string[];
}

export interface ActiveRecordAnalysis {
  models: ActiveRecordModel[];
  total: number;
}

/**
 * Names of class roots that we treat as "this is an ActiveRecord". The check
 * is done on the LAST namespace segment so prefixed forms (yii\\db\\ActiveRecord,
 * \\yii\\db\\ActiveRecord, app\\models\\ActiveRecord) all match. Includes
 * yii\\base\\Model because Yii2 form models extending Model share the
 * rules() / behaviors() lifecycle that analyzeActiveRecord introspects;
 * downstream callers can filter by tableName() presence if they need a
 * stricter "real DB-backed AR" criterion.
 */
const AR_ROOT_NAMES = new Set(["ActiveRecord", "Model", "BaseActiveRecord"]);

/**
 * Walk a class symbol's `extends` chain and return true if any ancestor
 * matches a known ActiveRecord base class. Resolves transitively via the
 * symbol index — handles cases like `User extends BaseUser` where
 * `BaseUser extends ActiveRecord`.
 *
 * Direct match (root name in our AR_ROOT_NAMES set) wins immediately.
 * Otherwise we look up the parent class symbol by name and recurse. The
 * lookup prefers fully qualified namespace matches when the extractor
 * provides them, then falls back to same-namespace and short-name matching.
 *
 * Cycle protection via a visited set; depth-cap of 5 (no real Yii2 model
 * has a deeper chain).
 */
type PhpClassSymbol = {
  name: string;
  kind: string;
  extends?: string[];
  source?: string;
};

function phpClassFqcn(cls: PhpClassSymbol): string {
  const name = cls.name.replace(/^\\/, "");
  if (name.includes("\\")) return name;
  const namespace = extractPhpNamespace(cls.source);
  return namespace ? `${namespace}\\${name}` : name;
}

function resolveParentClass(
  parentFqcn: string,
  current: PhpClassSymbol,
  index: { symbols: PhpClassSymbol[] },
): PhpClassSymbol | undefined {
  const currentNamespace = extractPhpNamespace(current.source);
  const currentImports = extractPhpUseImports(current.source);
  const rawNormalized = parentFqcn.replace(/^\\/, "");
  const rawLast = rawNormalized.split(/[\\]+/).pop() ?? rawNormalized;

  if (rawNormalized.includes("\\")) {
    const exactRaw = index.symbols.find(
      (s) => s.kind === "class" && phpClassFqcn(s) === rawNormalized,
    );
    if (exactRaw) return exactRaw;
  }

  const normalized = resolvePhpClassReference(parentFqcn, {
    namespace: currentNamespace,
    imports: currentImports,
  });
  const last = normalized.split(/[\\]+/).pop() ?? normalized;

  if (normalized.includes("\\")) {
    const exact = index.symbols.find(
      (s) => s.kind === "class" && phpClassFqcn(s) === normalized,
    );
    if (exact) return exact;
  }

  return index.symbols.find(
    (s) => s.kind === "class" && (s.name === last || s.name === rawLast),
  );
}

function isActiveRecordHierarchy(
  cls: PhpClassSymbol,
  index: { symbols: PhpClassSymbol[] },
  visited: Set<string> = new Set(),
  depth = 0,
): boolean {
  if (depth > 5) return false;
  const clsKey = phpClassFqcn(cls);
  if (visited.has(clsKey)) return false;
  visited.add(clsKey);

  const exts = cls.extends ?? [];

  for (const baseFqcn of exts) {
    // Last segment of FQCN (handles "\\yii\\db\\ActiveRecord" and aliases).
    const last = baseFqcn.split(/[\\\\]+/).pop() ?? baseFqcn;
    if (AR_ROOT_NAMES.has(last)) return true;

    // Look up the base class as an indexed symbol and recurse.
    const baseSym = resolveParentClass(baseFqcn, cls, index);
    if (baseSym && isActiveRecordHierarchy(baseSym, index, visited, depth + 1)) {
      return true;
    }
  }

  // Fallback for older indexes (e.g. before the v2.0.0 extractor bump): if
  // `extends` is missing on this symbol, try the legacy regex against
  // `source` so we don't regress on unindexed projects.
  if (!cls.extends && cls.source) {
    return /extends\s+(?:ActiveRecord|Model|\\yii\\db\\ActiveRecord)\b/.test(
      cls.source,
    );
  }
  return false;
}

export async function analyzeActiveRecord(
  repo: string,
  options?: { model_name?: string; file_pattern?: string },
): Promise<ActiveRecordAnalysis> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Find PHP class symbols in model files
  const classSymbols = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith(".php")) return false;
    if (options?.model_name && s.name !== options.model_name) return false;
    if (options?.file_pattern && !s.file.includes(options.file_pattern)) return false;
    return true;
  });

  const models: ActiveRecordModel[] = [];

  for (const cls of classSymbols) {
    if (!cls.source) continue;
    if (!isActiveRecordHierarchy(cls, index)) continue;

    const model: ActiveRecordModel = {
      name: cls.name,
      file: cls.file,
      table_name: null,
      relations: [],
      rules: [],
      behaviors: [],
      methods: [],
    };

    // Extract tableName() return value
    const tableMatch = /function\s+tableName\s*\([^)]*\)[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/s.exec(cls.source);
    if (tableMatch) model.table_name = tableMatch[1]!;

    // Find child method symbols
    const methods = index.symbols.filter(
      (s) => s.parent === cls.id && s.kind === "method",
    );
    model.methods = methods.map((m) => m.name);

    // Extract relations from getX() methods that return hasOne/hasMany.
    // Two-pass detection:
    //   Pass 1: find the primary `->hasOne(Target::class, ...)` or
    //           `->hasMany(Target::class, ...)` call.
    //   Pass 2: scan the rest of the source for modifiers:
    //             ->via('relation')         (Yii2 2.0.13+ junction table via relation)
    //             ->viaTable('tbl', [...])  (direct junction table)
    //             ->inverseOf('relation')   (bidirectional relation)
    //           The presence of `via` or `viaTable` upgrades the relation type
    //           to `manyMany`. `inverseOf` is decorative and doesn't change type.
    for (const m of methods) {
      if (!m.name.startsWith("get") || !m.source) continue;
      const relName = m.name.slice(3);
      const primaryRe = /->(hasOne|hasMany)\s*\(\s*([\w\\]+)(?:::class)?/;
      const primaryMatch = primaryRe.exec(m.source);
      if (!primaryMatch) continue;

      const baseType: "hasOne" | "hasMany" = primaryMatch[1] === "hasOne" ? "hasOne" : "hasMany";
      const targetClass = primaryMatch[2]!;

      // Scan the method source for junction-table modifiers on the same chain.
      // If found, the semantic type is manyMany even though the primary call was hasMany.
      const hasJunction = /->(?:via|viaTable)\s*\(/.test(m.source);
      const type: "hasOne" | "hasMany" | "manyMany" = hasJunction ? "manyMany" : baseType;

      model.relations.push({
        name: relName.charAt(0).toLowerCase() + relName.slice(1),
        type,
        target_class: targetClass,
      });
    }

    // Extract rule validators (loose regex on rules() method source)
    const rulesMethod = methods.find((m) => m.name === "rules");
    if (rulesMethod?.source) {
      const ruleMatches = rulesMethod.source.matchAll(/\[\s*\[?['"]?[\w,\s'"]+['"]?\]?\s*,\s*['"]([\w]+)['"]/g);
      for (const rm of ruleMatches) {
        if (rm[1] && !model.rules.includes(rm[1])) model.rules.push(rm[1]);
      }
    }

    // Extract behaviors from behaviors() method
    const behaviorsMethod = methods.find((m) => m.name === "behaviors");
    if (behaviorsMethod?.source) {
      const bMatches = behaviorsMethod.source.matchAll(/([A-Z]\w+Behavior)(?:::class)?/g);
      for (const bm of bMatches) {
        if (bm[1] && !model.behaviors.includes(bm[1])) model.behaviors.push(bm[1]);
      }
    }

    models.push(model);
  }

  return { models, total: models.length };
}

// ---------------------------------------------------------------------------
