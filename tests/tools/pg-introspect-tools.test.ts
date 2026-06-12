/**
 * Tests for pg-introspect-tools — Task 8 (RED → GREEN).
 *
 * pg is NOT installed in this repo, so the real dynamic import("pg") also
 * rejects — no mock is needed to exercise the failure path; one test
 * documents that the real import failure produces the structured error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadPgClient } from "../../src/tools/pg-introspect-tools.js";
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
