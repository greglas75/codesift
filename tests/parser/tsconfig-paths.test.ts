import { describe, it, expect, beforeEach } from "vitest";
import { join, resolve } from "node:path";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
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

describe("resolveTsAliasedImport — error handling", () => {
  let tmp: string;

  beforeEach(() => {
    clearTsconfigCache();
    tmp = mkdtempSync(join(tmpdir(), "tsconfig-test-"));
  });

  it("returns null + warns when tsconfig.json is malformed", () => {
    writeFileSync(
      join(tmp, "tsconfig.json"),
      `{ "compilerOptions": { "paths": INVALID }, }`,
    );
    writeFileSync(join(tmp, "x.ts"), "");
    const result = resolveTsAliasedImport(
      join(tmp, "x.ts"),
      "@x/foo",
      tmp,
    );
    expect(result).toBeNull();
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
