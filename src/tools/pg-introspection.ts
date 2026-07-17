/**
 * PostgreSQL introspection tools.
 * `pg` is an optional dependency — all imports are dynamic so the module
 * loads cleanly even when `pg` is not installed.
 */
import { buildRelationships, buildTables } from "./pg-introspect-formatters.js";

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
const MAX_TIMEOUT_MS = 60_000;
const MAX_CATALOG_ROWS = 100_000;

const COLUMNS_SQL = `
  SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = $1
  ORDER BY table_name, ordinal_position
  LIMIT 100001`;

const PK_SQL = `
  SELECT kcu.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = $1
  ORDER BY kcu.table_name, kcu.ordinal_position
  LIMIT 100001`;

const INDEX_SQL = `
  SELECT tablename AS table_name, indexname AS index_name
  FROM pg_catalog.pg_indexes
  WHERE schemaname = $1
  ORDER BY tablename, indexname
  LIMIT 100001`;

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
  ORDER BY kcu.table_name, kcu.column_name
  LIMIT 100001`;

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
        try {
          out = out.split(decodeURIComponent(url.password)).join("[REDACTED]");
        } catch {
          // Keep the encoded-token redaction above when decoding is malformed.
        }
      }
      // Also scrub a bare user:pass@ authority fragment if present in text.
      if (url.username && url.password) {
        out = out.split(`${url.username}:${url.password}`).join("[REDACTED]");
      }
    } catch {
      // Non-URL conn string (e.g. libpq keyword form). Best-effort: pull a
      // password=... token out and scrub its value.
      const password = extractLibpqPassword(connStr);
      if (password) out = out.split(password).join("[REDACTED]");
    }
  }
  return out;
}

function extractLibpqPassword(connStr: string): string | undefined {
  const match = /password\s*=\s*/i.exec(connStr);
  if (!match) return undefined;
  let index = match.index + match[0].length;
  const quote = connStr[index] === "'" || connStr[index] === '"' ? connStr[index++] : undefined;
  let value = "";
  while (index < connStr.length) {
    const char = connStr[index++];
    if (char === "\\" && index < connStr.length) value += connStr[index++];
    else if (quote ? char === quote : /\s/.test(char ?? "")) break;
    else value += char;
  }
  return value || undefined;
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
  const prepared = await prepareIntrospection(connStr, opts);
  if ("error" in prepared) return prepared;
  return runWithTimeout(prepared.client, connStr, prepared.schema, prepared.timeoutMs);
}

async function prepareIntrospection(
  connStr: string,
  opts: IntrospectPgOptions,
): Promise<{ client: PgClientLike; schema: string; timeoutMs: number } | PgIntrospectError> {
  const validated = validateOptions(connStr, opts);
  if ("error" in validated) return validated;
  let ClientCtor = opts._clientCtor;
  if (!ClientCtor) {
    const loaded = await loadPgClient();
    if ("error" in loaded) return { error: loaded.error };
    ClientCtor = loaded.ClientCtor;
  }
  return createClient(ClientCtor, connStr, validated.schema, validated.timeoutMs);
}

function validateOptions(
  connStr: string,
  opts: IntrospectPgOptions,
): { schema: string; timeoutMs: number } | PgIntrospectError {
  if (typeof connStr !== "string" || connStr.trim() === "") {
    return { error: "connStr is required and must be a non-empty string" };
  }
  const schema = opts.schema && opts.schema.trim() !== "" ? opts.schema : "public";
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(schema)) {
    return { error: "schema must be a valid PostgreSQL identifier" };
  }
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  return { schema, timeoutMs };
}

function createClient(
  ClientCtor: PgClientCtor["ClientCtor"], connStr: string,
  schema: string, timeoutMs: number,
) {
  try {
    const client = new ClientCtor({
      connectionString: connStr,
      connectionTimeoutMillis: STATEMENT_TIMEOUT_MS,
    });
    return { client, schema, timeoutMs };
  } catch (err) {
    redactError(err, connStr);
    return { error: "PostgreSQL introspection failed" };
  }
}

async function runWithTimeout(
  client: PgClientLike,
  connStr: string,
  schema: string,
  timeoutMs: number,
): Promise<PgIntrospectResult | PgIntrospectError> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutError = new Error("pg introspection timed out");
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });
  const introspectionPromise = runIntrospection(client, connStr, schema);
  try {
    return await Promise.race([introspectionPromise, timeout]);
  } catch (err) {
    redactError(err, connStr);
    if (err === timeoutError) return { error: "pg introspection timed out" };
    return { error: "PostgreSQL introspection failed" };
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      introspectionPromise.catch(() => undefined);
      await settleCleanup(client);
    }
  }
}

async function settleCleanup(client: PgClientLike): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 100);
  });
  await Promise.race([closeClient(client), deadline]);
  if (timer) clearTimeout(timer);
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

    return await queryCatalog(client, schema);
  } catch (err) {
    // Redact before the error escapes runIntrospection so the caller's catch
    // (and the timeout race) never sees raw connection material.
    throw new Error(redactError(err, connStr));
  } finally {
    // Always close — connect-success, query-failure, or connect-failure paths.
    // end() itself may throw; swallow + redact so cleanup never leaks secrets.
    await closeClient(client);
  }
}

async function queryCatalog(client: PgClientLike, schema: string): Promise<PgIntrospectResult> {
  const results = await Promise.all([
    client.query(COLUMNS_SQL, [schema]), client.query(PK_SQL, [schema]),
    client.query(INDEX_SQL, [schema]), client.query(FK_SQL, [schema]),
  ]);
  if (results.some(({ rows }) => rows.length > MAX_CATALOG_ROWS)) {
    throw new Error(`pg introspection exceeded ${MAX_CATALOG_ROWS} catalog rows`);
  }
  const [columns, primaryKeys, indexes, foreignKeys] = results;
  if (!columns || !primaryKeys || !indexes || !foreignKeys) {
    throw new Error("PostgreSQL catalog query returned an incomplete result set");
  }
  return {
    tables: buildTables(columns.rows, primaryKeys.rows, indexes.rows),
    relationships: buildRelationships(foreignKeys.rows), warnings: [],
  };
}

const closePromises = new WeakMap<PgClientLike, Promise<void>>();
function closeClient(client: PgClientLike): Promise<void> {
  const existing = closePromises.get(client);
  if (existing) return existing;
  try {
    const closing = client.end().catch(() => undefined);
    closePromises.set(client, closing);
    return closing;
  } catch {
    const completed = Promise.resolve();
    closePromises.set(client, completed);
    return completed;
  }
}
