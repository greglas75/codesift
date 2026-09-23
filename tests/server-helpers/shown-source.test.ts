import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commitDelivered,
  compactionMarkerPath,
  elideShownSource,
  enableShownSourceLedger,
  resetShownSourceLedgerForTesting,
  touchCompactionMarker,
} from "../../src/server-helpers/shown-source.js";

const sym = (source: string | undefined, id = "repo:src/a.ts:foo:1") => ({ id, name: "foo", source });

/** Check + record, as a handler does once the reply is built and fits. */
function show(s: ReturnType<typeof sym>) {
  const view = elideShownSource(s);
  view.commit();
  return view;
}

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shown-source-"));
  for (const k of ["CODESIFT_DATA_DIR", "CODESIFT_DEDUP_SOURCE", "CODESIFT_SHOWN_SOURCE_TTL_MS", "CODESIFT_MAX_RESPONSE_TOKENS"]) {
    saved[k] = process.env[k];
  }
  process.env["CODESIFT_DATA_DIR"] = dir;
  delete process.env["CODESIFT_DEDUP_SOURCE"];
  delete process.env["CODESIFT_SHOWN_SOURCE_TTL_MS"];
  delete process.env["CODESIFT_MAX_RESPONSE_TOKENS"];
  resetShownSourceLedgerForTesting(true);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetShownSourceLedgerForTesting(false);
  rmSync(dir, { recursive: true, force: true });
});

describe("elideShownSource", () => {
  it("sends the body the first time and a pointer on an unchanged, delivered repeat", () => {
    const first = show(sym("a\nb\nc"));
    expect(first.symbol.source).toBe("a\nb\nc");
    expect(first.note).toBe("");

    const repeat = elideShownSource(sym("a\nb\nc"));
    expect(repeat.symbol.source).toBeUndefined();
    expect(repeat.note).toContain("unchanged (3 lines, id repo:src/a.ts:foo:1)");
    expect(repeat.note).toContain("full_source=true");
  });

  // Checking must not record: a body counts as shown only once the caller knows it was delivered.
  it("does not record a body that was checked but never committed", () => {
    elideShownSource(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  // The pointer asserts "unchanged" — it may only be given when that is true.
  it("resends a body that changed since it was shown", () => {
    show(sym("v1"));
    const changed = elideShownSource(sym("v2"));
    expect(changed.symbol.source).toBe("v2");
    expect(changed.note).toBe("");
  });

  it("resends when forced", () => {
    show(sym("x"));
    expect(elideShownSource(sym("x"), { force: true }).symbol.source).toBe("x");
  });

  // Different lookup paths return the same symbol with and without the repo prefix.
  it("treats the prefixed and unprefixed id of one symbol as the same symbol", () => {
    const loc = { file: "src/a.ts", name: "foo", start_line: 1 };
    const view = elideShownSource({ ...loc, id: "local/r:src/a.ts:foo:1", source: "x" });
    view.commit();
    expect(elideShownSource({ ...loc, id: "src/a.ts:foo:1", source: "x" }).symbol.source).toBeUndefined();
  });

  it("keys by symbol id, not by body", () => {
    show(sym("same", "repo:a.ts:one:1"));
    expect(elideShownSource(sym("same", "repo:b.ts:two:1")).symbol.source).toBe("same");
  });

  it("does nothing while the ledger is off (the daemon's state)", () => {
    resetShownSourceLedgerForTesting(false);
    show(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  it("passes symbols without source straight through", () => {
    const view = elideShownSource(sym(undefined));
    expect(view.symbol).toEqual(sym(undefined));
    expect(view.note).toBe("");
  });

  // Compaction drops old tool results, so the model no longer holds what it was shown.
  it("treats everything shown before a compaction as unseen", async () => {
    show(sym("x"));
    await new Promise((r) => setTimeout(r, 2));
    touchCompactionMarker();
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  it("ignores a compaction older than the showing", () => {
    writeFileSync(compactionMarkerPath(), String(Date.now() - 60_000));
    show(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBeUndefined();
  });

  // The marker's content is the clock; mtime is only the fallback for a hand-touched file.
  it("reads the compaction time from the marker content, not its mtime", () => {
    show(sym("x"));
    writeFileSync(compactionMarkerPath(), String(Date.now() - 60_000));
    const future = new Date(Date.now() + 60_000);
    utimesSync(compactionMarkerPath(), future, future);
    expect(elideShownSource(sym("x")).symbol.source).toBeUndefined();
  });

  it("falls back to mtime when the marker content is not a timestamp", () => {
    show(sym("x"));
    writeFileSync(compactionMarkerPath(), "touched by hand");
    const future = new Date(Date.now() + 60_000);
    utimesSync(compactionMarkerPath(), future, future);
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  it("resends after the TTL", async () => {
    process.env["CODESIFT_SHOWN_SOURCE_TTL_MS"] = "1";
    show(sym("x"));
    await new Promise((r) => setTimeout(r, 5));
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });
});

describe("commitDelivered", () => {
  // Blocks past the budget are the ones the response cap cuts — the agent never receives them.
  it("records only the blocks that fit the budget, in order", () => {
    const a = elideShownSource(sym("a", "repo:a:1"));
    const b = elideShownSource(sym("b", "repo:b:1"));
    const c = elideShownSource(sym("c", "repo:c:1"));
    commitDelivered([{ view: a, chars: 40 }, { view: b, chars: 40 }, { view: c, chars: 40 }], 100);
    expect(elideShownSource(sym("a", "repo:a:1")).symbol.source).toBeUndefined();
    expect(elideShownSource(sym("b", "repo:b:1")).symbol.source).toBeUndefined();
    expect(elideShownSource(sym("c", "repo:c:1")).symbol.source).toBe("c");
  });

  it("defaults to the response cap, so a body larger than the cap is never recorded", () => {
    process.env["CODESIFT_MAX_RESPONSE_TOKENS"] = "1000";
    const big = "z".repeat(10_000);
    commitDelivered([{ view: elideShownSource(sym(big)), chars: big.length }]);
    expect(elideShownSource(sym(big)).symbol.source).toBe(big);
  });
});

describe("enableShownSourceLedger", () => {
  it("honours CODESIFT_DEDUP_SOURCE=0", () => {
    resetShownSourceLedgerForTesting(false);
    process.env["CODESIFT_DEDUP_SOURCE"] = "0";
    enableShownSourceLedger();
    show(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  it("is on by default once the stdio entry point enables it", () => {
    resetShownSourceLedgerForTesting(false);
    enableShownSourceLedger();
    show(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBeUndefined();
  });
});
