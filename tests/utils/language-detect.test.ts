import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProjectLanguages,
  detectProjectLanguagesSync,
} from "../../src/utils/language-detect.js";

function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lang-detect-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("detectProjectLanguages", () => {
  it("detects Python-only project", async () => {
    const root = createProject({
      "myapp/__init__.py": "",
      "myapp/main.py": "def x(): pass",
      "README.md": "# Docs",
    });

    const langs = await detectProjectLanguages(root);
    expect(langs.python).toBe(true);
    expect(langs.php).toBe(false);
    expect(langs.typescript).toBe(false);
  });

  it("detects PHP-only project", async () => {
    const root = createProject({
      "src/User.php": "<?php class User {}",
      "composer.json": "{}",
    });

    const langs = await detectProjectLanguages(root);
    expect(langs.php).toBe(true);
    expect(langs.python).toBe(false);
  });

  it("detects polyglot project", async () => {
    const root = createProject({
      "backend/app.py": "def x(): pass",
      "frontend/index.ts": "const x = 1;",
      "scripts/deploy.go": "package main",
    });

    const langs = await detectProjectLanguages(root);
    expect(langs.python).toBe(true);
    expect(langs.typescript).toBe(true);
    expect(langs.go).toBe(true);
    expect(langs.php).toBe(false);
  });

  it("ignores node_modules, .venv, vendor", async () => {
    const root = createProject({
      "src/index.ts": "const x = 1;",
      "node_modules/foo/index.js": "module.exports = {};",
      ".venv/lib/site-packages/some.py": "x = 1",
      "vendor/bar/lib.php": "<?php",
    });

    const langs = await detectProjectLanguages(root);
    expect(langs.typescript).toBe(true);
    // Dependencies should not count toward detection
    expect(langs.javascript).toBe(false);
    expect(langs.python).toBe(false);
    expect(langs.php).toBe(false);
  });

  it("returns all-false for non-existent directory", async () => {
    const langs = await detectProjectLanguages("/nonexistent/path");
    expect(langs.python).toBe(false);
    expect(langs.php).toBe(false);
  });

  it("sync variant produces identical results", async () => {
    const root = createProject({
      "a.py": "x = 1",
      "b.ts": "const y = 2;",
    });

    const asyncResult = await detectProjectLanguages(root);
    const syncResult = detectProjectLanguagesSync(root);
    expect(syncResult).toEqual(asyncResult);
  });
});

describe("ESM invariant", () => {
  // detectProjectLanguagesSync used to `require("node:fs")`. This package is
  // ESM ("type": "module"), so that threw ReferenceError on every real call;
  // registerTools caught it and fell into its "on failure, enable everything"
  // branch, so requiresLanguage gating was silently dead — every project looked
  // like it contained every language.
  //
  // The unit tests above did NOT catch this: vitest transforms modules and
  // provides a CJS interop shim, so `require` resolves there and only breaks
  // under plain Node. A source-level invariant is the guard that actually holds.
  it("no src module calls require() without createRequire", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { stripCommentsAndStrings } = await import("../../src/utils/source-stripper.js");

    // `require` as a call, not `.require` and not a bare identifier.
    const requireCall = /(?<![\w.$])require\s*\(/;
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = joinPath(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        // Comments and string literals are not calls; strip them first.
        const code = stripCommentsAndStrings(source);
        if (!requireCall.test(code)) continue;
        // `const require = createRequire(import.meta.url)` is the supported way
        // to reach CJS from ESM — those calls are fine.
        if (/createRequire\s*\(/.test(code)) continue;
        offenders.push(full);
      }
    };
    walk("src");

    expect(offenders).toEqual([]);
  });
});
