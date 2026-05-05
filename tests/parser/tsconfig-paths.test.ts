import { describe, it, expect, beforeEach, vi } from "vitest";
import { join, resolve } from "node:path";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  resolveTsAliasedImport,
  clearTsconfigCache,
} from "../../src/utils/tsconfig-paths.js";

const FIXTURE = resolve(__dirname, "../fixtures/tsconfig-monorepo");

describe("resolveTsAliasedImport — monorepo fixture", () => {
  beforeEach(() => clearTsconfigCache());

  it("resolves `@shared/utils` from packages/foo/src/x.ts via extends chain", () => {
    const importer = join(FIXTURE, "packages/foo/src/x.ts");
    const result = resolveTsAliasedImport(importer, "@shared/utils", FIXTURE);
    expect(result).not.toBeNull();
    expect(result).toBe(join(FIXTURE, "packages/shared/utils.ts"));
  });

  it("resolves `@components/Button` to index.ts, NOT the directory", () => {
    // Regression guard for the empty-string probe + isFile() gate.
    const importer = join(FIXTURE, "packages/foo/src/x.ts");
    const result = resolveTsAliasedImport(importer, "@components/Button", FIXTURE);
    expect(result).not.toBeNull();
    expect(result).toBe(join(FIXTURE, "packages/components/Button/index.ts"));
    // Sanity: result must be a file path ending in index.ts, not the dir.
    expect(result?.endsWith("/Button")).toBe(false);
  });

  it("resolves exact-file alias `@app/exact` to the literal .ts target", () => {
    const importer = join(FIXTURE, "packages/foo/src/x.ts");
    const result = resolveTsAliasedImport(importer, "@app/exact", FIXTURE);
    expect(result).toBe(join(FIXTURE, "packages/foo/src/exact-target.ts"));
  });

  it("returns null for unknown alias", () => {
    const importer = join(FIXTURE, "packages/foo/src/x.ts");
    expect(
      resolveTsAliasedImport(importer, "@unknown/x", FIXTURE),
    ).toBeNull();
  });

  it("short-circuits on relative imports without consulting tsconfig", () => {
    const importer = join(FIXTURE, "packages/foo/src/x.ts");
    expect(resolveTsAliasedImport(importer, "./relative", FIXTURE)).toBeNull();
    expect(resolveTsAliasedImport(importer, "../parent", FIXTURE)).toBeNull();
  });
});

describe("resolveTsAliasedImport — security + cache", () => {
  beforeEach(() => clearTsconfigCache());

  it("returns null for absolute import specifiers", () => {
    const importer = join(FIXTURE, "packages/foo/src/x.ts");
    expect(resolveTsAliasedImport(importer, "/etc/passwd", FIXTURE)).toBeNull();
  });

  it("does not reuse nearest-tsconfig cache across different repoRoot boundaries", () => {
    const base = mkdtempSync(join(tmpdir(), "tsconfig-root-cache-"));
    mkdirSync(join(base, "repo/sub/deep"), { recursive: true });
    writeFileSync(
      join(base, "repo/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@app/*": ["./*.ts"] },
        },
      }),
    );
    writeFileSync(join(base, "repo/root-hit.ts"), "export const x = 1;");
    writeFileSync(join(base, "repo/sub/deep/x.ts"), "");
    const importer = join(base, "repo/sub/deep/x.ts");
    const wideRoot = join(base, "repo");
    const narrowRoot = join(base, "repo/sub");

    expect(
      resolveTsAliasedImport(importer, "@app/root-hit", wideRoot),
    ).toBe(join(base, "repo/root-hit.ts"));

    expect(
      resolveTsAliasedImport(importer, "@app/root-hit", narrowRoot),
    ).toBeNull();
  });

  it("resolves paths targets that use .mts extension", () => {
    const base = mkdtempSync(join(tmpdir(), "tsconfig-mts-"));
    writeFileSync(
      join(base, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@mod": ["./lib"] },
        },
      }),
    );
    writeFileSync(join(base, "lib.mts"), "export {}");
    writeFileSync(join(base, "importer.ts"), "");
    expect(resolveTsAliasedImport(join(base, "importer.ts"), "@mod", base)).toBe(
      join(base, "lib.mts"),
    );
  });
});

describe("resolveTsAliasedImport — error handling", () => {
  let tmp: string;

  beforeEach(() => {
    clearTsconfigCache();
    tmp = mkdtempSync(join(tmpdir(), "tsconfig-test-"));
  });

  it("returns null and logs when tsconfig.json is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "*": 123 },
        },
      }),
    );
    writeFileSync(join(tmp, "x.ts"), "");
    const result = resolveTsAliasedImport(
      join(tmp, "x.ts"),
      "@x/foo",
      tmp,
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("tsconfig-paths");
    warn.mockRestore();
  });

  it("returns null when no tsconfig.json found in walk-up", () => {
    writeFileSync(join(tmp, "x.ts"), "");
    expect(
      resolveTsAliasedImport(join(tmp, "x.ts"), "@x/foo", tmp),
    ).toBeNull();
  });

  it("does NOT hang on cyclic extends chain", () => {
    const a = join(tmp, "tsconfig.json");
    const b = join(tmp, "tsconfig.b.json");
    writeFileSync(a, `{ "extends": "./tsconfig.b.json" }`);
    writeFileSync(b, `{ "extends": "./tsconfig.json" }`);
    writeFileSync(join(tmp, "x.ts"), "");

    const start = Date.now();
    const result = resolveTsAliasedImport(
      join(tmp, "x.ts"),
      "@x/foo",
      tmp,
    );
    const elapsed = Date.now() - start;
    // get-tsconfig has its own visited-set; should fail fast either way.
    expect(elapsed).toBeLessThan(5000);
    expect(result).toBeNull();
  });
});
