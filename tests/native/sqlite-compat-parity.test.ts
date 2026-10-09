// ADR-006 stage 1: while the native store is on, every `node:sqlite` caller gets the native
// `DatabaseSync` instead (one SQLite copy per process). That swap is only safe if the two are
// indistinguishable to a caller, so the same scenario runs against both and the transcripts — every
// value, its type, the row prototype, and every error's class, code, errcode and errstr — must match.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getNativeCore, resetNativeForTesting } from "../../src/native/index.js";
import { nativeDatabaseSyncCtor } from "../../src/storage/sqlite/native-sqlite.js";
import { runScenario } from "./sqlite-compat-scenarios.js";

const native = (() => {
  const prev = process.env["CODESIFT_NATIVE_STORE"];
  process.env["CODESIFT_NATIVE_STORE"] = "1";
  resetNativeForTesting();
  try {
    return getNativeCore("store");
  } catch {
    return null;
  } finally {
    if (prev === undefined) delete process.env["CODESIFT_NATIVE_STORE"];
    else process.env["CODESIFT_NATIVE_STORE"] = prev;
  }
})();

/**
 * Steps where node:sqlite itself changed between Node 24 releases (24.18 refuses a boolean and hands
 * back a dead statement for empty SQL; 24.21 binds the boolean as 0/1 and refuses the SQL up front).
 * The native class pins the newer behaviour; the comparison substitutes it for node's line, so the
 * test holds on either Node while still checking the native line exactly. Nothing in src/ binds a
 * boolean or prepares empty SQL — the pin matters only for which way a future caller would fail.
 */
const PINNED: Record<string, string> = {
  "bind true": 'null-proto{"t": "integer", "v": 1}',
  "prepare empty": 'THROW TypeError "The SQL query contains no statements." code="ERR_INVALID_ARG_VALUE" errcode=undefined errstr=undefined',
  "prepare comment": 'THROW TypeError "The SQL query contains no statements." code="ERR_INVALID_ARG_VALUE" errcode=undefined errstr=undefined',
};

function pin(lines: string[]): string[] {
  return lines.map((line) => {
    const label = line.slice(0, line.indexOf(": "));
    return label in PINNED ? `${label}: ${PINNED[label]}` : line;
  });
}

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-sqlite-compat-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!native)("native DatabaseSync matches node:sqlite", () => {
  it("produces the same transcript for the whole scenario", () => {
    // Separate directories: each library only ever opens its own files, so the scenario never puts
    // two SQLite copies on one database — the hazard this class exists to remove.
    const expected = pin(runScenario(DatabaseSync as never, freshDir()));
    const actual = runScenario(nativeDatabaseSyncCtor(native!) as never, freshDir());
    expect(actual.join("\n")).toBe(expected.join("\n"));
  });

  it("is built with every SQL-visible option node's SQLite has", () => {
    // `.cargo/config.toml` adds what libsqlite3-sys's bundle lacks (math functions, percentile,
    // geopoly, the variable limit). A Node upgrade that adds an option shows up here, not as
    // "no such function" from one query in the field. Node builds differ (Homebrew links its own
    // SQLite), so only SQL-visible options count: the skipped ones are C-API extensions or memory
    // accounting, and the variable limit is compared as a number — ours must be at least node's.
    const options = (Ctor: typeof DatabaseSync) => {
      const db = new Ctor(":memory:");
      try {
        return new Set((db.prepare("PRAGMA compile_options").all() as Array<{ compile_options: string }>).map((r) => r.compile_options));
      } finally {
        db.close();
      }
    };
    const ours = options(nativeDatabaseSyncCtor(native!));
    const theirs = options(DatabaseSync);
    const notSqlVisible = /^(COMPILER=|DEFAULT_MEMSTATUS=|ENABLE_PREUPDATE_HOOK$|ENABLE_SESSION$|ENABLE_UNLOCK_NOTIFY$|ENABLE_RBU$|MAX_VARIABLE_NUMBER=)/;
    const missing = [...theirs].filter((o) => !ours.has(o) && !notSqlVisible.test(o));
    expect(missing).toEqual([]);
    const limit = (set: Set<string>) => Number([...set].find((o) => o.startsWith("MAX_VARIABLE_NUMBER="))?.split("=")[1] ?? 999);
    expect(limit(ours)).toBeGreaterThanOrEqual(limit(theirs));
  });

  it("throws when a named-parameter getter closes the database mid-bind (use-after-free)", () => {
    // Native only: the getter finalizes the statement being bound; reading on would touch freed
    // memory. node itself is not run here — this is about the port not crashing the process.
    const Native = nativeDatabaseSyncCtor(native!);
    const db = new Native(":memory:");
    const stmt = db.prepare("SELECT $a AS a, $b AS b");
    let getterRan = false;
    const named = {
      get a() {
        getterRan = true;
        db.close();
        return 1;
      },
      b: 2,
    };
    // Before the fix this did not throw — the process died (exit 139), which no assertion can see;
    // reaching the lines below at all is half of the check.
    expect(() => stmt.get(named)).toThrow("statement has been finalized");
    expect(getterRan).toBe(true);
  });

  it("writes a file node:sqlite reads back identically", () => {
    const dir = freshDir();
    const path = join(dir, "x.db");
    const Native = nativeDatabaseSyncCtor(native!);
    const w = new Native(path);
    w.exec("PRAGMA journal_mode = WAL; CREATE TABLE t(a, b TEXT, c REAL)");
    const ins = w.prepare("INSERT INTO t VALUES (?, ?, ?)");
    // One transaction: 1000 autocommits are 1000 fsyncs, past the timeout on a Windows runner.
    w.exec("BEGIN");
    for (let i = 0; i < 1000; i++) ins.run(i, `s${i}`, i / 3);
    w.exec("COMMIT");
    w.close();
    const r = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = r.prepare("SELECT typeof(a) ta, a, b, c FROM t ORDER BY rowid").all();
      expect(rows).toHaveLength(1000);
      // REAL: node binds every JS number as a double, and so does the port.
      expect(rows[999]).toEqual({ ta: "real", a: 999, b: "s999", c: 333 });
    } finally {
      r.close();
    }
  });
});
