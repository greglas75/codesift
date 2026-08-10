import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  saveIndex,
  loadIndex,
  loadIndexOrStale,
  sqlitePathFor,
  resetIndexBackendForTesting,
  resetMigrationCacheForTesting,
  resetIndexCacheForTesting,
} from "../../src/storage/index-store.js";
import {
  closeAllIndexDbs,
  classifyStorageError,
  IndexStorageError,
} from "../../src/storage/sqlite-index-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

function makeSymbol(file: string, name: string, line: number): CodeSymbol {
  return {
    id: `test:${file}:${name}:${line}`,
    repo: "test/repo",
    name,
    kind: "function",
    file,
    start_line: line,
    end_line: line + 3,
  };
}

function makeIndex(overrides?: Partial<CodeIndex>): CodeIndex {
  return {
    repo: "test/repo",
    root: "/tmp/root",
    symbols: [],
    files: [],
    created_at: 10,
    updated_at: 20,
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

let dir: string;
let indexPath: string;
const previousBackend = process.env["CODESIFT_INDEX_BACKEND"];
const execFileAsync = promisify(execFile);

function useBackend(backend: "json" | "sqlite"): void {
  process.env["CODESIFT_INDEX_BACKEND"] = backend;
  resetIndexBackendForTesting();
  resetMigrationCacheForTesting();
  resetIndexCacheForTesting();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-storage-err-"));
  indexPath = join(dir, "abc123.index.json");
});

afterEach(async () => {
  closeAllIndexDbs();
  if (previousBackend === undefined) delete process.env["CODESIFT_INDEX_BACKEND"];
  else process.env["CODESIFT_INDEX_BACKEND"] = previousBackend;
  resetIndexBackendForTesting();
  resetMigrationCacheForTesting();
  resetIndexCacheForTesting();
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("classifyStorageError", () => {
  it("recognises plain sqlite operational codes", () => {
    expect(classifyStorageError({ code: "SQLITE_CORRUPT" })).toBe("SQLITE_CORRUPT");
    expect(classifyStorageError({ code: "SQLITE_BUSY" })).toBe("SQLITE_BUSY");
    expect(classifyStorageError({ code: "SQLITE_CANTOPEN" })).toBe("SQLITE_CANTOPEN");
  });

  it("recognises extended result codes spelled as strings", () => {
    // NOT what `node:sqlite` produces — it puts a NUMBER in `errcode` and "ERR_SQLITE_ERROR" in
    // `code` (see tests/storage/sqlite-fault-classification.test.ts). This case covers bindings
    // that do name codes as strings, e.g. better-sqlite3. The comment here used to claim
    // node:sqlite behaved this way, which is how three allowlisted codes stayed unreachable while
    // this file looked like it had them covered.
    expect(classifyStorageError({ code: "SQLITE_IOERR_READ" })).toBe("SQLITE_IOERR_READ");
    expect(classifyStorageError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe("SQLITE_BUSY_SNAPSHOT");
  });

  it("recognises filesystem codes", () => {
    expect(classifyStorageError({ code: "EACCES" })).toBe("EACCES");
    expect(classifyStorageError({ code: "EIO" })).toBe("EIO");
  });

  it("falls back to the message when no code is attached", () => {
    expect(classifyStorageError(new Error("file is not a database"))).toBe("SQLITE_CORRUPT");
    expect(classifyStorageError(new Error("database is locked"))).toBe("SQLITE_BUSY");
  });

  it("does NOT classify ordinary errors, so absence stays absence", () => {
    expect(classifyStorageError(new Error("boom"))).toBeNull();
    expect(classifyStorageError({ code: "ENOENT" })).toBeNull();
    expect(classifyStorageError({ code: "SQLITE_CONSTRAINT" })).toBeNull();
    expect(classifyStorageError(null)).toBeNull();
    expect(classifyStorageError("nope")).toBeNull();
  });
});

describe("corrupt SQLite store", () => {
  beforeEach(async () => {
    useBackend("sqlite");
    // Real corruption, not a mock: bytes that are not an SQLite file at all.
    await writeFile(sqlitePathFor(indexPath), "this is definitely not a database\n".repeat(64));
  });

  it("loadIndexOrStale reports unreadable instead of null", async () => {
    const result = await loadIndexOrStale(indexPath, {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe("unreadable");
    if (result!.status === "unreadable") {
      expect(result!.reason).toBe("storage_error");
      expect(result!.code).toMatch(/SQLITE_/);
      expect(result!.message).toBeTruthy();
    }
  });

  it("loadIndex throws rather than claiming the repo has no index", async () => {
    // The regression this whole change exists for: a corrupt store used to be indistinguishable
    // from an unindexed repo, so tools answered "no results" with full confidence.
    await expect(loadIndex(indexPath)).rejects.toThrow(IndexStorageError);
  });

  it("the thrown error names the path and the code", async () => {
    await expect(loadIndex(indexPath)).rejects.toMatchObject({
      name: "IndexStorageError",
      path: sqlitePathFor(indexPath),
    });
  });
});

describe("absence is still absence", () => {
  it("an unwritten sqlite index reads as null, not as an error", async () => {
    useBackend("sqlite");
    expect(await loadIndex(indexPath)).toBeNull();
    expect(await loadIndexOrStale(indexPath, {})).toBeNull();
  });

  it("a valid but empty sqlite db reads as null", async () => {
    useBackend("sqlite");
    // saveIndex creates the schema; the meta `repo` key is what marks it populated.
    await saveIndex(indexPath, makeIndex());
    closeAllIndexDbs();
    resetIndexCacheForTesting();
    const loaded = await loadIndex(indexPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.symbols).toEqual([]);
  });

  it("a missing JSON index reads as null", async () => {
    useBackend("json");
    expect(await loadIndex(join(dir, "nope.index.json"))).toBeNull();
  });

  it("a malformed JSON index still reads as null (rebuildable, not a fault)", async () => {
    useBackend("json");
    await writeFile(indexPath, "not valid json {{{", "utf-8");
    expect(await loadIndex(indexPath)).toBeNull();
  });
});

describe("non-absence read failures are not absence", () => {
  it("a directory where the index should be is a fault, not an unindexed repo", async () => {
    // EISDIR is not in the operational allowlist and never will be — it is a wrong-path
    // condition. It must still not read as "this repo has no index", which is what a blanket
    // `catch { return null }` produced.
    useBackend("json");
    const asDir = join(dir, "actually-a-dir.index.json");
    await mkdir(asDir);
    await expect(loadIndex(asDir)).rejects.toThrow(IndexStorageError);
  });

  it("still reports plain ENOENT as absence", async () => {
    useBackend("json");
    expect(await loadIndex(join(dir, "missing.index.json"))).toBeNull();
  });
});

describe("unreadable JSON store", () => {
  it("an unreadable JSON index throws instead of reading as absent", async () => {
    useBackend("json");
    await saveIndex(indexPath, makeIndex({ symbols: [makeSymbol("a.ts", "x", 1)] }));
    await chmod(indexPath, 0o000);

    try {
      if (process.getuid?.() === 0) {
        // Root can read mode-000 files, so exercise the same built artifact as an unprivileged
        // process instead of silently skipping the assertion in containerised CI.
        await chmod(dir, 0o755);
        const moduleUrl = new URL("../../dist/storage/index-store.js", import.meta.url).href;
        const script = `
          const { loadIndex } = await import(process.argv[1]);
          try {
            await loadIndex(process.argv[2]);
            process.stdout.write(JSON.stringify({ threw: false }));
          } catch (error) {
            process.stdout.write(JSON.stringify({
              threw: true,
              name: error?.name,
              code: error?.code,
            }));
          }
        `;
        const { stdout } = await execFileAsync(
          process.execPath,
          ["--input-type=module", "--eval", script, moduleUrl, indexPath],
          {
            uid: 65_534,
            gid: 65_534,
            env: { ...process.env, CODESIFT_INDEX_BACKEND: "json" },
          },
        );
        expect(JSON.parse(stdout)).toEqual({
          threw: true,
          name: "IndexStorageError",
          code: "EACCES",
        });
        return;
      }

      await expect(loadIndex(indexPath)).rejects.toMatchObject({
        name: "IndexStorageError",
        code: "EACCES",
      });
    } finally {
      await chmod(indexPath, 0o644).catch(() => {});
    }
  });
});

describe("canonical index paths", () => {
  it("rejects a derived SQLite path instead of silently reading a .db.db sibling", async () => {
    useBackend("sqlite");
    const dbPath = sqlitePathFor(indexPath);

    await expect(loadIndex(dbPath)).rejects.toThrow(
      `Expected a canonical index path, received SQLite database path: ${dbPath}`,
    );
  });

  it.each([".DB", ".db-wal", ".DB-SHM", ".DB-JOURNAL"])(
    "rejects the case-insensitive SQLite artifact suffix %s",
    async (suffix) => {
      useBackend("sqlite");
      const sqliteArtifactPath = indexPath.replace(/\.json$/, suffix);

      await expect(loadIndex(sqliteArtifactPath)).rejects.toThrow(
        `Expected a canonical index path, received SQLite database path: ${sqliteArtifactPath}`,
      );
    },
  );
});
