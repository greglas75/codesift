/**
 * PostgreSQL introspection tools.
 * `pg` is an optional dependency — all imports are dynamic so the module
 * loads cleanly even when `pg` is not installed.
 */

/** Minimal subset of the pg Client API we actually use. */
export interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** Success shape: the Client constructor wrapped in a plain object. */
export interface PgClientCtor {
  ClientCtor: new (cfg: { connectionString: string; connectionTimeoutMillis: number }) => PgClientLike;
}

/** Error shape returned when pg is absent or the import fails. */
export interface PgLoadError {
  error: string;
}

/**
 * Dynamically loads the `pg` package and returns its `Client` constructor.
 *
 * Returns a structured `{ error }` object — never throws — so callers can
 * check for the error case without a try/catch at the call site.
 */
type PgModuleShape = {
  default?: { Client?: new (cfg: { connectionString: string; connectionTimeoutMillis: number }) => PgClientLike };
  Client?: new (cfg: { connectionString: string; connectionTimeoutMillis: number }) => PgClientLike;
};

export async function loadPgClient(): Promise<PgClientCtor | PgLoadError> {
  try {
    // Dynamic import keeps pg entirely optional at the type level.
    // We use a specifier string stored in a variable so tsc does not attempt
    // to resolve "pg" as a static module (avoids TS2307 when @types/pg is
    // absent from node_modules at type-check time).
    const pgSpecifier = "pg";
    const mod = (await import(/* @vite-ignore */ pgSpecifier)) as PgModuleShape;
    // Handle both ESM default-export and CJS named-export shapes.
    const ClientCtor = mod.default?.Client ?? mod.Client;
    if (!ClientCtor) return { error: "pg not installed. Run: npm install pg" };
    return { ClientCtor };
  } catch {
    return { error: "pg not installed. Run: npm install pg" };
  }
}

// ── Task 9: introspectPgSchema ────────────────────────────────────────────
//
// NOTE on shapes: src/tools/sql-tools.ts exports `TableInfo` and `Relationship`,
// but those describe STATIC schema parsed from .sql files — `TableInfo` carries
// `{ file, line, columns: {name,type} }` and has no `nullable` / `primary_key` /
// `indexes`. Live PG introspection needs a structurally different table shape
// (per-column nullability, PK column list, index list) and a leaner relationship
// (no `file`/`line`/`type` discriminator). To avoid coupling the runtime
// introspection result to the static-parse types, we define local
// `PgTableInfo` / `PgRelationship` types here. They reuse the same field names
// as sql-tools where they overlap (name, columns.name, columns.type,
// from_table/from_column/to_table/to_column) so consumers see a familiar shape.

/** A column as seen by live PG introspection. */
export interface PgColumn {
  name: string;
  type: string;
  nullable: boolean;
}

/** A table as seen by live PG introspection. */
export interface PgTableInfo {
  name: string;
  columns: PgColumn[];
  primary_key: string[];
  indexes: string[];
}

/** A foreign-key relationship as seen by live PG introspection. */
export interface PgRelationship {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
}

/** Result of a successful (or partially successful) introspection. */
export interface PgIntrospectResult {
  tables: PgTableInfo[];
  relationships: PgRelationship[];
  warnings: string[];
}

/** Structured error shape — never leaks the connection string. */
export interface PgIntrospectError {
  error: string;
}

export interface IntrospectPgOptions {
  schema?: string;
  timeoutMs?: number;
  /**
   * Test seam: inject a Client constructor instead of loading the real `pg`
   * module. Production callers omit this — the real `pg` Client is loaded via
   * {@link loadPgClient}. Underscore-prefixed to signal "internal / test only".
   * The `pg` dynamic import uses a runtime string specifier with `@vite-ignore`,
   * which bypasses Vite/vitest module mocking, so DI is the only deterministic
   * way to drive a vi.fn-controlled Client through the production code path.
   */
  _clientCtor?: PgClientCtor["ClientCtor"];
}

/** Whole-call wall-clock cap (ms). Overridable via opts.timeoutMs. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Per-connection + per-statement cap (ms). */
const STATEMENT_TIMEOUT_MS = 5000;

const COLUMNS_SQL = `
  SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = $1
  ORDER BY table_name, ordinal_position`;

const PK_SQL = `
  SELECT kcu.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = $1
  ORDER BY kcu.table_name, kcu.ordinal_position`;

const INDEX_SQL = `
  SELECT tablename AS table_name, indexname AS index_name
  FROM pg_catalog.pg_indexes
  WHERE schemaname = $1
  ORDER BY tablename, indexname`;

const FK_SQL = `
  SELECT
    kcu.table_name        AS from_table,
    kcu.column_name       AS from_column,
    ccu.table_name        AS to_table,
    ccu.column_name       AS to_column
  FROM information_schema.referential_constraints rc
  JOIN information_schema.key_column_usage kcu
    ON rc.constraint_name = kcu.constraint_name
   AND rc.constraint_schema = kcu.table_schema
  JOIN information_schema.key_column_usage ccu
    ON rc.unique_constraint_name = ccu.constraint_name
   AND rc.unique_constraint_schema = ccu.table_schema
   AND kcu.ordinal_position = ccu.ordinal_position
  WHERE rc.constraint_schema = $1
  ORDER BY kcu.table_name, kcu.column_name`;

/**
 * Replace every occurrence of the connection string — and, separately, its
 * password component — with "[REDACTED]" inside arbitrary text.
 *
 * Why password-separately: a thrown driver error often echoes only the host
 * portion or a re-assembled URL with the password but a different surrounding
 * shape, so a single full-string replace can miss the secret. Parsing the URL
 * and replacing the password token independently closes that gap.
 *
 * Never throws — a malformed connStr just falls back to the full-string replace.
 */
export function redactConnStr(text: string, connStr: string): string {
  let out = text;
  if (connStr) {
    // 1. Replace the whole connection string verbatim.
    out = out.split(connStr).join("[REDACTED]");
    // 2. Replace the password component on its own (covers re-assembled forms).
    try {
      const url = new URL(connStr);
      if (url.password) {
        out = out.split(url.password).join("[REDACTED]");
      }
      // Also scrub a bare user:pass@ authority fragment if present in text.
      if (url.username && url.password) {
        out = out.split(`${url.username}:${url.password}`).join("[REDACTED]");
      }
    } catch {
      // Non-URL conn string (e.g. libpq keyword form). Best-effort: pull a
      // password=... token out and scrub its value.
      const m = /password=([^\s]+)/i.exec(connStr);
      if (m?.[1]) out = out.split(m[1]).join("[REDACTED]");
    }
  }
  return out;
}

/** Coerce any thrown value to a message string, then redact it. */
function redactError(err: unknown, connStr: string): string {
  const raw = err instanceof Error ? (err.message ?? String(err)) : String(err);
  return redactConnStr(raw, connStr);
}

/**
 * Introspect a live PostgreSQL database's schema over a fresh connection.
 *
 * Opens a new Client, sets a statement timeout, reads columns / primary keys /
 * indexes / foreign keys from information_schema + pg_catalog, and maps them to
 * {@link PgTableInfo}[] / {@link PgRelationship}[]. The whole call is bounded by
 * a wall-clock race (default 10s). The connection is always closed in a finally
 * block. No connection-string material ever appears in the returned object, a
 * warning, an error message, or a log.
 *
 * @returns {@link PgIntrospectResult} on success, or {@link PgIntrospectError}
 *   (with a redacted message) on any failure. Never throws, never logs secrets.
 */
export async function introspectPgSchema(
  connStr: string,
  opts: IntrospectPgOptions = {},
): Promise<PgIntrospectResult | PgIntrospectError> {
  // ── Input validation (CQ3) — before ANY Client construction ──────────────
  if (typeof connStr !== "string" || connStr.trim() === "") {
    return { error: "connStr is required and must be a non-empty string" };
  }

  const schema = opts.schema && opts.schema.trim() !== "" ? opts.schema : "public";
  const timeoutMs =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  // Resolve the Client constructor (injected seam or real pg).
  let ClientCtor: PgClientCtor["ClientCtor"];
  if (opts._clientCtor) {
    ClientCtor = opts._clientCtor;
  } else {
    const loaded = await loadPgClient();
    if ("error" in loaded) return { error: loaded.error };
    ClientCtor = loaded.ClientCtor;
  }

  // Construct the client up-front so the timeout path can also close it.
  // (runIntrospection's own finally cannot run while it is hung on a query —
  // so the wall-clock race owns cleanup for the timeout case.)
  const client = new ClientCtor({
    connectionString: connStr,
    connectionTimeoutMillis: STATEMENT_TIMEOUT_MS,
  });

  // Race the whole introspection against a wall-clock timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Static message (no secret), but redact defensively anyway.
      reject(new Error("pg introspection timed out"));
    }, timeoutMs);
  });

  // Hold a reference so we can silence any late rejection on the orphaned
  // promise when timeout wins the race (otherwise Node fires unhandledRejection
  // when the hung query later rejects — e.g. after client.end() tears the socket).
  const introspectionPromise = runIntrospection(client, connStr, schema);

  try {
    const result = await Promise.race([introspectionPromise, timeout]);
    return result;
  } catch (err) {
    return { error: redactError(err, connStr) };
  } finally {
    if (timer) clearTimeout(timer);
    // On the timeout path runIntrospection is still hung, so its finally never
    // ran — close the client here. On the normal path runIntrospection already
    // closed it; a second end() is harmless (and swallowed).
    if (timedOut) {
      // Swallow any future rejection from the orphaned introspection promise so
      // Node never fires unhandledRejection after client.end() destroys the socket.
      introspectionPromise.catch(() => undefined);
      try {
        await client.end();
      } catch {
        /* best-effort cleanup; never leak the conn string */
      }
    }
  }
}

/**
 * The actual connect → query → map flow. Split out so the timeout race in
 * {@link introspectPgSchema} stays readable. Always closes the client on the
 * non-timeout paths (success / connect-failure / query-failure).
 */
async function runIntrospection(
  client: PgClientLike,
  connStr: string,
  schema: string,
): Promise<PgIntrospectResult> {
  try {
    await client.connect();
    // FIRST query after connect — bound every subsequent statement.
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

    const [columnsRes, pkRes, indexRes, fkRes] = await Promise.all([
      client.query(COLUMNS_SQL, [schema]),
      client.query(PK_SQL, [schema]),
      client.query(INDEX_SQL, [schema]),
      client.query(FK_SQL, [schema]),
    ]);

    const tables = buildTables(columnsRes.rows, pkRes.rows, indexRes.rows);
    const relationships = buildRelationships(fkRes.rows);
    return { tables, relationships, warnings: [] };
  } catch (err) {
    // Redact before the error escapes runIntrospection so the caller's catch
    // (and the timeout race) never sees raw connection material.
    throw new Error(redactError(err, connStr));
  } finally {
    // Always close — connect-success, query-failure, or connect-failure paths.
    // end() itself may throw; swallow + redact so cleanup never leaks secrets.
    try {
      await client.end();
    } catch {
      /* best-effort cleanup; nothing actionable, never leak the conn string */
    }
  }
}

/** Map raw column/pk/index rows into {@link PgTableInfo}[], deterministically ordered. */
function buildTables(
  columnRows: Record<string, unknown>[],
  pkRows: Record<string, unknown>[],
  indexRows: Record<string, unknown>[],
): PgTableInfo[] {
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    const t = String(r["table_name"]);
    const c = String(r["column_name"]);
    const list = pkByTable.get(t) ?? [];
    list.push(c);
    pkByTable.set(t, list);
  }

  const idxByTable = new Map<string, string[]>();
  for (const r of indexRows) {
    const t = String(r["table_name"]);
    const i = String(r["index_name"]);
    const list = idxByTable.get(t) ?? [];
    list.push(i);
    idxByTable.set(t, list);
  }

  const tableOrder: string[] = [];
  const colsByTable = new Map<string, PgColumn[]>();
  for (const r of columnRows) {
    const t = String(r["table_name"]);
    if (!colsByTable.has(t)) {
      colsByTable.set(t, []);
      tableOrder.push(t);
    }
    colsByTable.get(t)!.push({
      name: String(r["column_name"]),
      type: String(r["data_type"]),
      nullable: String(r["is_nullable"]).toUpperCase() === "YES",
    });
  }

  return tableOrder.map((name) => ({
    name,
    columns: colsByTable.get(name) ?? [],
    primary_key: pkByTable.get(name) ?? [],
    indexes: idxByTable.get(name) ?? [],
  }));
}

/** Map raw FK rows into {@link PgRelationship}[]. */
function buildRelationships(fkRows: Record<string, unknown>[]): PgRelationship[] {
  return fkRows.map((r) => ({
    from_table: String(r["from_table"]),
    from_column: String(r["from_column"]),
    to_table: String(r["to_table"]),
    to_column: String(r["to_column"]),
  }));
}

// ── Task 10: pgDriftCheck ─────────────────────────────────────────────────

/**
 * A single column-level discrepancy between the live PG schema and the
 * migration-derived schema extracted from the code index.
 */
export interface PgColumnMismatch {
  table: string;
  column: string;
  kind: "missing_live" | "missing_migrations" | "type_mismatch";
  live_type?: string;
  migrations_type?: string;
}

/** Result of {@link pgDriftCheck}. */
export interface PgDriftResult {
  /** Tables present in the live DB but absent from any migration-derived symbol. */
  missing_tables_live_only: string[];
  /** Tables present in migrations but absent from the live DB. */
  missing_tables_migrations_only: string[];
  /** Column-level mismatches for tables that exist on both sides. */
  column_mismatches: PgColumnMismatch[];
  /** Human-readable note — set when no SQL symbols found in the index. */
  note?: string;
}

/**
 * A minimal view of the SQL symbol structure used by pgDriftCheck.
 * Matches the shape emitted by getCodeIndex for `kind === "table"` symbols
 * and their child `kind === "field"` symbols.
 */
export interface SqlSymbol {
  id: string;
  kind: string;
  name: string;
  parent?: string;
  signature?: string;
}

/**
 * Compare a live {@link PgIntrospectResult} against the migration-derived
 * schema stored in the code index for `repo`.
 *
 * Instead of calling `getCodeIndex` directly (which would import index-tools
 * and drag in the whole storage layer), callers inject the raw symbol array.
 * This keeps pgDriftCheck pure and easily testable.
 *
 * The SQL schema is reconstructed from `kind === "table"` symbols and their
 * `kind === "field"` children — the same shape that `analyzeSchemaDrift`
 * consumes internally. We do NOT call `analyzeSchemaDrift` (different concern:
 * that function compares ORM models vs SQL files, not live DB vs migrations).
 *
 * @param live   Result from {@link introspectPgSchema}.
 * @param symbols  `index.symbols` from `getCodeIndex(repo)`.
 * @returns {@link PgDriftResult} — never throws.
 */
export function pgDriftCheck(
  live: PgIntrospectResult,
  symbols: SqlSymbol[],
): PgDriftResult {
  // Build migration-schema view from SQL symbols ─────────────────────────────
  // Tables: kind === "table"; columns: kind === "field" with parent === table.id
  const migrationTables = new Map<
    string, // lowercase table name
    { id: string; columns: Map<string, string> } // lowercase col name → type
  >();

  for (const sym of symbols) {
    if (sym.kind !== "table") continue;
    migrationTables.set(sym.name.toLowerCase(), {
      id: sym.id,
      columns: new Map(),
    });
  }

  if (migrationTables.size === 0) {
    return {
      missing_tables_live_only: [],
      missing_tables_migrations_only: [],
      column_mismatches: [],
      note: "no migration-derived schema: no SQL table symbols found in index",
    };
  }

  for (const sym of symbols) {
    if (sym.kind !== "field" || !sym.parent) continue;
    // Find the parent table entry by matching the parent id against the id we stored
    for (const [, tbl] of migrationTables) {
      if (tbl.id === sym.parent) {
        tbl.columns.set(sym.name.toLowerCase(), sym.signature ?? "unknown");
        break;
      }
    }
  }

  // Build live-schema lookup ─────────────────────────────────────────────────
  const liveTables = new Map<string, Map<string, string>>();
  for (const tbl of live.tables) {
    const cols = new Map<string, string>();
    for (const col of tbl.columns) {
      cols.set(col.name.toLowerCase(), col.type);
    }
    liveTables.set(tbl.name.toLowerCase(), cols);
  }

  // Compare ──────────────────────────────────────────────────────────────────
  const missing_tables_live_only: string[] = [];
  const missing_tables_migrations_only: string[] = [];
  const column_mismatches: PgColumnMismatch[] = [];

  // Tables in live but not in migrations
  for (const [tableName] of liveTables) {
    if (!migrationTables.has(tableName)) {
      missing_tables_live_only.push(tableName);
    }
  }

  // Tables in migrations but not in live + column-level diff for shared tables
  for (const [tableName, migTbl] of migrationTables) {
    const liveCols = liveTables.get(tableName);
    if (!liveCols) {
      missing_tables_migrations_only.push(tableName);
      continue;
    }

    // Columns in migrations but missing in live
    for (const [colName, migType] of migTbl.columns) {
      if (!liveCols.has(colName)) {
        column_mismatches.push({
          table: tableName,
          column: colName,
          kind: "missing_live",
          migrations_type: migType,
        });
      } else {
        // Both sides have the column — check type compatibility
        const liveType = liveCols.get(colName)!;
        if (normalizeSimpleType(liveType) !== normalizeSimpleType(migType)) {
          column_mismatches.push({
            table: tableName,
            column: colName,
            kind: "type_mismatch",
            live_type: liveType,
            migrations_type: migType,
          });
        }
      }
    }

    // Columns in live but missing in migrations
    for (const [colName, liveType] of liveCols) {
      if (!migTbl.columns.has(colName)) {
        column_mismatches.push({
          table: tableName,
          column: colName,
          kind: "missing_migrations",
          live_type: liveType,
        });
      }
    }
  }

  return {
    missing_tables_live_only,
    missing_tables_migrations_only,
    column_mismatches,
  };
}

/**
 * Minimal type normalisation: strips modifiers like `NOT NULL`, `DEFAULT …`,
 * parenthesised sizes, and lowercases. Enough for gross-mismatch detection
 * (e.g. `integer` vs `text`) without false-positives from vendor decoration.
 */
function normalizeSimpleType(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*not\s+null/gi, "")
    .replace(/\s*default\s+\S+/gi, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
}
