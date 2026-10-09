import type { DatabaseSync } from "node:sqlite";
import type {
  NativeCore,
  NativeSqliteDatabase,
  NativeSqliteOpenOptions,
  NativeSqliteStatement,
} from "../../native/index.js";

/**
 * `node:sqlite`'s `DatabaseSync`, backed by the Rust core's copy of SQLite (ADR-006 stage 1).
 *
 * While the native store is on, `loadSqliteCtor()` hands THIS class to every caller instead of
 * node's, so one SQLite library owns every index database in the process. Two copies on one file is
 * the documented way to corrupt it: POSIX locks are per process, so neither copy sees the other's,
 * and a connection closing in one deletes the `-wal`/`-shm` the other is still using.
 *
 * The Rust half (`crates/codesift-napi/src/sqlite_compat.rs`) is a port of node's C++; this half does
 * what node does in JS-visible terms around it — the named-vs-positional argument split and the error
 * objects, whose `code`/`errcode`/`errstr` are what `errors.ts` classifies on. Same behaviour, checked
 * by `tests/native/sqlite-compat-parity.test.ts` against node itself.
 *
 * `iterate()`, `setReadBigInts()` and the other StatementSync extras are absent: nothing in this
 * codebase calls them, and a port of an unused surface is a port nobody tests.
 */

const SEP = "\u0001";

type NodeSqliteError = Error & { code?: string; errcode?: number; errstr?: string };

/** The error node would have thrown, rebuilt from the Rust side's `\u0001`-separated encoding. */
function toNodeError(err: unknown): unknown {
  if (!(err instanceof Error) || !err.message.startsWith(SEP)) return err;
  const [, code = "", errcode = "", errstr = "", ...rest] = err.message.split(SEP);
  const message = rest.join(SEP);
  const Ctor = code === "ERR_INVALID_ARG_TYPE" || code === "ERR_INVALID_ARG_VALUE"
    ? TypeError
    : code === "ERR_OUT_OF_RANGE"
      ? RangeError
      : Error;
  const out: NodeSqliteError = new Ctor(message);
  out.code = code;
  if (code === "ERR_SQLITE_ERROR") {
    out.errcode = Number(errcode);
    out.errstr = errstr;
  }
  return out;
}

/**
 * node's rule: a first argument that is an object and not an ArrayBufferView carries the NAMED
 * parameters; everything else is positional. Arrays and functions are objects here, as in V8.
 */
function split(args: unknown[]): [object | undefined, unknown[]] {
  const first = args[0];
  const isObject = (typeof first === "object" && first !== null) || typeof first === "function";
  return isObject && !ArrayBuffer.isView(first) ? [first as object, args.slice(1)] : [undefined, args];
}

/** node hands SQL to SQLite as a C string, so text past an embedded NUL is never seen. */
function cString(sql: string): string {
  const nul = sql.indexOf("\u0000");
  return nul < 0 ? sql : sql.slice(0, nul);
}

type RowFactory = (...values: unknown[]) => object;

/** Compiled row constructors by column list. Bounded: a list is a query shape, and there are few. */
const rowFactories = new Map<string, RowFactory>();
const MAX_ROW_FACTORIES = 512;

/**
 * The function the Rust side calls once per row: `(v0, v1, …) => ({ __proto__: null, "id": v0, … })`.
 *
 * node builds a row with V8's `Object::New(null, names, values, n)`, which Node-API does not expose;
 * a compiled literal is the one-call equivalent — same null prototype, same own data properties, and
 * the same answer for duplicate names (last value, first position) and index-like names (sorted
 * first). A column literally named `__proto__` is written as a computed key, because the plain
 * `"__proto__": v` form in a literal sets the prototype instead of defining a property.
 */
function makeRowFactory(names: string[]): RowFactory {
  const key = names.join("\u0000");
  let factory = rowFactories.get(key);
  if (factory) return factory;
  const params = names.map((_, i) => `v${i}`);
  const props = names.map((n, i) => (n === "__proto__" ? `["__proto__"]: v${i}` : `${JSON.stringify(n)}: v${i}`));
  // Every name is quoted by JSON.stringify, so no column alias can become code.
  factory = new Function(...params, `return { __proto__: null, ${props.join(", ")} };`) as RowFactory;
  if (rowFactories.size >= MAX_ROW_FACTORIES) rowFactories.clear();
  rowFactories.set(key, factory);
  return factory;
}

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toNodeError(err);
  }
}

class NativeStatementSync {
  readonly #stmt: NativeSqliteStatement;

  constructor(stmt: NativeSqliteStatement) {
    this.#stmt = stmt;
  }

  get(...args: unknown[]): unknown {
    const [named, positional] = split(args);
    return call(() => this.#stmt.get(named, positional, makeRowFactory));
  }

  all(...args: unknown[]): unknown[] {
    const [named, positional] = split(args);
    return call(() => this.#stmt.all(named, positional, makeRowFactory));
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    const [named, positional] = split(args);
    return call(() => this.#stmt.run(named, positional));
  }
}

const OPTION_KEYS = [
  "open",
  "readOnly",
  "enableForeignKeyConstraints",
  "enableDoubleQuotedStringLiterals",
  "timeout",
] as const;

/** A `DatabaseSync` constructor over `core`'s SQLite. */
export function nativeDatabaseSyncCtor(core: NativeCore): typeof DatabaseSync {
  const Native = core.SqliteDatabase;

  class NativeDatabaseSync {
    readonly #db: NativeSqliteDatabase;

    constructor(location: string, options?: Record<string, unknown>) {
      if (typeof location !== "string") {
        // node also takes a Buffer or URL; nothing here passes one, so refuse rather than guess.
        throw new TypeError("The native store opens databases by string path only");
      }
      const picked: NativeSqliteOpenOptions = {};
      for (const key of OPTION_KEYS) {
        if (options?.[key] !== undefined) (picked as Record<string, unknown>)[key] = options[key];
      }
      this.#db = call(() => new Native(location, picked));
    }

    get isOpen(): boolean {
      return this.#db.isOpen;
    }

    get isTransaction(): boolean {
      return call(() => this.#db.isTransaction);
    }

    open(): void {
      call(() => this.#db.open());
    }

    close(): void {
      call(() => this.#db.close());
    }

    exec(sql: string): void {
      call(() => this.#db.exec(cString(sql)));
    }

    prepare(sql: string): NativeStatementSync {
      return new NativeStatementSync(call(() => this.#db.prepare(cString(sql))));
    }
  }

  return NativeDatabaseSync as unknown as typeof DatabaseSync;
}
