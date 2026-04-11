/**
 * Tests for migration_lint (src/tools/migration-lint-tools.ts).
 *
 * Mocks getCodeIndex and node:child_process.execFile so we can simulate:
 *   - squawk not installed (ENOENT)
 *   - squawk happy path with parsed JSON output
 *   - squawk exiting non-zero when findings exist
 *   - option pass-through (excluded_rules, pg_version)
 *   - multi-layout migration file discovery
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { migrationLint } from "../../src/tools/migration-lint-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { execFile } from "node:child_process";
import type { CodeIndex, FileEntry } from "../../src/types.js";

const mockGetCodeIndex = vi.mocked(getCodeIndex);
const mockExecFile = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string): FileEntry {
  return {
    path,
    language: "sql",
    symbol_count: 0,
    last_modified: 0,
  };
}

function makeIndex(files: string[], root = "/repo"): CodeIndex {
  return {
    repo: "test",
    root,
    symbols: [],
    files: files.map(makeFile),
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: files.length,
  };
}

/**
 * Program the execFile mock. Each call to execFile consumes one entry from
 * `responses`. An entry is either:
 *   - { stdout, stderr }  → success
 *   - { error }           → callback(error)
 *   - { error, stdout }   → callback(error, stdout)  (non-zero exit + output)
 */
type ExecResponse =
  | { stdout: string; stderr?: string }
  | { error: NodeJS.ErrnoException; stdout?: string; stderr?: string };

function programExecFile(responses: ExecResponse[]): void {
  let call = 0;
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (
        err: NodeJS.ErrnoException | null,
        stdout: string,
        stderr: string,
      ) => void;
      const resp = responses[call++];
      if (!resp) {
        callback(new Error(`unexpected execFile call #${call}`) as NodeJS.ErrnoException, "", "");
        return {} as never;
      }
      if ("error" in resp) {
        callback(resp.error, resp.stdout ?? "", resp.stderr ?? "");
      } else {
        callback(null, resp.stdout, resp.stderr ?? "");
      }
      return {} as never;
    },
  );
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error("spawn squawk ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrationLint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when repo is missing from index", async () => {
    mockGetCodeIndex.mockResolvedValue(null);
    await expect(migrationLint("ghost")).rejects.toThrow(/not found/);
  });

  it("returns empty result when no migration files match", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex(["src/app.ts", "README.md"]));
    const result = await migrationLint("test");

    expect(result.files_checked).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.squawk_installed).toBe(true);
    expect(result.by_severity).toEqual({ error: 0, warning: 0 });
    expect(result.by_rule).toEqual({});
    // execFile should not be called when there are no migrations to lint
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns install_hint (no throw) when squawk binary is missing", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex(["prisma/migrations/20240101_init/migration.sql"]),
    );
    programExecFile([{ error: enoent() }]);

    const result = await migrationLint("test");

    expect(result.squawk_installed).toBe(false);
    expect(result.install_hint).toMatch(/squawk not found/);
    expect(result.install_hint).toMatch(/brew install squawk/);
    expect(result.files_checked).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("parses JSON array output and aggregates by severity + rule", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex(
        [
          "prisma/migrations/20240101_init/migration.sql",
          "prisma/migrations/20240102_next/migration.sql",
        ],
        "/repo",
      ),
    );

    const squawkJson = JSON.stringify([
      {
        file: "/repo/prisma/migrations/20240101_init/migration.sql",
        line: 1,
        level: "Error",
        rule_name: "adding-not-nullable-field",
        message: "Adding a NOT NULL field requires a default",
        url: "https://squawkhq.com/docs/adding-not-nullable-field",
      },
      {
        file: "/repo/prisma/migrations/20240101_init/migration.sql",
        line: 5,
        level: "Error",
        rule_name: "prefer-robust-stmts",
        message: "Use IF NOT EXISTS",
      },
      {
        file: "/repo/prisma/migrations/20240101_init/migration.sql",
        line: 9,
        level: "Error",
        rule_name: "adding-not-nullable-field",
        message: "Another NOT NULL field",
      },
      {
        file: "/repo/prisma/migrations/20240102_next/migration.sql",
        line: 3,
        level: "Warning",
        rule_name: "ban-drop-column",
        message: "Dropping a column is dangerous",
      },
      {
        file: "/repo/prisma/migrations/20240102_next/migration.sql",
        line: 7,
        level: "Warning",
        rule_name: "ban-drop-column",
        message: "Dropping another column",
      },
    ]);

    programExecFile([
      { stdout: "squawk 0.29.0\n" }, // --version probe
      { stdout: squawkJson }, // actual lint run
    ]);

    const result = await migrationLint("test");

    expect(result.squawk_installed).toBe(true);
    expect(result.squawk_version).toBe("squawk 0.29.0");
    expect(result.files_checked).toBe(2);
    expect(result.findings).toHaveLength(5);

    // by_severity: 3 errors, 2 warnings
    expect(result.by_severity).toEqual({ error: 3, warning: 2 });

    // by_rule aggregation
    expect(result.by_rule).toEqual({
      "adding-not-nullable-field": 2,
      "prefer-robust-stmts": 1,
      "ban-drop-column": 2,
    });

    // file paths should be normalised back to repo-relative
    expect(result.findings[0]!.file).toBe(
      "prisma/migrations/20240101_init/migration.sql",
    );
    expect(result.findings[0]!.url).toBe(
      "https://squawkhq.com/docs/adding-not-nullable-field",
    );
    expect(result.findings[0]!.level).toBe("error");
    expect(result.findings[3]!.level).toBe("warning");
  });

  it("still parses findings when squawk exits non-zero", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex(["prisma/migrations/20240101_init/migration.sql"]),
    );

    const nonZero = new Error("squawk exited with code 1") as NodeJS.ErrnoException;
    // no `code` field → not ENOENT

    programExecFile([
      { stdout: "squawk 0.29.0\n" },
      {
        error: nonZero,
        stdout: JSON.stringify([
          {
            file: "/repo/prisma/migrations/20240101_init/migration.sql",
            line: 1,
            level: "Error",
            rule_name: "require-concurrent-index-creation",
            message: "Use CONCURRENTLY",
          },
        ]),
      },
    ]);

    const result = await migrationLint("test");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule).toBe("require-concurrent-index-creation");
    expect(result.by_severity.error).toBe(1);
  });

  it("passes excluded_rules to squawk via --exclude", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex(["prisma/migrations/20240101_init/migration.sql"]),
    );
    programExecFile([
      { stdout: "squawk 0.29.0\n" },
      { stdout: "[]" },
    ]);

    await migrationLint("test", {
      excluded_rules: ["prefer-robust-stmts", "ban-drop-column"],
    });

    // Second call is the actual lint invocation
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const args = mockExecFile.mock.calls[1]![1] as string[];
    const excludeIdx = args.indexOf("--exclude");
    expect(excludeIdx).toBeGreaterThanOrEqual(0);
    expect(args[excludeIdx + 1]).toBe("prefer-robust-stmts,ban-drop-column");
  });

  it("passes pg_version to squawk via --pg-version", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex(["migrations/001_init.sql"]),
    );
    programExecFile([
      { stdout: "squawk 0.29.0\n" },
      { stdout: "[]" },
    ]);

    await migrationLint("test", { pg_version: "13" });

    const args = mockExecFile.mock.calls[1]![1] as string[];
    const idx = args.indexOf("--pg-version");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("13");

    // --reporter Json should always be present
    expect(args).toContain("--reporter");
    expect(args).toContain("Json");
  });

  it("discovers migration files across prisma, generic, and db/migrate layouts", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        "prisma/migrations/20240101_init/migration.sql",
        "migrations/001_init.sql",
        "db/migrate/20240101000000_create_users.sql",
        "drizzle/0001_init.sql",
        // noise that should NOT be picked up
        "src/index.ts",
        "scripts/seed.ts",
        "docs/migrations.md",
      ]),
    );
    programExecFile([
      { stdout: "squawk 0.29.0\n" },
      { stdout: "[]" },
    ]);

    const result = await migrationLint("test");

    expect(result.files_checked).toBe(4);

    // Inspect the paths passed to the actual lint invocation.
    const lintArgs = mockExecFile.mock.calls[1]![1] as string[];
    const fileArgs = lintArgs.filter((a) => a.endsWith(".sql"));
    expect(fileArgs).toHaveLength(4);
    expect(fileArgs.some((a) => a.includes("prisma/migrations/"))).toBe(true);
    expect(fileArgs.some((a) => a.includes("db/migrate/"))).toBe(true);
    expect(fileArgs.some((a) => a.includes("drizzle/"))).toBe(true);
    expect(fileArgs.some((a) => a.endsWith("migrations/001_init.sql"))).toBe(true);
  });

  it("honours a custom migration_glob override", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex([
        "prisma/migrations/20240101_init/migration.sql", // would match default
        "sql/changes/001.sql", // only matches override
      ]),
    );
    programExecFile([
      { stdout: "squawk 0.29.0\n" },
      { stdout: "[]" },
    ]);

    const result = await migrationLint("test", {
      migration_glob: "sql/changes/**/*.sql",
    });

    expect(result.files_checked).toBe(1);
    const lintArgs = mockExecFile.mock.calls[1]![1] as string[];
    const fileArgs = lintArgs.filter((a) => a.endsWith(".sql"));
    expect(fileArgs).toHaveLength(1);
    expect(fileArgs[0]).toContain("sql/changes/001.sql");
  });

  it("parses NDJSON output (one object per line)", async () => {
    mockGetCodeIndex.mockResolvedValue(
      makeIndex(["migrations/001_init.sql"]),
    );

    const ndjson =
      JSON.stringify({
        file: "/repo/migrations/001_init.sql",
        line: 2,
        level: "Warning",
        rule_name: "ban-drop-column",
        message: "dropping a column",
      })
      + "\n"
      + JSON.stringify({
        file: "/repo/migrations/001_init.sql",
        line: 4,
        level: "Error",
        rule_name: "adding-not-nullable-field",
        message: "not null",
      });

    programExecFile([
      { stdout: "squawk 0.29.0\n" },
      { stdout: ndjson },
    ]);

    const result = await migrationLint("test");

    expect(result.findings).toHaveLength(2);
    expect(result.by_severity).toEqual({ error: 1, warning: 1 });
    expect(result.by_rule).toEqual({
      "ban-drop-column": 1,
      "adding-not-nullable-field": 1,
    });
  });
});
