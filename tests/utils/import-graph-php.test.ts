import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder, getCodeIndex } from "../../src/tools/index-tools.js";
import { collectImportEdges, extractPhpUseStatements } from "../../src/utils/import-graph.js";
import { resolvePhpNamespace } from "../../src/tools/php-tools.js";

const FIXTURE_ROOT = resolve(join(__dirname, "..", "fixtures", "php-psr4"));

describe("collectImportEdges — PHP PSR-4 resolution", () => {
  beforeAll(async () => {
    // Index the fixture so resolvePhpNamespace can find it via getCodeIndex.
    await indexFolder(FIXTURE_ROOT);
  });

  it("resolvePhpNamespace finds User.php via composer PSR-4 map", async () => {
    const index = await getCodeIndex("local/php-psr4");
    expect(index).not.toBeNull();
    const r = await resolvePhpNamespace("local/php-psr4", "App\\Models\\User");
    expect(r.exists).toBe(true);
    expect(r.file_path).toContain("src/Models/User.php");
  });

  it("creates a cross-file edge from PostController to User via `use App\\Models\\User`", async () => {
    const index = await getCodeIndex("local/php-psr4");
    expect(index).not.toBeNull();
    const edges = await collectImportEdges(index!);
    const edge = edges.find(
      (e) =>
        e.from.includes("PostController.php") &&
        e.to.includes("User.php"),
    );
    expect(edge).toBeDefined();
  });
});

describe("collectImportEdges — PHP edge cases", () => {
  it("gracefully handles vendor FQCN not in PSR-4 map (no edge, no crash)", async () => {
    const r = await resolvePhpNamespace("local/php-psr4", "Vendor\\Package\\Missing");
    expect(r.exists).toBe(false);
    expect(r.psr4_prefix).toBeNull();
  });

  it("does not create self-edges or duplicates for PHP files", async () => {
    const index = await getCodeIndex("local/php-psr4");
    expect(index).not.toBeNull();
    const edges = await collectImportEdges(index!);
    // No self-edges
    for (const e of edges) {
      expect(e.from).not.toBe(e.to);
    }
    // No duplicate from→to pairs
    const seen = new Set<string>();
    for (const e of edges) {
      const key = `${e.from}->${e.to}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("PHP resilience — malformed/missing composer.json", () => {
  const MALFORMED_ROOT = resolve(join(__dirname, "..", "fixtures", "php-malformed-composer"));
  const NO_COMPOSER_ROOT = resolve(join(__dirname, "..", "fixtures", "php-no-composer"));

  it("resolvePhpNamespace returns exists=false on malformed composer.json (no crash)", async () => {
    await indexFolder(MALFORMED_ROOT);
    const r = await resolvePhpNamespace("local/php-malformed-composer", "Something\\Else");
    // readJsonSafe catches JSON.parse errors and returns null, causing psr4 map
    // to be empty → no prefix match → exists=false. Key assertion: no throw.
    expect(r.exists).toBe(false);
    expect(r.psr4_prefix).toBeNull();
  });

  it("collectImportEdges handles repo with no composer.json gracefully", async () => {
    await indexFolder(NO_COMPOSER_ROOT);
    const index = await getCodeIndex("local/php-no-composer");
    expect(index).not.toBeNull();
    // Should not throw when scanning PHP files without a composer.json to resolve against.
    const edges = await collectImportEdges(index!);
    expect(Array.isArray(edges)).toBe(true);
  });
});

describe("extractPhpUseStatements — grouped imports", () => {
  it("expands `use App\\Models\\{User, Post, Comment};` into 3 FQCNs", () => {
    const uses = extractPhpUseStatements(`<?php
use App\\Models\\{User, Post, Comment};
use App\\Services\\AuthService;
`);
    expect(uses).toContain("App\\Models\\User");
    expect(uses).toContain("App\\Models\\Post");
    expect(uses).toContain("App\\Models\\Comment");
    expect(uses).toContain("App\\Services\\AuthService");
    expect(uses).toHaveLength(4);
  });

  it("strips aliases from grouped imports", () => {
    const uses = extractPhpUseStatements(`<?php
use App\\{Foo, Bar as B, Baz as Qux};
`);
    expect(uses).toContain("App\\Foo");
    expect(uses).toContain("App\\Bar");
    expect(uses).toContain("App\\Baz");
    expect(uses).toHaveLength(3);
  });

  it("resolves deeply nested paths inside a group", () => {
    const uses = extractPhpUseStatements(`<?php
use App\\Services\\{Auth\\LoginService, Auth\\LogoutService, Mail\\MailerService};
`);
    expect(uses).toContain("App\\Services\\Auth\\LoginService");
    expect(uses).toContain("App\\Services\\Auth\\LogoutService");
    expect(uses).toContain("App\\Services\\Mail\\MailerService");
    expect(uses).toHaveLength(3);
  });

  it("tolerates extra whitespace around group members", () => {
    const uses = extractPhpUseStatements(`<?php
use App\\Models\\{ User , Post , Comment };
`);
    expect(uses).toContain("App\\Models\\User");
    expect(uses).toContain("App\\Models\\Post");
    expect(uses).toContain("App\\Models\\Comment");
    expect(uses).toHaveLength(3);
  });
});
