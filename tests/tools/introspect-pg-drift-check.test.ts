/**
 * introspect_pg with drift_check=true, end to end over a REAL index.
 *
 * The handler reads migration-derived `table` and `field` symbols through the narrow reads
 * (ADR-004 stage 2) instead of materialising the index. The live database is the only thing
 * stubbed: `introspectPgSchema` returns a fixed catalog, and the real `pgDriftCheck` compares it
 * against what the index holds — so an empty symbol read would show up as every table being
 * "live only", not as a clean bill of health.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/tools/pg-introspect-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/pg-introspect-tools.js")>();
  return {
    ...actual,
    introspectPgSchema: vi.fn(async () => ({
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "integer", nullable: false },
            { name: "email", type: "text", nullable: false },
          ],
          primary_key: ["id"],
          indexes: [],
        },
        {
          name: "live_only",
          columns: [{ name: "id", type: "integer", nullable: false }],
          primary_key: ["id"],
          indexes: [],
        },
      ],
      relationships: [],
      warnings: [],
    })),
  };
});

import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { getToolDefinitions } from "../../src/register-tools.js";

describe("introspect_pg drift_check", () => {
  let DATA_DIR: string;
  let TMP: string;
  let repoName: string;

  beforeEach(async () => {
    DATA_DIR = join(tmpdir(), "codesift-pgdrift-data-" + process.hrtime.bigint());
    process.env["CODESIFT_DATA_DIR"] = DATA_DIR;
    process.env["CODESIFT_PG_CONN_STR"] = "postgres://stub@localhost/none";
    resetConfigCache();

    TMP = join(tmpdir(), "codesift-pgdrift-" + process.hrtime.bigint());
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "schema.sql"), `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  nickname TEXT
);

CREATE TABLE migrations_only (
  id INT PRIMARY KEY
);
`);
    const r = await indexFolder(TMP, { watch: false });
    repoName = r.repo;
  }, 30_000);

  afterEach(() => {
    delete process.env["CODESIFT_DATA_DIR"];
    delete process.env["CODESIFT_PG_CONN_STR"];
    resetConfigCache();
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  async function runHandler(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const def = getToolDefinitions().find((d) => d.name === "introspect_pg");
    expect(def).toBeDefined();
    return (await def!.handler(args)) as Record<string, unknown>;
  }

  it("compares the live catalog against table and field symbols read from the index", async () => {
    const result = await runHandler({ drift_check: true, repo: repoName });
    const drift = result["drift"] as {
      missing_tables_live_only: string[];
      missing_tables_migrations_only: string[];
      column_mismatches: Array<{ table: string; column: string }>;
      note?: string;
    };
    expect(drift.note).toBeUndefined();
    expect(drift.missing_tables_live_only).toEqual(["live_only"]);
    expect(drift.missing_tables_migrations_only).toEqual(["migrations_only"]);
    // `nickname` exists only in the migration — it can be reported only if the field symbols
    // were actually read and attached to their table.
    expect(drift.column_mismatches.some((m) => m.table === "users" && m.column === "nickname")).toBe(true);
  });

  it("keeps the not-indexed error for an unknown repo", async () => {
    const result = await runHandler({ drift_check: true, repo: "local/does-not-exist-pgdrift" });
    expect(result["error"]).toBe(
      "drift_check: repo 'local/does-not-exist-pgdrift' is not indexed — cannot load migration-derived schema symbols",
    );
  });
});
