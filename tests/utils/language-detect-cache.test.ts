// The language scan has one caller — registerTools — and in the shared HTTP daemon a server is
// constructed per REQUEST, so an uncached scan ran on every MCP call including `initialize`.
// Measured on a first connect to an untouched worktree: 8.7 s / 21.7 s / 51.9 s, against 0.1 s for
// the listTools right after. A client whose initialize outlives its own timeout spends the whole
// session with no CodeSift tools, which is exactly what agents were reporting.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProjectLanguagesSync,
  resetLanguageDetectionCache,
} from "../../src/utils/language-detect.js";

let root: string;

beforeEach(() => {
  resetLanguageDetectionCache();
  root = mkdtempSync(join(tmpdir(), "lang-cache-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("detectProjectLanguagesSync caching", () => {
  it("does not re-walk the tree on a second call", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.py"), "x = 1\n");

    const first = detectProjectLanguagesSync(root);
    expect(first.python).toBe(true);

    // Deleting the tree is the strongest available probe: an uncached call would walk a directory
    // that no longer exists and report nothing, so an unchanged answer can only come from a cache.
    rmSync(join(root, "src"), { recursive: true, force: true });
    expect(detectProjectLanguagesSync(root)).toEqual(first);
  });

  it("keeps roots independent", () => {
    const other = mkdtempSync(join(tmpdir(), "lang-cache-b-"));
    try {
      writeFileSync(join(root, "a.py"), "x = 1\n");
      writeFileSync(join(other, "a.rs"), "fn main() {}\n");

      expect(detectProjectLanguagesSync(root).python).toBe(true);
      expect(detectProjectLanguagesSync(other).rust).toBe(true);
      expect(detectProjectLanguagesSync(other).python).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("re-scans after the cache is reset", () => {
    writeFileSync(join(root, "a.py"), "x = 1\n");
    expect(detectProjectLanguagesSync(root).rust).toBe(false);

    writeFileSync(join(root, "b.rs"), "fn main() {}\n");
    // Still cached — the point of the TTL is that a new language is noticed late, not never.
    expect(detectProjectLanguagesSync(root).rust).toBe(false);

    resetLanguageDetectionCache();
    expect(detectProjectLanguagesSync(root).rust).toBe(true);
  });

  it("stays bounded — the daemon outlives every repo it has ever seen", () => {
    // 858 repositories are registered on this machine; a map keyed by path with no ceiling is a
    // slow leak wearing a cache's clothes.
    for (let i = 0; i < 300; i++) detectProjectLanguagesSync(join(root, `missing-${i}`));
    // The first root must have been evicted, so it walks again — and now sees the real tree.
    writeFileSync(join(root, "late.py"), "x = 1\n");
    expect(detectProjectLanguagesSync(join(root, "missing-0")).python).toBe(false);
  });
});
