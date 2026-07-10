/** Public compatibility facade for PostgreSQL introspection and drift tools. */
export {
  introspectPgSchema,
  loadPgClient,
  redactConnStr,
} from "./pg-introspection.js";
export type {
  IntrospectPgOptions,
  PgClientCtor,
  PgClientLike,
  PgColumn,
  PgIntrospectError,
  PgIntrospectResult,
  PgLoadError,
  PgRelationship,
  PgTableInfo,
} from "./pg-introspection.js";
export { pgDriftCheck } from "./pg-drift.js";
export type { PgColumnMismatch, PgDriftResult, SqlSymbol } from "./pg-drift.js";
