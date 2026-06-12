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
  redactConnStr,
  type PgClientLike,
  type PgIntrospectResult,
  type PgIntrospectError,
} from "../../src/tools/pg-introspect-tools.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";

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

    expect(serialized).toContain("[REDACTED]");
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

  it("is a no-op-safe pass-through for empty conn string", () => {
    expect(redactConnStr("nothing to hide here", "")).toBe("nothing to hide here");
  });
});
