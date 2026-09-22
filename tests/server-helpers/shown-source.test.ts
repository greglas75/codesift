import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compactionMarkerPath,
  elideShownSource,
  enableShownSourceLedger,
  resetShownSourceLedgerForTesting,
  touchCompactionMarker,
} from "../../src/server-helpers/shown-source.js";

const sym = (source: string | undefined, id = "repo:src/a.ts:foo:1") => ({ id, name: "foo", source });

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shown-source-"));
  for (const k of ["CODESIFT_DATA_DIR", "CODESIFT_DEDUP_SOURCE", "CODESIFT_SHOWN_SOURCE_TTL_MS"]) saved[k] = process.env[k];
  process.env["CODESIFT_DATA_DIR"] = dir;
  delete process.env["CODESIFT_DEDUP_SOURCE"];
  delete process.env["CODESIFT_SHOWN_SOURCE_TTL_MS"];
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
  it("sends the body the first time and a pointer on an unchanged repeat", () => {
    const first = elideShownSource(sym("a\nb\nc"));
    expect(first.symbol.source).toBe("a\nb\nc");
    expect(first.note).toBe("");

    const repeat = elideShownSource(sym("a\nb\nc"));
    expect(repeat.symbol.source).toBeUndefined();
    expect(repeat.note).toContain("unchanged (3 lines)");
    expect(repeat.note).toContain('symbol_id="repo:src/a.ts:foo:1", full_source=true');
  });

  // The pointer asserts "unchanged" — it may only be given when that is true.
  it("resends a body that changed since it was shown", () => {
    elideShownSource(sym("v1"));
    const changed = elideShownSource(sym("v2"));
    expect(changed.symbol.source).toBe("v2");
    expect(changed.note).toBe("");
  });

  it("resends when forced", () => {
    elideShownSource(sym("x"));
    expect(elideShownSource(sym("x"), { force: true }).symbol.source).toBe("x");
  });

  it("keys by symbol id, not by body", () => {
    elideShownSource(sym("same", "repo:a.ts:one:1"));
    expect(elideShownSource(sym("same", "repo:b.ts:two:1")).symbol.source).toBe("same");
  });

  it("does nothing while the ledger is off (the daemon's state)", () => {
    resetShownSourceLedgerForTesting(false);
    elideShownSource(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  it("passes symbols without source straight through", () => {
    expect(elideShownSource(sym(undefined))).toEqual({ symbol: sym(undefined), note: "" });
  });

  // Compaction drops old tool results, so the model no longer holds what it was shown.
  it("treats everything shown before a compaction as unseen", () => {
    elideShownSource(sym("x"));
    touchCompactionMarker();
    // mtime resolution can equal shownAt on a fast machine; push the marker clearly later.
    const later = new Date(Date.now() + 5_000);
    utimesSync(compactionMarkerPath(), later, later);
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  it("ignores a compaction older than the showing", () => {
    writeFileSync(compactionMarkerPath(), "0");
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(compactionMarkerPath(), earlier, earlier);
    elideShownSource(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBeUndefined();
  });

  it("resends after the TTL", async () => {
    process.env["CODESIFT_SHOWN_SOURCE_TTL_MS"] = "1";
    elideShownSource(sym("x"));
    await new Promise((r) => setTimeout(r, 5));
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });
});

describe("enableShownSourceLedger", () => {
  it("honours CODESIFT_DEDUP_SOURCE=0", () => {
    resetShownSourceLedgerForTesting(false);
    process.env["CODESIFT_DEDUP_SOURCE"] = "0";
    enableShownSourceLedger();
    elideShownSource(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBe("x");
  });

  it("is on by default once the stdio entry point enables it", () => {
    resetShownSourceLedgerForTesting(false);
    enableShownSourceLedger();
    elideShownSource(sym("x"));
    expect(elideShownSource(sym("x")).symbol.source).toBeUndefined();
  });
});
