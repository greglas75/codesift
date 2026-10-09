// The scenario both `node:sqlite` and the native `DatabaseSync` run in sqlite-compat-parity.test.ts.
// It returns a transcript: every result and every thrown error, serialised with the details a
// caller can observe — value types, the row prototype, error class and the `code`/`errcode`/`errstr`
// fields `errors.ts` classifies on. Equal transcripts are the parity claim.
import { join } from "node:path";

type Ctor = new (path: string, options?: Record<string, unknown>) => {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  close(): void;
  open(): void;
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
};

function show(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Uint8Array) return `${v.constructor.name}[${[...v].join(",")}]`;
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  if (typeof v === "object") {
    const p = Object.getPrototypeOf(v) as object | null;
    // Named, not just "has one": a row built on any other prototype must print differently.
    const proto = p === null ? "null-proto" : p === Object.prototype ? "object" : `proto:${p.constructor?.name ?? "?"}`;
    return `${proto}{${Object.entries(v as object).map(([k, x]) => `${JSON.stringify(k)}: ${show(x)}`).join(", ")}}`;
  }
  return `${typeof v}:${String(v)}`;
}

function showError(e: unknown): string {
  const err = e as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
  return `THROW ${err.constructor?.name} ${JSON.stringify(err.message)} code=${show(err.code)} errcode=${show(err.errcode)} errstr=${show(err.errstr)}`;
}

export function runScenario(Db: Ctor, dir: string): string[] {
  const out: string[] = [];
  const step = (label: string, fn: () => unknown): void => {
    try {
      out.push(`${label}: ${show(fn())}`);
    } catch (e) {
      out.push(`${label}: ${showError(e)}`);
    }
  };

  const path = join(dir, "s.db");
  const db = new Db(path);
  step("isOpen", () => db.isOpen);
  step("isTransaction", () => db.isTransaction);
  step("open twice", () => db.open());

  // Binding: every JS type, and the storage class SQLite actually received.
  const t = (label: string, ...args: unknown[]) =>
    step(`bind ${label}`, () => db.prepare("SELECT typeof(?) AS t, ? AS v").get(...args, ...args));
  t("int", 5);
  t("frac", 5.5);
  t("neg zero", -0);
  t("nan", Number.NaN);
  t("inf", Number.POSITIVE_INFINITY);
  t("max safe", Number.MAX_SAFE_INTEGER);
  t("huge", 1e300);
  t("bigint", 5n);
  t("bigint big", 9_007_199_254_740_993n);
  t("bigint too big", 2n ** 64n);
  t("string", "zażółć 中文 🚀");
  t("empty string", "");
  t("nul in string", "a\u0000b");
  t("lone surrogate", "x\uD800y");
  t("null", null);
  t("undefined", undefined);
  t("true", true);
  t("symbol", Symbol("s"));
  t("function", () => 1);
  t("uint8", new Uint8Array([0, 1, 255]));
  t("buffer", Buffer.from([7, 8]));
  t("float64array", new Float64Array([1.5]));
  t("dataview", new DataView(new Uint8Array([3, 4]).buffer));
  t("subarray", new Uint8Array([9, 8, 7, 6]).subarray(1, 3));
  t("empty blob", new Uint8Array([]));
  t("date", new Date(0));
  t("array", [1, 2]);

  // Arity and named parameters.
  step("too few", () => db.prepare("SELECT ? AS a, ? AS b").get(1));
  step("too many", () => db.prepare("SELECT ? AS a").get(1, 2));
  step("none for none", () => db.prepare("SELECT 1 AS a").get());
  step("args for none", () => db.prepare("SELECT 1 AS a").get(1));
  step("named $", () => db.prepare("SELECT $a AS a").get({ a: 1 }));
  step("named : @", () => db.prepare("SELECT :a AS a, @b AS b").get({ a: 1, b: "x" }));
  step("named prefixed key", () => db.prepare("SELECT $a AS a").get({ $a: 2 }));
  step("named unknown", () => db.prepare("SELECT $a AS a").get({ a: 1, z: 2 }));
  step("named missing", () => db.prepare("SELECT $a AS a, $b AS b").get({ a: 1 }));
  step("named + positional", () => db.prepare("SELECT $a AS a, ? AS b").get({ a: 1 }, 2));
  step("named conflict", () => db.prepare("SELECT $a AS a, :a AS b").get({ a: 1 }));
  step("numbered", () => db.prepare("SELECT ?2 AS a, ?1 AS b").get(1, 2));
  step("empty object", () => db.prepare("SELECT ? AS a").get({}));
  step("null first", () => db.prepare("SELECT ? AS a, ? AS b").get(null, 1));
  step("named inherited", () => db.prepare("SELECT $a AS a").get(Object.create({ a: 1 })));

  // Reading: every storage class back out, and the row shape.
  step("row types", () => db.prepare("SELECT 1 AS i, 2.0 AS r, 2.5 AS f, 'x' AS t, NULL AS n, x'00ff' AS b, x'' AS eb, -0.0 AS nz").get());
  step("int out of range", () => db.prepare("SELECT 9007199254740993 AS a").get());
  step("int min safe", () => db.prepare("SELECT -9007199254740991 AS a").get());
  step("int below safe", () => db.prepare("SELECT -9007199254740992 AS a").get());
  step("text with nul", () => db.prepare("SELECT 'a' || char(0) || 'b' AS a, length('a' || char(0) || 'b') AS n").get());
  step("invalid utf8", () => db.prepare("SELECT CAST(x'61ff62' AS TEXT) AS a").get());
  step("dup columns", () => db.prepare("SELECT 1 AS a, 2 AS a, 3 AS b").get());
  step("unnamed column", () => db.prepare("SELECT 1 + 1").get());
  step("proto column", () => db.prepare("SELECT 1 AS __proto__, 2 AS constructor").get());
  step("numeric column name", () => db.prepare("SELECT 1 AS \"0\", 2 AS \"1\"").all());
  step("no row", () => db.prepare("SELECT 1 WHERE 0").get());
  step("all empty", () => db.prepare("SELECT 1 WHERE 0").all());
  step("div zero", () => db.prepare("SELECT 1/0 AS a").get());
  step("math fn", () => db.prepare("SELECT ln(1) AS a").get());
  step("dqs dml", () => db.prepare("SELECT \"zz\" AS a").get());
  step("foreign keys", () => db.prepare("PRAGMA foreign_keys").get());

  // DDL, writes, run().
  step("exec ddl", () => db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a, b TEXT, c REAL, d INTEGER); CREATE INDEX t_b ON t(b)"));
  step("dqs ddl", () => db.exec("CREATE INDEX t_bad ON t(\"nope\")"));
  const ins = db.prepare("INSERT INTO t(a, b, c, d) VALUES (?, ?, ?, ?)");
  step("run insert", () => ins.run(1, "x", 1, 1));
  step("run insert 2", () => ins.run(1.5, 2, 2.5, 2.5));
  step("run insert blob", () => ins.run(new Uint8Array([1]), null, null, 7n));
  step("stored types", () => db.prepare("SELECT typeof(a) a, typeof(b) b, typeof(c) c, typeof(d) d, a, b, c, d FROM t ORDER BY id").all());
  step("run update", () => db.prepare("UPDATE t SET b = 'y'").run());
  step("run no-op", () => db.prepare("UPDATE t SET b = 'y' WHERE 0").run());
  step("run select", () => db.prepare("SELECT * FROM t").run());
  step("run returning", () => db.prepare("INSERT INTO t(a) VALUES (9) RETURNING id").run());
  step("get returning", () => db.prepare("INSERT INTO t(a) VALUES (10) RETURNING id, a").get());
  step("all returning", () => db.prepare("DELETE FROM t WHERE a >= 9 RETURNING id").all());
  step("run constraint", () => db.prepare("INSERT INTO t(id) VALUES (1)").run());
  step("get constraint", () => db.prepare("INSERT INTO t(id) VALUES (1) RETURNING id").get());
  step("reuse after error", () => db.prepare("SELECT count(*) AS n FROM t").get());

  // Statement reuse: a statement must reset between calls, bindings must not leak.
  const reuse = db.prepare("SELECT ? AS v");
  step("reuse 1", () => reuse.get(1));
  step("reuse 2", () => reuse.get("two"));
  step("reuse unbound", () => reuse.get());
  const iter = db.prepare("SELECT value AS v FROM json_each('[1,2,3]')");
  step("partial then all", () => [iter.get(), iter.all()]);

  // Prepare edge cases.
  step("prepare syntax", () => db.prepare("SELEC 1"));
  step("prepare empty", () => db.prepare("").get());
  step("prepare comment", () => db.prepare("-- nothing").all());
  step("prepare multi", () => db.prepare("SELECT 1 AS a; SELECT 2 AS b").all());
  step("prepare missing table", () => db.prepare("SELECT * FROM nope"));
  step("exec multi with error", () => db.exec("INSERT INTO t(a) VALUES (100); SELEC 2; INSERT INTO t(a) VALUES (101)"));
  step("after partial exec", () => db.prepare("SELECT a FROM t WHERE a >= 100").all());

  // Transactions.
  step("begin", () => db.exec("BEGIN"));
  step("isTransaction in", () => db.isTransaction);
  step("nested begin", () => db.exec("BEGIN"));
  step("rollback", () => db.exec("ROLLBACK"));
  step("rollback none", () => db.exec("ROLLBACK"));
  step("isTransaction out", () => db.isTransaction);

  // A second connection on the same file: WAL, locking, data_version.
  step("wal", () => db.prepare("PRAGMA journal_mode = WAL").get());
  const other = new Db(path);
  step("busy timeout 0", () => other.prepare("PRAGMA busy_timeout").get());
  step("data_version before", () => db.prepare("PRAGMA data_version").get());
  step("other write", () => other.prepare("INSERT INTO t(a) VALUES (200)").run());
  step("data_version after", () => db.prepare("PRAGMA data_version").get());
  step("lock", () => db.exec("BEGIN IMMEDIATE"));
  step("busy", () => other.exec("BEGIN IMMEDIATE"));
  step("unlock", () => db.exec("COMMIT"));
  other.close();

  // Options.
  const withTimeout = new Db(path, { timeout: 1234 });
  step("timeout option", () => withTimeout.prepare("PRAGMA busy_timeout").get());
  withTimeout.close();
  const ro = new Db(path, { readOnly: true });
  step("readOnly write", () => ro.exec("INSERT INTO t(a) VALUES (1)"));
  step("readOnly read", () => ro.prepare("SELECT count(*) AS n FROM t").get());
  ro.close();
  const fkOff = new Db(":memory:", { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true });
  step("fk off", () => fkOff.prepare("PRAGMA foreign_keys").get());
  step("dqs on", () => fkOff.prepare("SELECT \"zz\" AS a").get());
  fkOff.close();
  const closed = new Db(join(dir, "later.db"), { open: false });
  step("closed isOpen", () => closed.isOpen);
  step("closed prepare", () => closed.prepare("SELECT 1"));
  step("closed isTransaction", () => closed.isTransaction);
  step("open later", () => closed.open());
  step("opened prepare", () => closed.prepare("SELECT 1 AS a").get());
  closed.close();
  step("uri ro missing", () => new Db(`file:${join(dir, "missing.db")}?mode=ro`, { open: true }));
  step("uri ro existing", () => {
    const u = new Db(`file:${path}?mode=ro`);
    try {
      return u.prepare("SELECT count(*) AS n FROM t").get();
    } finally {
      u.close();
    }
  });
  step("missing dir", () => new Db(join(dir, "no", "such", "dir.db")));
  step("memory", () => new Db(":memory:").prepare("SELECT 1 AS a").get());

  // Lifecycle after close.
  const kept = db.prepare("SELECT 1 AS a");
  step("close", () => db.close());
  step("close twice", () => db.close());
  step("isOpen closed", () => db.isOpen);
  step("prepare closed", () => db.prepare("SELECT 1"));
  step("exec closed", () => db.exec("SELECT 1"));
  step("stmt after close", () => kept.get());
  step("stmt all after close", () => kept.all());
  step("stmt run after close", () => kept.run());
  step("reopen", () => db.open());
  step("old stmt after reopen", () => kept.get());
  step("new stmt after reopen", () => db.prepare("SELECT count(*) AS n FROM t").get());
  db.close();

  return out;
}
