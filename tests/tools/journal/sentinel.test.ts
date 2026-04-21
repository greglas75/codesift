import { describe, it, expect } from "vitest";
import {
  parseSentinelBlocks,
  computeBlockHash,
  SentinelIntegrityError,
} from "../../../src/tools/journal-sentinel.js";

// ---------------------------------------------------------------------------
// Hand-frozen SHA-256 for a known content string.
//
// Computed independently via Node crypto at test-authoring time:
//   node -e "const c=require('crypto');
//     console.log(c.createHash('sha256')
//       .update('hello world\nsecond line\n','utf8').digest('hex'))"
//   → 1cf34cbeaca6f2ce821c4b6369c37c583b1cc10846122a8c77a4df77d0d5b7b8
//
// computeBlockHash must reach the same digest AFTER normalising the messy
// CRLF + trailing-space input to the canonical form.
// ---------------------------------------------------------------------------
const FROZEN_NORMALISED = "hello world\nsecond line\n";
const FROZEN_HASH =
  "1cf34cbeaca6f2ce821c4b6369c37c583b1cc10846122a8c77a4df77d0d5b7b8";
const MESSY_INPUT = "hello world   \r\nsecond line  \r\n";

describe("parseSentinelBlocks", () => {
  // (a) auto:begin meta → auto:end meta
  it("parses a single auto:begin/auto:end meta block", () => {
    const md = [
      "# heading",
      "<!-- auto:begin meta -->",
      "meta body line 1",
      "meta body line 2",
      "<!-- auto:end meta -->",
      "trailing prose",
    ].join("\n");

    const blocks = parseSentinelBlocks(md);
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.prefix).toBe("auto");
    expect(block.kind).toBe("meta");
    expect(block.content).toBe("meta body line 1\nmeta body line 2");
    expect(block.startLine).toBe(2);
    expect(block.endLine).toBe(5);
    expect(typeof block.hash).toBe("string");
    expect(block.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // (b) manual:begin migrated-overview → manual:end migrated-overview
  it("parses a manual:begin/manual:end migrated-overview block", () => {
    const md = [
      "<!-- manual:begin migrated-overview -->",
      "human-authored content",
      "<!-- manual:end migrated-overview -->",
    ].join("\n");

    const blocks = parseSentinelBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.prefix).toBe("manual");
    expect(blocks[0]!.kind).toBe("migrated-overview");
    expect(blocks[0]!.content).toBe("human-authored content");
  });

  // (d) unclosed auto:begin → throws with line number
  it("throws SentinelIntegrityError on unclosed auto:begin meta at EOF", () => {
    const md = [
      "prose line",
      "<!-- auto:begin meta -->", // line 2
      "body without a close",
    ].join("\n");

    let caught: unknown;
    try {
      parseSentinelBlocks(md);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SentinelIntegrityError);
    expect((caught as SentinelIntegrityError).line).toBe(2);
    expect((caught as Error).message).toMatch(/unclosed|eof/i);
  });

  // (e) nested auto:begin before previous ended
  it("throws on nested auto:begin inside an already-open auto block", () => {
    const md = [
      "<!-- auto:begin meta -->", // line 1
      "some body",
      "<!-- auto:begin phase-summary -->", // line 3 — nested
      "<!-- auto:end phase-summary -->",
      "<!-- auto:end meta -->",
    ].join("\n");

    let caught: unknown;
    try {
      parseSentinelBlocks(md);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SentinelIntegrityError);
    expect((caught as SentinelIntegrityError).line).toBe(3);
  });

  // (f) mismatched kind: auto:begin meta → auto:end phase-summary
  it("throws on auto:end with mismatched kind", () => {
    const md = [
      "<!-- auto:begin meta -->", // line 1
      "body",
      "<!-- auto:end phase-summary -->", // line 3
    ].join("\n");

    let caught: unknown;
    try {
      parseSentinelBlocks(md);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SentinelIntegrityError);
    expect((caught as SentinelIntegrityError).line).toBe(3);
    expect((caught as Error).message).toMatch(/mismatch|kind/i);
  });

  // (g) valid entry date accepted, invalid date rejected
  it("accepts entry:YYYY-MM-DD with a valid ISO date", () => {
    const md = [
      "<!-- auto:begin entry:2026-04-11 -->",
      "Intent / Reality / Significance / Lesson",
      "<!-- source_commits: [abc1234] -->",
      "<!-- auto:end entry:2026-04-11 -->",
    ].join("\n");

    const blocks = parseSentinelBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("entry:2026-04-11");
  });

  it("rejects entry:YYYY-MM-DD with an invalid ISO date (2026-13-99)", () => {
    const md = [
      "<!-- auto:begin entry:2026-13-99 -->", // line 1 — invalid month + day
      "body",
      "<!-- source_commits: [abc1234] -->",
      "<!-- auto:end entry:2026-13-99 -->",
    ].join("\n");

    let caught: unknown;
    try {
      parseSentinelBlocks(md);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SentinelIntegrityError);
    expect((caught as SentinelIntegrityError).line).toBe(1);
    expect((caught as Error).message).toMatch(/date|entry/i);
  });

  // (h) source_commits footer required on entry blocks
  it("throws when an entry: block is missing the source_commits footer", () => {
    const md = [
      "<!-- auto:begin entry:2026-04-11 -->", // line 1
      "Intent / Reality / Significance / Lesson",
      "no source_commits line here",
      "<!-- auto:end entry:2026-04-11 -->", // line 4
    ].join("\n");

    let caught: unknown;
    try {
      parseSentinelBlocks(md);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SentinelIntegrityError);
    // line points at startLine of the offending entry
    expect((caught as SentinelIntegrityError).line).toBe(1);
    expect((caught as Error).message).toMatch(/source_commits/i);
  });

  // (i) unknown auto:begin kind treated as prose (parser tolerant)
  it("treats unknown auto:begin kind as prose (no throw, no block)", () => {
    const md = [
      "<!-- auto:begin totally-bogus-kind -->",
      "not actually a sentinel per parser's taste",
      "<!-- auto:end totally-bogus-kind -->",
    ].join("\n");

    const blocks = parseSentinelBlocks(md);
    expect(blocks).toHaveLength(0);
  });

  // Extra: empty string produces no blocks, does not throw
  it("returns empty array for empty content", () => {
    expect(parseSentinelBlocks("")).toEqual([]);
  });

  // Extra: stray auto:end with nothing open — throws
  it("throws on stray auto:end with no matching begin", () => {
    const md = [
      "prose",
      "<!-- auto:end meta -->", // line 2
    ].join("\n");

    let caught: unknown;
    try {
      parseSentinelBlocks(md);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SentinelIntegrityError);
    expect((caught as SentinelIntegrityError).line).toBe(2);
  });
});

describe("computeBlockHash", () => {
  // (c) SHA-256 after LF normalisation + trailing whitespace strip.
  // Frozen hash was computed independently via Node crypto, NOT derived from
  // the impl under test.
  it("matches a frozen SHA-256 after normalisation (CRLF → LF, trailing ws stripped)", () => {
    expect(computeBlockHash(MESSY_INPUT)).toBe(FROZEN_HASH);
  });

  it("produces the same hash for already-normalised content (idempotent)", () => {
    expect(computeBlockHash(FROZEN_NORMALISED)).toBe(FROZEN_HASH);
  });

  it("produces a different hash for different content (sanity)", () => {
    const other = computeBlockHash("different content\n");
    expect(other).toMatch(/^[0-9a-f]{64}$/);
    expect(other).not.toBe(FROZEN_HASH);
  });
});

describe("SentinelIntegrityError", () => {
  it("stores the line number as a readonly property and includes it in the message", () => {
    const err = new SentinelIntegrityError("boom", 42);
    expect(err).toBeInstanceOf(Error);
    expect(err.line).toBe(42);
    expect(err.message).toContain("42");
  });
});
