import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { isPathWithin } from "../../src/utils/path-within.js";

describe("isPathWithin", () => {
  describe("win32 — the case `startsWith(root + \"/\")` got wrong", () => {
    it("accepts a file inside the root", () => {
      expect(isPathWithin("C:\\Project", "C:\\Project\\modules\\x.php", win32)).toBe(true);
    });

    it("accepts the root itself", () => {
      expect(isPathWithin("C:\\Project", "C:\\Project", win32)).toBe(true);
    });

    it("accepts a drive-letter case difference", () => {
      expect(isPathWithin("C:\\Project", "c:\\project\\modules\\x.php", win32)).toBe(true);
    });

    it("rejects a sibling sharing the prefix", () => {
      expect(isPathWithin("C:\\Project", "C:\\Project2\\x.php", win32)).toBe(false);
    });

    it("rejects another drive", () => {
      expect(isPathWithin("C:\\Project", "D:\\Project\\x.php", win32)).toBe(false);
    });

    it("rejects the parent", () => {
      expect(isPathWithin("C:\\Project\\sub", "C:\\Project", win32)).toBe(false);
    });
  });

  describe("posix", () => {
    it("accepts a file inside and the root itself", () => {
      expect(isPathWithin("/repo", "/repo/src/a.ts", posix)).toBe(true);
      expect(isPathWithin("/repo", "/repo", posix)).toBe(true);
    });

    it("rejects a sibling sharing the prefix and a traversal", () => {
      expect(isPathWithin("/repo", "/repo2/a.ts", posix)).toBe(false);
      expect(isPathWithin("/repo", "/repo/../etc/passwd", posix)).toBe(false);
    });

    it("accepts a child whose name merely starts with two dots", () => {
      expect(isPathWithin("/repo", "/repo/..cache/a.ts", posix)).toBe(true);
    });
  });
});
