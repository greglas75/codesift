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
