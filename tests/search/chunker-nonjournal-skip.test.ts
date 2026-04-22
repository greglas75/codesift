import { describe, it, expect } from "vitest";
import { shouldSkipChunking } from "../../src/search/chunker.js";

const small = "x".repeat(1_000);
const large55k = "x".repeat(55_000);
const large65k = "x".repeat(65_000);

describe("shouldSkipChunking — journal path override", () => {
  it("(a) user src/ folder named 'journal' is not the wiki journal — .ts still chunked", () => {
    expect(shouldSkipChunking("src/journal/api.ts", small)).toBe(false);
  });

  it("(a') user src/ folder named 'journal' — .md still skipped by extension rule", () => {
    expect(shouldSkipChunking("src/journal/notes.md", small)).toBe(true);
  });

  it("(b) any other path with /journal/ not anchored to .codesift/wiki/journal/ still follows .md rule", () => {
    expect(shouldSkipChunking("backend/journal/notes.md", small)).toBe(true);
  });

  it("(c) .codesift/wiki/journal/ .md under 60KB → chunkable (not skipped)", () => {
    expect(shouldSkipChunking(".codesift/wiki/journal/phases/foo.md", large55k)).toBe(false);
  });

  it("(d) .codesift/wiki/journal/ .md over 60KB → skipped", () => {
    expect(shouldSkipChunking(".codesift/wiki/journal/phases/foo.md", large65k)).toBe(true);
  });

  it("(e) regression: README.md still returns true (plain .md skipped)", () => {
    expect(shouldSkipChunking("README.md", small)).toBe(true);
  });

  it("journal override applies whether leading slash or relative path", () => {
    expect(shouldSkipChunking("/abs/path/.codesift/wiki/journal/phases/bar.md", small)).toBe(false);
    expect(shouldSkipChunking("./.codesift/wiki/journal/overview.md", small)).toBe(false);
  });
});
