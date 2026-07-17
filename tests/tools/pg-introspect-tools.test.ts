/**
 * Tests for pg-introspect-tools — Task 8 (RED → GREEN).
 *
 * pg is NOT installed in this repo, so the real dynamic import("pg") also
 * rejects — no mock is needed to exercise the failure path; one test
 * documents that the real import failure produces the structured error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadPgClient,
  introspectPgSchema,
  pgDriftCheck,
  redactConnStr,
  type PgClientLike,
  type PgIntrospectResult,
  type PgIntrospectError,
  type SqlSymbol,
} from "../../src/tools/pg-introspect-tools.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";
import { TOOL_ARG_FIELDS } from "../../src/storage/usage-tracker.js";

// ---------------------------------------------------------------------------
// loadPgClient — optional-dep loading
// ---------------------------------------------------------------------------

describe("loadPgClient", () => {
  it("returns structured error when pg is not installed (real import path — no mock needed)", async () => {
    // pg is absent from node_modules in this repo, so import("pg") rejects
    // with MODULE_NOT_FOUND. The function must catch that and return an object.
    const result = await loadPgClient();
    // Must not throw — result is always an object.
    expect(result).toBeTypeOf("object");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("pg not installed");
  });

  it("returns structured error (mocked import failure variant)", async () => {
    // Explicit vi.mock variant for completeness — confirms the catch branch
    // fires for any import rejection, not just MODULE_NOT_FOUND.
    vi.mock("pg", () => {
      throw new Error("Cannot find module");
    });
    const { loadPgClient: loadPgClientFresh } = await import(
      "../../src/tools/pg-introspect-tools.js?mock=1"
    ).catch(() => import("../../src/tools/pg-introspect-tools.js"));
    const result = await loadPgClientFresh();
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("pg not installed");
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Config — CODESIFT_PG_CONN_STR
// ---------------------------------------------------------------------------

describe("loadConfig() — pgConnStr", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["CODESIFT_PG_CONN_STR"];
    delete process.env["CODESIFT_PG_CONN_STR"];
    resetConfigCache();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env["CODESIFT_PG_CONN_STR"];
    } else {
      process.env["CODESIFT_PG_CONN_STR"] = savedEnv;
    }
    resetConfigCache();
  });

  it("pgConnStr is null when CODESIFT_PG_CONN_STR is not set", () => {
    const cfg = loadConfig();
    expect(cfg.pgConnStr).toBeNull();
  });

  it("pgConnStr equals CODESIFT_PG_CONN_STR when set", () => {
    const connStr = "postgresql://user:pass@localhost:5432/mydb";
    process.env["CODESIFT_PG_CONN_STR"] = connStr;
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.pgConnStr).toBe(connStr);
  });
});

// ---------------------------------------------------------------------------
// Task 9 — introspectPgSchema
// ---------------------------------------------------------------------------
//
// pg is NOT installed in this repo, and loadPgClient's dynamic import("pg") uses
// a runtime string specifier with @vite-ignore which BYPASSES vitest module
// mocking entirely (vi.mock("pg") cannot intercept it). So we drive a fully
// vi.fn-controlled Client class through the production code path via the
// `_clientCtor` injection seam. The class still satisfies the spec's intent:
// connect/query/end are vi.fn controlled per test, asserted for call order and
// counts. We track the LAST constructed instance via a module-scoped ref.

interface MockClientHandle {
  ctor: new (cfg: { connectionString: string; connectionTimeoutMillis: number }) => PgClientLike;
  /** Resolves to the most recently constructed instance. */
  last: () => MockClientInstance;
  /** All constructor configs seen, in order. */
  configs: Array<{ connectionString: string; connectionTimeoutMillis: number }>;
}

interface MockClientInstance {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

/**
 * Build a vi.fn-controlled Client class. `behavior` wires the three methods;
 * each is a vi.fn so call counts/order are assertable. query is given a default
 * resolver that returns `{ rows: [] }` so SET statement_timeout etc. resolve
 * unless the test overrides.
 */
function makeMockClient(behavior: {
  connect?: () => Promise<void>;
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<void>;
}): MockClientHandle {
  const instances: MockClientInstance[] = [];
  const configs: Array<{ connectionString: string; connectionTimeoutMillis: number }> = [];

  class MockClient implements PgClientLike {
    connect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    constructor(cfg: { connectionString: string; connectionTimeoutMillis: number }) {
      configs.push(cfg);
      this.connect = vi.fn(behavior.connect ?? (() => Promise.resolve()));
      this.query = vi.fn(behavior.query ?? (() => Promise.resolve({ rows: [] })));
      this.end = vi.fn(behavior.end ?? (() => Promise.resolve()));
      instances.push(this as unknown as MockClientInstance);
    }
  }

  return {
    ctor: MockClient as unknown as MockClientHandle["ctor"],
    last: () => {
      const inst = instances[instances.length - 1];
      if (!inst) throw new Error("no MockClient was constructed");
      return inst;
    },
    configs,
  };
}

/** A query router keyed by a substring of the SQL — keeps fixtures readable. */
function routeQuery(
  routes: Array<{ match: string; rows: Record<string, unknown>[] }>,
): (sql: string) => Promise<{ rows: Record<string, unknown>[] }> {
  return (sql: string) => {
    for (const r of routes) {
      if (sql.includes(r.match)) return Promise.resolve({ rows: r.rows });
    }
    return Promise.resolve({ rows: [] });
  };
}

describe("introspectPgSchema", () => {
  const CONN = "postgres://user:secret@host:5432/db";

  it("contains and redacts errors thrown by the Client constructor", async () => {
    class ThrowingClient {
      constructor() { throw new Error(`constructor rejected ${CONN}`); }
    }
    const result = await introspectPgSchema(CONN, {
      _clientCtor: ThrowingClient as unknown as PgClientCtor["ClientCtor"],
    });
    expect(result).toEqual({ error: "PostgreSQL introspection failed" });
  });

  it("returns after the wall timeout even when cleanup never settles", async () => {
    vi.useFakeTimers();
    try {
      const handle = makeMockClient({
        query: (sql) => sql.includes("SET statement_timeout")
          ? Promise.resolve({ rows: [] })
          : new Promise(() => undefined),
        end: () => new Promise(() => undefined),
      });
      const promise = introspectPgSchema(CONN, { _clientCtor: handle.ctor, timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(111);
      await expect(promise).resolves.toMatchObject({ error: expect.stringMatching(/timed out/i) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps fixture rows for 3 tables + 2 FKs + indexes into TableInfo[]/Relationship[]", async () => {
    const handle = makeMockClient({
      query: routeQuery([
        {
          match: "information_schema.columns",
          rows: [
            { table_name: "users", column_name: "id", data_type: "integer", is_nullable: "NO" },
            { table_name: "users", column_name: "email", data_type: "text", is_nullable: "YES" },
            { table_name: "posts", column_name: "id", data_type: "integer", is_nullable: "NO" },
            { table_name: "posts", column_name: "author_id", data_type: "integer", is_nullable: "NO" },
            { table_name: "tags", column_name: "id", data_type: "integer", is_nullable: "NO" },
            { table_name: "tags", column_name: "post_id", data_type: "integer", is_nullable: "YES" },
          ],
        },
        {
          // table_constraints joined with key_column_usage for PRIMARY KEY
          match: "PRIMARY KEY",
          rows: [
            { table_name: "users", column_name: "id" },
            { table_name: "posts", column_name: "id" },
            { table_name: "tags", column_name: "id" },
          ],
        },
        {
          match: "pg_catalog.pg_indexes",
          rows: [
            { table_name: "users", index_name: "users_pkey" },
            { table_name: "users", index_name: "users_email_idx" },
            { table_name: "posts", index_name: "posts_pkey" },
            { table_name: "tags", index_name: "tags_pkey" },
          ],
        },
        {
          match: "referential_constraints",
          rows: [
            { from_table: "posts", from_column: "author_id", to_table: "users", to_column: "id" },
            { from_table: "tags", from_column: "post_id", to_table: "posts", to_column: "id" },
          ],
        },
      ]),
    });

    const result = (await introspectPgSchema(CONN, {
      _clientCtor: handle.ctor,
    })) as PgIntrospectResult;

    expect(result).toEqual({
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "integer", nullable: false },
            { name: "email", type: "text", nullable: true },
          ],
          primary_key: ["id"],
          indexes: ["users_pkey", "users_email_idx"],
        },
        {
          name: "posts",
          columns: [
            { name: "id", type: "integer", nullable: false },
            { name: "author_id", type: "integer", nullable: false },
          ],
          primary_key: ["id"],
          indexes: ["posts_pkey"],
        },
        {
          name: "tags",
          columns: [
            { name: "id", type: "integer", nullable: false },
            { name: "post_id", type: "integer", nullable: true },
          ],
          primary_key: ["id"],
          indexes: ["tags_pkey"],
        },
      ],
      relationships: [
        { from_table: "posts", from_column: "author_id", to_table: "users", to_column: "id" },
        { from_table: "tags", from_column: "post_id", to_table: "posts", to_column: "id" },
      ],
      warnings: [],
    });
  });

  it("empty information_schema → { tables: [], relationships: [], warnings: [] } and does not throw", async () => {
    const handle = makeMockClient({}); // default query resolver returns { rows: [] }
    const result = await introspectPgSchema(CONN, { _clientCtor: handle.ctor });
    expect(result).toEqual({ tables: [], relationships: [], warnings: [] });
  });

  it("connect() rejection with conn string in message → serialized result contains [REDACTED], never the secret", async () => {
    const handle = makeMockClient({
      connect: () =>
        Promise.reject(new Error(`auth failed for ${CONN}`)),
    });

    const result = (await introspectPgSchema(CONN, {
      _clientCtor: handle.ctor,
    })) as PgIntrospectError;

    // Serialize EVERYTHING we control about the failure: the returned object,
    // plus the error's message and any stack-adjacent string fields. The whole
    // serialized form must be scrubbed.
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("PostgreSQL introspection failed");
    // Negative assertion: no part of the connection string survives.
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain(CONN);
    expect(serialized).not.toContain("user:secret");
    expect(serialized).not.toContain("host:5432");
  });

  it("calls client.end() exactly once on success", async () => {
    const handle = makeMockClient({});
    await introspectPgSchema(CONN, { _clientCtor: handle.ctor });
    expect(handle.last().end).toHaveBeenCalledTimes(1);
  });

  it("calls client.end() exactly once on query failure", async () => {
    const handle = makeMockClient({
      query: (sql: string) => {
        if (sql.includes("information_schema.columns")) {
          return Promise.reject(new Error(`query boom for ${CONN}`));
        }
        return Promise.resolve({ rows: [] });
      },
    });
    const result = (await introspectPgSchema(CONN, {
      _clientCtor: handle.ctor,
    })) as PgIntrospectError;
    expect(handle.last().end).toHaveBeenCalledTimes(1);
    // And still redacted.
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("calls client.end() exactly once on connect failure (after construction)", async () => {
    const handle = makeMockClient({
      connect: () => Promise.reject(new Error("connect refused")),
    });
    await introspectPgSchema(CONN, { _clientCtor: handle.ctor });
    expect(handle.last().end).toHaveBeenCalledTimes(1);
  });

  it("issues `SET statement_timeout = 5000` as the FIRST query after connect", async () => {
    const handle = makeMockClient({});
    await introspectPgSchema(CONN, { _clientCtor: handle.ctor });
    const inst = handle.last();
    // connect must have been called before any query.
    expect(inst.connect).toHaveBeenCalledTimes(1);
    expect(inst.query).toHaveBeenCalled();
    const firstQuerySql = inst.query.mock.calls[0]?.[0] as string;
    expect(firstQuerySql).toContain("SET statement_timeout = 5000");
    // Ordering: connect resolved, then SET was the first query argument seen.
    const connectOrder = inst.connect.mock.invocationCallOrder[0]!;
    const firstQueryOrder = inst.query.mock.invocationCallOrder[0]!;
    expect(connectOrder).toBeLessThan(firstQueryOrder);
  });

  it("whole-call timeout: a hanging query rejects with a redacted timeout error and still calls end()", async () => {
    vi.useFakeTimers();
    try {
      // Control when the hung query rejects so we can trigger it after the race
      // resolves and verify no unhandledRejection fires.
      let rejectHungQuery!: (err: unknown) => void;
      const hungQueryPromise = new Promise<{ rows: Record<string, unknown>[] }>(
        (_resolve, reject) => {
          rejectHungQuery = reject;
        },
      );

      const handle = makeMockClient({
        query: (sql: string) => {
          // SET statement_timeout resolves immediately; the data query hangs.
          if (sql.includes("SET statement_timeout")) return Promise.resolve({ rows: [] });
          return hungQueryPromise;
        },
      });

      const promise = introspectPgSchema(CONN, { _clientCtor: handle.ctor, timeoutMs: 10_000 });
      // Advance past the 10s wall-clock cap.
      await vi.advanceTimersByTimeAsync(10_001);
      const result = (await promise) as PgIntrospectError;

      expect(result).toHaveProperty("error");
      expect(result.error.toLowerCase()).toContain("timed out");
      // end() must still fire (finally semantics) and nothing leaks.
      expect(handle.last().end).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("secret");

      // ── Orphan-rejection guard ───────────────────────────────────────────
      // After the race resolved (timeout path), simulate the hung query
      // rejecting late — as happens when client.end() destroys the socket.
      // Assert that NO unhandledRejection event fires (the .catch swallow must
      // have been attached before we get here).
      const unhandledSpy = vi.fn();
      process.on("unhandledRejection", unhandledSpy);
      try {
        rejectHungQuery(new Error("socket destroyed after client.end()"));
        // Flush microtasks so any rejection propagates synchronously.
        await Promise.resolve();
        await Promise.resolve();
        expect(unhandledSpy).not.toHaveBeenCalled();
      } finally {
        process.removeListener("unhandledRejection", unhandledSpy);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("empty connStr → structured validation error before any Client construction", async () => {
    const handle = makeMockClient({});
    const result = (await introspectPgSchema("", {
      _clientCtor: handle.ctor,
    })) as PgIntrospectError;
    expect(result).toHaveProperty("error");
    expect(result.error.toLowerCase()).toContain("required");
    // No Client was ever constructed.
    expect(handle.configs).toHaveLength(0);
  });

  it("whitespace-only connStr is also rejected before construction", async () => {
    const handle = makeMockClient({});
    const result = (await introspectPgSchema("   ", {
      _clientCtor: handle.ctor,
    })) as PgIntrospectError;
    expect(result).toHaveProperty("error");
    expect(handle.configs).toHaveLength(0);
  });
});

describe("redactConnStr", () => {
  it("redacts the full connection string", () => {
    const conn = "postgres://user:secret@host:5432/db";
    const out = redactConnStr(`failed to connect to ${conn} aborting`, conn);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("secret");
    expect(out).not.toContain(conn);
  });

  it("redacts a bare password component echoed without the full URL", () => {
    // A well-formed conn string percent-encodes special chars in the password.
    const conn = "postgres://admin:s3cretPass@db.internal:5432/app";
    // A driver might echo only the password token, not the whole URL.
    const out = redactConnStr(`password "s3cretPass" rejected`, conn);
    expect(out).not.toContain("s3cretPass");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts decoded URL passwords and quoted libpq passwords", () => {
    expect(redactConnStr("password p@ss rejected", "postgres://u:p%40ss@host/db"))
      .toBe("password [REDACTED] rejected");
    expect(redactConnStr("bad two words", "host=db password='two words' user=u"))
      .toBe("bad [REDACTED]");
    expect(redactConnStr("bad a'b", "host=db password='a\\'b' user=u"))
      .toBe("bad [REDACTED]");
  });

  it("is a no-op-safe pass-through for empty conn string", () => {
    expect(redactConnStr("nothing to hide here", "")).toBe("nothing to hide here");
  });

  it("redacts password values from libpq keyword connection strings", () => {
    const conn = "host=db.internal user=admin password=keywordSecret dbname=app";
    expect(redactConnStr("password keywordSecret rejected", conn)).toBe(
      "password [REDACTED] rejected",
    );
  });
});

// ---------------------------------------------------------------------------
// Task 10 — pgDriftCheck
// ---------------------------------------------------------------------------

/**
 * Build a minimal SqlSymbol fixture. We use the id convention
 * "local/repo:migrations/001.sql:tableName:1" to match what getCodeIndex
 * would return; pgDriftCheck only needs id, kind, name, parent, signature.
 */
function makeTableSymbol(name: string, id?: string): SqlSymbol {
  return {
    id: id ?? `repo:migrations/001.sql:${name}:1`,
    kind: "table",
    name,
  };
}

function makeFieldSymbol(name: string, parentId: string, type: string): SqlSymbol {
  return {
    id: `repo:migrations/001.sql:${parentId}__${name}:2`,
    kind: "field",
    name,
    parent: parentId,
    signature: type,
  };
}

describe("pgDriftCheck", () => {
  const usersId = "repo:migrations/001.sql:users:1";
  const postsId = "repo:migrations/001.sql:posts:1";

  const baseSymbols: SqlSymbol[] = [
    makeTableSymbol("users", usersId),
    makeFieldSymbol("id", usersId, "integer"),
    makeFieldSymbol("email", usersId, "text"),
    makeTableSymbol("posts", postsId),
    makeFieldSymbol("id", postsId, "integer"),
    makeFieldSymbol("title", postsId, "text"),
  ];

  const baseLive: PgIntrospectResult = {
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", type: "integer", nullable: false },
          { name: "email", type: "text", nullable: true },
        ],
        primary_key: ["id"],
        indexes: [],
      },
      {
        name: "posts",
        columns: [
          { name: "id", type: "integer", nullable: false },
          { name: "title", type: "text", nullable: false },
        ],
        primary_key: ["id"],
        indexes: [],
      },
    ],
    relationships: [],
    warnings: [],
  };

  it("clean match → empty drift arrays (no missing tables, no column mismatches)", () => {
    const result = pgDriftCheck(baseLive, baseSymbols);
    expect(result.missing_tables_live_only).toHaveLength(0);
    expect(result.missing_tables_migrations_only).toHaveLength(0);
    expect(result.column_mismatches).toHaveLength(0);
    expect(result.note).toBeUndefined();
  });

  it("live-only table reported in missing_tables_live_only", () => {
    // Add a table to live that has no symbol in migrations
    const liveWithExtra: PgIntrospectResult = {
      ...baseLive,
      tables: [
        ...baseLive.tables,
        {
          name: "audit_log",
          columns: [{ name: "id", type: "bigint", nullable: false }],
          primary_key: ["id"],
          indexes: [],
        },
      ],
    };
    const result = pgDriftCheck(liveWithExtra, baseSymbols);
    expect(result.missing_tables_live_only).toContain("audit_log");
    expect(result.missing_tables_migrations_only).toHaveLength(0);
  });

  it("reports migration-only tables and live-only columns", () => {
    const symbols = [
      ...baseSymbols,
      makeTableSymbol("archived", "repo:migrations/002.sql:archived:1"),
    ];
    const live = {
      ...baseLive,
      tables: baseLive.tables.map((table) => table.name === "users"
        ? { ...table, columns: [...table.columns, { name: "legacy", type: "text", nullable: true }] }
        : table),
    };
    const result = pgDriftCheck(live, symbols);
    expect(result.missing_tables_migrations_only).toContain("archived");
    expect(result.column_mismatches).toContainEqual({
      table: "users", column: "legacy", kind: "missing_migrations", live_type: "text",
    });
  });

  it("treats SQL type modifiers as formatting-equivalent", () => {
    const id = "repo:migrations/001.sql:users:1";
    const symbols = [makeTableSymbol("users", id), makeFieldSymbol("id", id, "integer NOT NULL")];
    const live = { ...baseLive, tables: [baseLive.tables[0]!] };
    expect(pgDriftCheck(live, symbols).column_mismatches).toEqual([
      { table: "users", column: "email", kind: "missing_migrations", live_type: "text" },
    ]);
  });

  it("migration-only column reported as missing_live in column_mismatches", () => {
    // Migrations have a column that doesn't exist in live
    const usersIdExtra = "repo:migrations/001.sql:users_extra:1";
    const symbolsWithExtraCol: SqlSymbol[] = [
      makeTableSymbol("users", usersIdExtra),
      makeFieldSymbol("id", usersIdExtra, "integer"),
      makeFieldSymbol("email", usersIdExtra, "text"),
      makeFieldSymbol("deleted_at", usersIdExtra, "timestamp"), // only in migrations
    ];
    const liveUsersOnly: PgIntrospectResult = {
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "integer", nullable: false },
            { name: "email", type: "text", nullable: true },
          ],
          primary_key: ["id"],
          indexes: [],
        },
      ],
      relationships: [],
      warnings: [],
    };
    const result = pgDriftCheck(liveUsersOnly, symbolsWithExtraCol);
    const mismatch = result.column_mismatches.find(
      (m) => m.column === "deleted_at" && m.kind === "missing_live",
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.migrations_type).toMatch(/timestamp/i);
  });

  it("type mismatch between live and migrations reported in column_mismatches", () => {
    // Live has 'email' as varchar(255), migrations say 'text'
    const liveTypeMismatch: PgIntrospectResult = {
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "integer", nullable: false },
            { name: "email", type: "varchar", nullable: true }, // different from "text"
          ],
          primary_key: ["id"],
          indexes: [],
        },
      ],
      relationships: [],
      warnings: [],
    };
    const usersIdMismatch = "repo:migrations/001.sql:users_mismatch:1";
    const symbolsMismatch: SqlSymbol[] = [
      makeTableSymbol("users", usersIdMismatch),
      makeFieldSymbol("id", usersIdMismatch, "integer"),
      makeFieldSymbol("email", usersIdMismatch, "text"),
    ];
    const result = pgDriftCheck(liveTypeMismatch, symbolsMismatch);
    const mismatch = result.column_mismatches.find(
      (m) => m.table === "users" && m.column === "email" && m.kind === "type_mismatch",
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.live_type).toBe("varchar");
    expect(mismatch!.migrations_type).toBe("text");
  });

  it("repo without SQL symbols → result with note 'no migration-derived schema', no throw", () => {
    const result = pgDriftCheck(baseLive, []); // no symbols at all
    expect(result).not.toBeUndefined();
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/no migration-derived schema/i);
    expect(result.missing_tables_live_only).toHaveLength(0);
    expect(result.missing_tables_migrations_only).toHaveLength(0);
    expect(result.column_mismatches).toHaveLength(0);
  });

  it("repo with only non-table SQL symbols returns note (no tables found)", () => {
    // Symbols present but none are kind=table
    const nonTableSymbols: SqlSymbol[] = [
      { id: "repo:f.sql:some_view:1", kind: "field", name: "some_view" },
    ];
    const result = pgDriftCheck(baseLive, nonTableSymbols);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/no migration-derived schema/i);
  });
});

// ---------------------------------------------------------------------------
// Task 10 — introspect_pg registration
// ---------------------------------------------------------------------------

describe("introspect_pg registration", () => {
  it("tool exists in TOOL_DEFINITIONS with name 'introspect_pg'", async () => {
    const { getToolDefinitions } = await import("../../src/register-tools.js");
    const defs = getToolDefinitions();
    const def = defs.find((d) => d.name === "introspect_pg");
    expect(def, "introspect_pg must be in TOOL_DEFINITIONS").toBeDefined();
  });

  it("schema keys are exactly a subset of {schema, drift_check, repo} — no conn_str/connection arg", async () => {
    const { getToolDefinitions } = await import("../../src/register-tools.js");
    const defs = getToolDefinitions();
    const def = defs.find((d) => d.name === "introspect_pg")!;
    const allowed = new Set(["schema", "drift_check", "repo"]);
    const keys = Object.keys(def.schema);
    // Every key must be in the allowed set
    for (const key of keys) {
      expect(allowed.has(key), `Unexpected schema key: '${key}' — conn_str must never be in schema`).toBe(true);
    }
    // Explicitly assert forbidden keys are absent
    expect(keys).not.toContain("conn_str");
    expect(keys).not.toContain("connection");
    expect(keys).not.toContain("connection_string");
    expect(keys).not.toContain("connStr");
  });

  it("handler with CODESIFT_PG_CONN_STR unset returns structured error mentioning CODESIFT_PG_CONN_STR", async () => {
    const { getToolDefinitions } = await import("../../src/register-tools.js");
    const defs = getToolDefinitions();
    const def = defs.find((d) => d.name === "introspect_pg")!;
    const savedEnv = process.env["CODESIFT_PG_CONN_STR"];
    delete process.env["CODESIFT_PG_CONN_STR"];
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
    try {
      const result = await def.handler({}) as { error: string };
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("CODESIFT_PG_CONN_STR");
    } finally {
      if (savedEnv !== undefined) process.env["CODESIFT_PG_CONN_STR"] = savedEnv;
      else delete process.env["CODESIFT_PG_CONN_STR"];
      resetConfigCache();
    }
  });

  it("introspect_pg is NOT in CORE_TOOL_NAMES (it is hidden/discoverable)", async () => {
    const { CORE_TOOL_NAMES } = await import("../../src/register-tools.js");
    expect(CORE_TOOL_NAMES.has("introspect_pg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 10 — telemetry safety
// ---------------------------------------------------------------------------

describe("usage-tracker telemetry safety", () => {
  it("TOOL_ARG_FIELDS has no 'introspect_pg' key (pg args never captured in telemetry)", () => {
    // Verifies that no conn_str / schema / drift_check fields are wired into
    // the arg-capture table — if introspect_pg were added, it would risk
    // accidentally logging a connection string.
    expect(Object.prototype.hasOwnProperty.call(TOOL_ARG_FIELDS, "introspect_pg")).toBe(false);
  });
});
