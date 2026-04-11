/**
 * Room persistence library analysis tools.
 *
 * trace_room_schema — build Entity → Dao → Database graph from indexed
 * Kotlin symbols annotated with @Entity, @Dao, @Database, @Query, etc.
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomEntity {
  name: string;
  file: string;
  start_line: number;
  table_name: string;
  has_primary_key: boolean;
}

export interface RoomQuery {
  name: string;
  file: string;
  start_line: number;
  sql: string;
  annotation: string;
}

export interface RoomDao {
  name: string;
  file: string;
  start_line: number;
  queries: RoomQuery[];
  entity_refs: string[];
}

export interface RoomDatabase {
  name: string;
  file: string;
  start_line: number;
  entity_refs: string[];
  version?: number;
}

export interface RoomSchemaResult {
  entities: RoomEntity[];
  daos: RoomDao[];
  databases: RoomDatabase[];
  total_queries: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasAnnotation(sym: CodeSymbol, name: string): boolean {
  if (sym.decorators?.includes(name)) return true;
  const head = sym.source?.slice(0, 300);
  if (!head) return false;
  return new RegExp(`@${name}\\b`).test(head);
}

/**
 * Extract `tableName = "..."` from @Entity annotation source.
 * Falls back to camelCase→snake_case of the class name.
 */
function extractTableName(sym: CodeSymbol): string {
  const src = sym.source ?? "";
  const match = /tableName\s*=\s*"([^"]+)"/.exec(src);
  if (match) return match[1]!;
  // Fallback: Room default = class name (no case conversion in Room)
  return sym.name;
}

/**
 * Extract SQL string from @Query("...") on a method.
 */
function extractQuerySql(sym: CodeSymbol): string | null {
  const src = sym.source ?? "";
  const match = /@Query\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(src);
  return match?.[1]?.replace(/\\"/g, '"') ?? null;
}

/**
 * Extract entity class references from @Database(entities = [...]).
 */
function extractDatabaseEntityRefs(sym: CodeSymbol): string[] {
  const src = sym.source ?? "";
  const match = /entities\s*=\s*\[([^\]]+)\]/.exec(src);
  if (!match) return [];
  // Parse `UserEntity::class, OrderEntity::class`
  return match[1]!
    .split(",")
    .map((s) => s.trim().replace(/::class$/, "").trim())
    .filter(Boolean);
}

function extractDatabaseVersion(sym: CodeSymbol): number | undefined {
  const src = sym.source ?? "";
  const match = /version\s*=\s*(\d+)/.exec(src);
  return match ? parseInt(match[1]!, 10) : undefined;
}

// ---------------------------------------------------------------------------
// trace_room_schema
// ---------------------------------------------------------------------------

export async function traceRoomSchema(
  repo: string,
): Promise<RoomSchemaResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const entities: RoomEntity[] = [];
  const daos: RoomDao[] = [];
  const databases: RoomDatabase[] = [];
  const daoById = new Map<string, RoomDao>();

  // First pass: classify @Entity, @Dao, @Database.
  for (const sym of index.symbols) {
    if (sym.kind !== "class" && sym.kind !== "interface") continue;

    if (hasAnnotation(sym, "Entity")) {
      entities.push({
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        table_name: extractTableName(sym),
        has_primary_key: /\b(?:@PrimaryKey|primaryKeys)\b/.test(sym.source ?? ""),
      });
    }

    if (hasAnnotation(sym, "Dao")) {
      const dao: RoomDao = {
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        queries: [],
        entity_refs: [],
      };
      daos.push(dao);
      daoById.set(sym.id, dao);
    }

    if (hasAnnotation(sym, "Database")) {
      const db: RoomDatabase = {
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        entity_refs: extractDatabaseEntityRefs(sym),
      };
      const ver = extractDatabaseVersion(sym);
      if (ver != null) db.version = ver;
      databases.push(db);
    }
  }

  // Second pass: attach @Query/@Insert/@Update/@Delete methods to parent Dao.
  const ROOM_METHOD_ANNOTATIONS = ["Query", "Insert", "Update", "Delete", "RawQuery"];
  for (const sym of index.symbols) {
    if (sym.kind !== "method" && sym.kind !== "function") continue;
    if (!sym.parent) continue;
    const dao = daoById.get(sym.parent);
    if (!dao) continue;

    for (const ann of ROOM_METHOD_ANNOTATIONS) {
      if (hasAnnotation(sym, ann)) {
        const sql = ann === "Query" ? extractQuerySql(sym) : null;
        dao.queries.push({
          name: sym.name,
          file: sym.file,
          start_line: sym.start_line,
          sql: sql ?? `[${ann}]`,
          annotation: ann,
        });
        // Track entity references from return types / param types.
        const sig = sym.signature ?? "";
        for (const entity of entities) {
          if (sig.includes(entity.name)) {
            if (!dao.entity_refs.includes(entity.name)) {
              dao.entity_refs.push(entity.name);
            }
          }
        }
        break;
      }
    }
  }

  return {
    entities,
    daos,
    databases,
    total_queries: daos.reduce((n, d) => n + d.queries.length, 0),
  };
}
