/**
 * analyze_prisma_schema — AST-aware Prisma schema coverage report.
 *
 * Parses `schema.prisma` via @mrleebo/prisma-ast and produces a structured
 * report covering FK index coverage, soft-delete detection, status-as-String
 * code smells, and timestamp hygiene. Complements the regex-based extractor
 * in src/parser/extractors/prisma.ts (which only catches top-level block
 * names for the symbol index).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getSchema,
  type Schema,
  type Block,
  type Model,
  type Field,
  type Enum,
  type BlockAttribute,
  type Attribute,
  type AttributeArgument,
  type KeyValue,
  type Value,
} from "@mrleebo/prisma-ast";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrismaModelInfo {
  name: string;
  field_count: number;
  has_id: boolean;
  has_created_at: boolean;
  has_updated_at: boolean;
  has_soft_delete: boolean;
  fk_columns: string[];
  fk_columns_with_index: string[];
  fk_columns_without_index: string[];
  composite_indexes: string[];
  unique_constraints: string[];
  uses_enum_fields: string[];
  status_like_string_fields: string[];
}

export interface PrismaSchemaReport {
  schema_path: string;
  model_count: number;
  enum_count: number;
  models: PrismaModelInfo[];
  totals: {
    fk_columns: number;
    fk_with_index: number;
    fk_without_index: number;
    fk_index_coverage_pct: number;
    soft_delete_models: number;
    composite_indexes: number;
    single_indexes: number;
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMESTAMP_CREATED = new Set(["createdAt", "created_at"]);
const TIMESTAMP_UPDATED = new Set(["updatedAt", "updated_at"]);
const SOFT_DELETE_NAMES = new Set(["deletedAt", "deleted_at"]);
const STATUS_LIKE_RE = /^(status|state|type|kind)$/i;

// ---------------------------------------------------------------------------
// AST helpers — narrow types safely
// ---------------------------------------------------------------------------

function isModel(block: Block): block is Model {
  return block.type === "model";
}

function isEnum(block: Block): block is Enum {
  return block.type === "enum";
}

function isField(prop: unknown): prop is Field {
  return (
    typeof prop === "object" &&
    prop !== null &&
    (prop as { type?: unknown }).type === "field"
  );
}

function isBlockAttribute(prop: unknown): prop is BlockAttribute {
  return (
    typeof prop === "object" &&
    prop !== null &&
    (prop as { type?: unknown }).type === "attribute" &&
    (prop as { kind?: unknown }).kind === "object"
  );
}

function isFieldAttribute(attr: unknown): attr is Attribute {
  return (
    typeof attr === "object" &&
    attr !== null &&
    (attr as { type?: unknown }).type === "attribute" &&
    (attr as { kind?: unknown }).kind === "field"
  );
}

function isKeyValue(value: unknown): value is KeyValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "keyValue"
  );
}

/**
 * Extract the primitive type name for a Field's `fieldType`. Relation fields
 * have a string type (e.g. "User"); scalars also have string types ("String",
 * "Int"). Func-typed fields (rare, e.g. Unsupported) return null.
 */
function getFieldTypeName(field: Field): string | null {
  if (typeof field.fieldType === "string") return field.fieldType;
  return null;
}

/**
 * Pull string column names out of a Value that is expected to be an array of
 * identifiers (the typical shape of `[authorId, createdAt]` in @@index,
 * @@unique, or @relation(fields: [...])).
 */
function extractIdentifierArray(value: Value): string[] {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "array"
  ) {
    const args = (value as { args?: unknown }).args;
    if (Array.isArray(args)) {
      return args.filter((a): a is string => typeof a === "string");
    }
  }
  return [];
}

/**
 * Given a field-level `@relation(...)` attribute, return the list of scalar FK
 * column names from its `fields:` argument. Missing/empty when the field is
 * the inverse side of a 1-to-many (no `fields:` key).
 */
function getRelationFkColumns(relationAttr: Attribute): string[] {
  const args: AttributeArgument[] | undefined = relationAttr.args;
  if (!args) return [];
  for (const arg of args) {
    const v = arg.value;
    if (isKeyValue(v) && v.key === "fields") {
      return extractIdentifierArray(v.value);
    }
  }
  return [];
}

/**
 * Given a model-level `@@index([a, b])` or `@@unique([a, b])`, return the
 * column list.
 */
function getBlockAttrColumns(blockAttr: BlockAttribute): string[] {
  const args = blockAttr.args;
  if (!args || args.length === 0) return [];
  // First positional arg is the column array; named args like `name:` come
  // later and should be ignored here.
  const first = args[0];
  if (!first) return [];
  const v = first.value;
  if (isKeyValue(v)) return extractIdentifierArray(v.value);
  return extractIdentifierArray(v as Value);
}

// ---------------------------------------------------------------------------
// Schema file resolution
// ---------------------------------------------------------------------------

async function resolveSchemaPath(
  repoRoot: string,
  indexFiles: ReadonlyArray<{ path: string }>,
  explicit: string | undefined,
): Promise<{ absolute: string; relative: string }> {
  if (explicit) {
    return {
      absolute: join(repoRoot, explicit),
      relative: explicit,
    };
  }
  const match = indexFiles.find((f) => f.path.endsWith(".prisma"));
  if (!match) {
    throw new Error(
      "No Prisma schema found in index. Pass options.schema_path or index a .prisma file first.",
    );
  }
  return {
    absolute: join(repoRoot, match.path),
    relative: match.path,
  };
}

// ---------------------------------------------------------------------------
// Model analysis
// ---------------------------------------------------------------------------

interface ModelAnalysis {
  info: PrismaModelInfo;
  warnings: string[];
}

function analyzeModel(model: Model, enumNames: Set<string>): ModelAnalysis {
  const warnings: string[] = [];

  let fieldCount = 0;
  let hasId = false;
  let hasCreatedAt = false;
  let hasUpdatedAt = false;
  let hasSoftDelete = false;

  const fkColumns: string[] = [];
  const usesEnumFields: string[] = [];
  const statusLikeStringFields: string[] = [];

  const compositeIndexColumns: string[][] = [];
  const singleIndexColumns: string[] = [];
  const uniqueConstraintColumns: string[][] = [];

  // --- pass 1: fields ---
  for (const prop of model.properties) {
    if (!isField(prop)) continue;
    fieldCount++;
    const field = prop;
    const typeName = getFieldTypeName(field);

    // id detection — either @id attribute or name === "id"
    if (field.name === "id" || hasFieldAttribute(field, "id")) {
      hasId = true;
    }

    // timestamps
    if (TIMESTAMP_CREATED.has(field.name)) hasCreatedAt = true;
    if (TIMESTAMP_UPDATED.has(field.name)) hasUpdatedAt = true;
    if (SOFT_DELETE_NAMES.has(field.name)) hasSoftDelete = true;

    // @relation → FK columns
    const relationAttr = findFieldAttribute(field, "relation");
    if (relationAttr) {
      for (const col of getRelationFkColumns(relationAttr)) {
        if (!fkColumns.includes(col)) fkColumns.push(col);
      }
    }

    // enum-typed fields
    if (typeName && enumNames.has(typeName)) {
      usesEnumFields.push(field.name);
    }

    // status-like String fields
    if (typeName === "String" && STATUS_LIKE_RE.test(field.name)) {
      statusLikeStringFields.push(field.name);
    }

    // single-column @unique on field
    if (hasFieldAttribute(field, "unique")) {
      uniqueConstraintColumns.push([field.name]);
    }
  }

  // --- pass 2: model-level block attributes (@@index, @@unique) ---
  for (const prop of model.properties) {
    if (!isBlockAttribute(prop)) continue;
    const cols = getBlockAttrColumns(prop);
    if (cols.length === 0) continue;

    if (prop.name === "index") {
      if (cols.length > 1) {
        compositeIndexColumns.push(cols);
      } else {
        const only = cols[0];
        if (only) singleIndexColumns.push(only);
      }
    } else if (prop.name === "unique") {
      uniqueConstraintColumns.push(cols);
    }
  }

  // --- FK coverage ---
  // A FK is "covered" if some @@index starts with it (first-column match is
  // what the DB planner uses for join seeks) OR some @@unique starts with it.
  const indexPrefixes = new Set<string>();
  for (const cols of compositeIndexColumns) {
    const first = cols[0];
    if (first) indexPrefixes.add(first);
  }
  for (const col of singleIndexColumns) indexPrefixes.add(col);
  for (const cols of uniqueConstraintColumns) {
    const first = cols[0];
    if (first) indexPrefixes.add(first);
  }

  const fkColumnsWithIndex: string[] = [];
  const fkColumnsWithoutIndex: string[] = [];
  for (const col of fkColumns) {
    if (indexPrefixes.has(col)) fkColumnsWithIndex.push(col);
    else fkColumnsWithoutIndex.push(col);
  }

  // --- warnings ---
  for (const col of fkColumnsWithoutIndex) {
    warnings.push(
      `Model ${model.name} has FK '${col}' without @@index — full table scan on join.`,
    );
  }
  for (const col of statusLikeStringFields) {
    warnings.push(
      `Model ${model.name}.${col} is a String field named like an enum — consider converting to a Prisma enum.`,
    );
  }
  if (!hasCreatedAt) {
    warnings.push(
      `Model ${model.name} has no createdAt timestamp — audit trail may be missing.`,
    );
  }
  if (!hasUpdatedAt) {
    warnings.push(
      `Model ${model.name} has no updatedAt timestamp — mutation history may be lost.`,
    );
  }

  const info: PrismaModelInfo = {
    name: model.name,
    field_count: fieldCount,
    has_id: hasId,
    has_created_at: hasCreatedAt,
    has_updated_at: hasUpdatedAt,
    has_soft_delete: hasSoftDelete,
    fk_columns: fkColumns,
    fk_columns_with_index: fkColumnsWithIndex,
    fk_columns_without_index: fkColumnsWithoutIndex,
    composite_indexes: compositeIndexColumns.map((cols) => `[${cols.join(", ")}]`),
    unique_constraints: uniqueConstraintColumns.map((cols) => `[${cols.join(", ")}]`),
    uses_enum_fields: usesEnumFields,
    status_like_string_fields: statusLikeStringFields,
  };

  return { info, warnings };
}

function hasFieldAttribute(field: Field, name: string): boolean {
  return findFieldAttribute(field, name) !== null;
}

function findFieldAttribute(field: Field, name: string): Attribute | null {
  const attrs = field.attributes;
  if (!attrs) return null;
  for (const attr of attrs) {
    if (isFieldAttribute(attr) && attr.name === name) return attr;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function analyzePrismaSchema(
  repo: string,
  options?: { schema_path?: string },
): Promise<PrismaSchemaReport> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(
      `Repository "${repo}" not found. Index it first with index_folder.`,
    );
  }

  const { absolute, relative } = await resolveSchemaPath(
    index.root,
    index.files,
    options?.schema_path,
  );

  let source: string;
  try {
    source = await readFile(absolute, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read Prisma schema at ${relative}: ${(err as Error).message}`,
    );
  }

  const schema: Schema = getSchema(source);

  // First pass: collect enum names so model analysis can classify enum fields.
  const enumNames = new Set<string>();
  for (const block of schema.list) {
    if (isEnum(block)) enumNames.add(block.name);
  }

  const models: PrismaModelInfo[] = [];
  const allWarnings: string[] = [];

  for (const block of schema.list) {
    if (!isModel(block)) continue;
    const { info, warnings } = analyzeModel(block, enumNames);
    models.push(info);
    allWarnings.push(...warnings);
  }

  // --- aggregate totals ---
  let totalFk = 0;
  let totalFkWithIndex = 0;
  let totalFkWithoutIndex = 0;
  let softDeleteModels = 0;
  let totalComposite = 0;
  let totalSingle = 0;

  for (const m of models) {
    totalFk += m.fk_columns.length;
    totalFkWithIndex += m.fk_columns_with_index.length;
    totalFkWithoutIndex += m.fk_columns_without_index.length;
    if (m.has_soft_delete) softDeleteModels++;
    totalComposite += m.composite_indexes.length;
    // single indexes = @@index entries that aren't composite; we didn't retain
    // them per-model in the output, so recompute from fk_with_index that came
    // from single indexes is lossy. Just count via FK coverage heuristic:
    // any single-col @@index contributed here. For totals we recount below.
  }

  // Recount single indexes across models by examining the info arrays we kept.
  // composite_indexes only holds multi-column ones, so single-column @@index
  // counts need a separate walk — do it on the already-analyzed blocks.
  for (const block of schema.list) {
    if (!isModel(block)) continue;
    for (const prop of block.properties) {
      if (!isBlockAttribute(prop)) continue;
      if (prop.name !== "index") continue;
      const cols = getBlockAttrColumns(prop);
      if (cols.length === 1) totalSingle++;
    }
  }

  const coveragePct =
    totalFk === 0 ? 100 : Math.round((totalFkWithIndex / totalFk) * 1000) / 10;

  return {
    schema_path: relative,
    model_count: models.length,
    enum_count: enumNames.size,
    models,
    totals: {
      fk_columns: totalFk,
      fk_with_index: totalFkWithIndex,
      fk_without_index: totalFkWithoutIndex,
      fk_index_coverage_pct: coveragePct,
      soft_delete_models: softDeleteModels,
      composite_indexes: totalComposite,
      single_indexes: totalSingle,
    },
    warnings: allWarnings,
  };
}
