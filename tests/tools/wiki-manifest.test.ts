import { describe, it, expect } from "vitest";
import {
  buildWikiManifest,
  buildFileToCommunityMap,
  buildUniqueSlugs,
  type WikiManifest,
  type PageInfo,
  type WikiManifestV2,
  type ProjectOverview,
  type ModuleMetadata,
  type DependencySummary,
  type KeyExport,
  type ModuleRole,
  type JournalPageEntry,
  type JournalPageKind,
} from "../../src/tools/wiki-manifest.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv from "ajv";
import type { CommunityInfo } from "../../src/tools/wiki-surprise.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const communities: CommunityInfo[] = [
  { name: "Auth Service", files: ["src/auth/login.ts", "src/auth/token.ts", "src/auth/session.ts"], size: 3 },
  { name: "Data Layer", files: ["src/db/query.ts", "src/db/models.ts", "src/db/migrate.ts"], size: 3 },
];

const pages: PageInfo[] = [
  {
    slug: "auth-service",
    title: "Auth Service",
    type: "community",
    file: "wiki/auth-service.md",
    content: "# Auth Service\n\nHandles login and [[data-layer]] integration.\n" + "x".repeat(400),
  },
  {
    slug: "data-layer",
    title: "Data Layer",
    type: "community",
    file: "wiki/data-layer.md",
    content: "# Data Layer\n\nProvides [[auth-service]] with user records.\n" + "y".repeat(200),
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildUniqueSlugs", () => {
  it("assigns a unique slug per community name without collisions", () => {
    const slugs = buildUniqueSlugs([
      { name: "Auth/API" },
      { name: "Auth API" },
      { name: "Auth  API" },
    ]);
    expect(slugs.get("Auth/API")).toBe("auth-api");
    expect(slugs.get("Auth API")).toBe("auth-api-2");
    expect(slugs.get("Auth  API")).toBe("auth-api-3");
  });

  it("falls back to 'community' base when toSlug produces empty string", () => {
    const slugs = buildUniqueSlugs([{ name: "!!!" }, { name: "   " }]);
    expect(slugs.get("!!!")).toBe("community");
    expect(slugs.get("   ")).toBe("community-2");
  });

  it("monorepo: prepends workspace path to disambiguate communities under same directory", () => {
    const slugs = buildUniqueSlugs(
      [
        { name: "Web Utils", files: ["apps/web/src/utils/a.ts"] },
        { name: "Api Utils", files: ["apps/api/src/utils/b.ts"] },
      ],
      { monorepo: true, workspaces: ["apps/web", "apps/api"] },
    );
    expect(slugs.get("Web Utils")).toBe("apps-web-web-utils");
    expect(slugs.get("Api Utils")).toBe("apps-api-api-utils");
  });
});

describe("buildFileToCommunityMap with collisions", () => {
  it("preserves both communities' files when names collide at toSlug level", () => {
    const colliding: CommunityInfo[] = [
      { name: "Auth/API", files: ["src/a/one.ts"], size: 1 },
      { name: "Auth API", files: ["src/b/two.ts"], size: 1 },
    ];
    const map = buildFileToCommunityMap(colliding);
    expect(map["src/a/one.ts"]).toBe("auth-api");
    expect(map["src/b/two.ts"]).toBe("auth-api-2");
  });
});

describe("buildFileToCommunityMap", () => {
  it("maps every file from every community to its community slug (6 entries for 2x3)", () => {
    const map = buildFileToCommunityMap(communities);

    expect(Object.keys(map)).toHaveLength(6);

    // Community "Auth Service" → slug "auth-service"
    expect(map["src/auth/login.ts"]).toBe("auth-service");
    expect(map["src/auth/token.ts"]).toBe("auth-service");
    expect(map["src/auth/session.ts"]).toBe("auth-service");

    // Community "Data Layer" → slug "data-layer"
    expect(map["src/db/query.ts"]).toBe("data-layer");
    expect(map["src/db/models.ts"]).toBe("data-layer");
    expect(map["src/db/migrate.ts"]).toBe("data-layer");
  });
});

describe("buildWikiManifest", () => {
  it("returns object with all required fields", () => {
    const manifest = buildWikiManifest({
      index_hash: "abc123",
      git_commit: "def456",
      pages,
      communities,
    });

    // generated_at: ISO string
    expect(manifest.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // index_hash and git_commit preserved
    expect(manifest.index_hash).toBe("abc123");
    expect(manifest.git_commit).toBe("def456");

    // pages array
    expect(Array.isArray(manifest.pages)).toBe(true);
    expect(manifest.pages).toHaveLength(2);

    // slug_redirects object
    expect(typeof manifest.slug_redirects).toBe("object");
    expect(manifest.slug_redirects).not.toBeNull();

    // token_estimates object
    expect(typeof manifest.token_estimates).toBe("object");

    // file_to_community object
    expect(typeof manifest.file_to_community).toBe("object");

    // degraded boolean
    expect(typeof manifest.degraded).toBe("boolean");

    // degraded_reasons: undefined when no failures
    expect(manifest.degraded_reasons).toBeUndefined();
  });

  it("slug_redirects merges old redirects and adds redirect for renamed slugs", () => {
    const oldManifest: WikiManifest = {
      generated_at: "2026-01-01T00:00:00.000Z",
      index_hash: "old123",
      git_commit: "old456",
      pages: [
        {
          slug: "old-auth",
          title: "Old Auth",
          type: "community",
          file: "wiki/old-auth.md",
          outbound_links: [],
        },
      ],
      slug_redirects: { "old-auth": "src-auth" },
      token_estimates: {},
      file_to_community: {},
      degraded: false,
    };

    const manifest = buildWikiManifest({
      index_hash: "new123",
      git_commit: "new456",
      pages,
      communities,
      oldManifest,
    });

    // Old redirect entry preserved
    expect(manifest.slug_redirects["old-auth"]).toBe("src-auth");
  });

  it("token_estimates populated for each page with positive numbers", () => {
    const manifest = buildWikiManifest({
      index_hash: "abc123",
      git_commit: "def456",
      pages,
      communities,
    });

    expect(manifest.token_estimates["auth-service"]).toBeGreaterThan(0);
    expect(manifest.token_estimates["data-layer"]).toBeGreaterThan(0);
    expect(typeof manifest.token_estimates["auth-service"]).toBe("number");
    expect(typeof manifest.token_estimates["data-layer"]).toBe("number");
  });

  it("degraded=true when degradedReasons is non-empty", () => {
    const manifest = buildWikiManifest({
      index_hash: "abc123",
      git_commit: "def456",
      pages,
      communities,
      degradedReasons: ["community_detection_timeout"],
    });

    expect(manifest.degraded).toBe(true);
    expect(manifest.degraded_reasons).toEqual(["community_detection_timeout"]);
  });

  it("degraded=false and degraded_reasons is undefined when no failures", () => {
    const manifest = buildWikiManifest({
      index_hash: "abc123",
      git_commit: "def456",
      pages,
      communities,
    });

    expect(manifest.degraded).toBe(false);
    expect(manifest.degraded_reasons).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WikiManifestV2 shape + JSON Schema validation (Task 2)
// ---------------------------------------------------------------------------

function makeSampleV2(): WikiManifestV2 {
  const project: ProjectOverview = {
    name: "sample",
    git_remote: "https://github.com/acme/sample.git",
    project_type: "single",
    stack: {
      language: "typescript",
      language_version: "5.4",
      framework: null,
      framework_version: null,
      test_runner: "vitest",
      package_manager: "pnpm",
      build_tool: "tsc",
    },
    scripts: { test: "vitest run", build: "tsc" },
    entry_points: ["src/index.ts"],
    workspaces: [],
    dependencies: {
      prod_total: 3,
      dev_total: 5,
      key: [{ name: "vitest", version: "^1.0.0", kind: "dev" }],
    },
    known_gotchas: [{ gotcha: "uses monkey-patched globals", severity: "medium" }],
    stats: { total_files: 42, total_commits: 100, contributors: 3 },
  };
  const mod: ModuleMetadata = {
    slug: "core",
    name: "Core",
    description: "Shared core utilities.",
    role: "core-library",
    files: 5,
    cohesion: 0.82,
    key_exports: [
      { name: "parse", kind: "function", file: "src/core/parse.ts", signature: "parse(s: string): Result" },
    ],
    depends_on: [],
    depended_by: ["cli"],
    has_hotspot: false,
  };
  return {
    schema_version: 2,
    manifest_schema_version: "2.1.0",
    generated_at: "2026-04-20T00:00:00Z",
    index_hash: "abc",
    git_commit: "def",
    project,
    modules: [mod],
    pages: [],
    slug_redirects: {},
    token_estimates: {},
    file_to_community: {},
    degraded: false,
  };
}

describe("WikiManifestV2 types", () => {
  it("constructs a minimal v2 manifest with schema_version, project, modules", () => {
    const m = makeSampleV2();
    expect(m.schema_version).toBe(2);
    expect(typeof m.project).toBe("object");
    expect(m.project.name).toBe("sample");
    expect(m.project.stack.language).toBe("typescript");
    expect(m.project.dependencies.prod_total).toBe(3);
    expect(Array.isArray(m.modules)).toBe(true);
    expect(m.modules[0]!.role).toBe("core-library");
    expect(m.modules[0]!.key_exports[0]!.kind).toBe("function");
  });

  it("accepts all ModuleRole union values", () => {
    const roles: ModuleRole[] = [
      "framework-tools", "framework-routes", "framework-components",
      "core-library", "data-access", "utilities", "parsers",
      "storage", "search", "cli", "tests", "scripts",
      "micro-module", "unknown",
    ];
    expect(roles).toHaveLength(14);
  });

  it("allows optional key_exports_approximate and workspace fields", () => {
    const m = makeSampleV2();
    m.modules[0]!.key_exports_approximate = true;
    m.modules[0]!.workspace = "apps/web";
    expect(m.modules[0]!.key_exports_approximate).toBe(true);
    expect(m.modules[0]!.workspace).toBe("apps/web");
  });
});

describe("wiki-manifest-v2.schema.json", () => {
  it("validates a minimal sample manifest", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = resolve(here, "../../schemas/wiki-manifest-v2.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const sample = makeSampleV2();
    const ok = validate(sample);
    if (!ok) {
      throw new Error("schema validation failed: " + JSON.stringify(validate.errors));
    }
    expect(ok).toBe(true);
  });

  it("rejects a manifest missing schema_version", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = resolve(here, "../../schemas/wiki-manifest-v2.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const sample = makeSampleV2();
    const broken = { ...sample } as Partial<WikiManifestV2>;
    delete (broken as { schema_version?: number }).schema_version;
    expect(validate(broken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manifest v2.1: JournalPageEntry union + manifest_schema_version (Task 4)
// ---------------------------------------------------------------------------

describe("buildWikiManifest v2.1 journal pages", () => {
  it("(a) accepts journalPages parameter and emits them alongside existing pages", () => {
    const journalPages: JournalPageEntry[] = [
      {
        slug: "journal-index",
        title: "Journal",
        type: "journal-overview",
        file: "journal/index.md",
        outbound_links: ["phase-week-2026-03"],
        source: "generated",
      },
    ];
    const manifest = buildWikiManifest({
      index_hash: "abc123",
      git_commit: "def456",
      pages,
      communities,
      journalPages,
    });

    // Regular pages still present
    expect(manifest.pages).toHaveLength(3);
    const slugs = manifest.pages.map((p) => p.slug);
    expect(slugs).toContain("auth-service");
    expect(slugs).toContain("data-layer");
    expect(slugs).toContain("journal-index");

    const journalEntry = manifest.pages.find((p) => p.slug === "journal-index");
    expect(journalEntry).toBeDefined();
    expect(journalEntry!.type).toBe("journal-overview");
  });

  it("(b) emits top-level manifest_schema_version = '2.1.0'", () => {
    const manifest = buildWikiManifest({
      index_hash: "abc123",
      git_commit: "def456",
      pages,
      communities,
    });
    expect(manifest.manifest_schema_version).toBe("2.1.0");
  });

  it("(b) emits manifest_schema_version even when journalPages is omitted", () => {
    const manifest = buildWikiManifest({
      index_hash: "h",
      git_commit: "g",
      pages: [],
      communities: [],
    });
    expect(manifest.manifest_schema_version).toBe("2.1.0");
  });

  it("(c) round-trips a journal-phase entry with all optional fields unchanged", () => {
    const entry: JournalPageEntry = {
      slug: "phase-week-2026-03",
      title: "Week of March 2026",
      type: "journal-phase",
      file: "journal/phase-week-2026-03.md",
      outbound_links: ["index", "phase-week-2026-04"],
      source: "ai-authored",
      journal_content_hashes: { "phase-summary": "abc123def456abc123def456abc123def456abc1" },
    };

    const manifest = buildWikiManifest({
      index_hash: "h",
      git_commit: "g",
      pages: [],
      communities: [],
      journalPages: [entry],
    });

    expect(manifest.pages).toHaveLength(1);
    const out = manifest.pages[0]!;
    expect(out.slug).toBe("phase-week-2026-03");
    expect(out.title).toBe("Week of March 2026");
    expect(out.type).toBe("journal-phase");
    expect(out.file).toBe("journal/phase-week-2026-03.md");
    expect(out.outbound_links).toEqual(["index", "phase-week-2026-04"]);

    // Narrow union via discriminant to access journal-only fields
    if (
      out.type === "journal-phase" ||
      out.type === "journal-overview" ||
      out.type === "journal-rollup"
    ) {
      expect(out.source).toBe("ai-authored");
      expect(out.journal_content_hashes).toEqual({
        "phase-summary": "abc123def456abc123def456abc123def456abc1",
      });
    } else {
      throw new Error("expected journal-phase entry discriminant");
    }
  });

  it("(d) preserves optional parent_slug on weekly child phases", () => {
    const entry: JournalPageEntry = {
      slug: "phase-week-2026-03-15",
      title: "Week of 2026-03-15",
      type: "journal-phase",
      file: "journal/phase-week-2026-03-15.md",
      outbound_links: [],
      source: "ai-authored",
      parent_slug: "phase-week-2026-03",
    };

    const manifest = buildWikiManifest({
      index_hash: "h",
      git_commit: "g",
      pages: [],
      communities: [],
      journalPages: [entry],
    });

    const out = manifest.pages[0]!;
    if (
      out.type === "journal-phase" ||
      out.type === "journal-overview" ||
      out.type === "journal-rollup"
    ) {
      expect(out.parent_slug).toBe("phase-week-2026-03");
    } else {
      throw new Error("expected journal-phase entry discriminant");
    }
  });

  it("exercises all 3 JournalPageKind literals (Q11)", () => {
    const kinds: JournalPageKind[] = ["journal-overview", "journal-rollup", "journal-phase"];
    expect(kinds).toHaveLength(3);
    const journalPages: JournalPageEntry[] = kinds.map((k, i) => ({
      slug: `j-${i}`,
      title: `Journal ${i}`,
      type: k,
      file: `journal/j-${i}.md`,
      outbound_links: [],
      source: "generated",
    }));
    const manifest = buildWikiManifest({
      index_hash: "h",
      git_commit: "g",
      pages: [],
      communities: [],
      journalPages,
    });
    const outKinds = manifest.pages.map((p) => p.type);
    expect(outKinds).toEqual(["journal-overview", "journal-rollup", "journal-phase"]);
  });
});

describe("wiki-manifest-v2.schema.json v2.1 extensions", () => {
  function loadSchema(): unknown {
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = resolve(here, "../../schemas/wiki-manifest-v2.schema.json");
    return JSON.parse(readFileSync(schemaPath, "utf-8"));
  }

  it("(e) validates the hand-crafted v2.1 example fixture", () => {
    const schema = loadSchema();
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturePath = resolve(here, "../fixtures/wiki-manifest-v2.1-example.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(fixture);
    if (!ok) {
      throw new Error("v2.1 fixture validation failed: " + JSON.stringify(validate.errors));
    }
    expect(ok).toBe(true);
  });

  it("rejects a manifest missing manifest_schema_version", () => {
    const schema = loadSchema();
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const sample = makeSampleV2();
    const broken = { ...sample } as Partial<WikiManifestV2>;
    delete (broken as { manifest_schema_version?: string }).manifest_schema_version;
    expect(validate(broken)).toBe(false);
  });

  it("accepts pages with new journal type literals and optional fields", () => {
    const schema = loadSchema();
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const sample = makeSampleV2();
    const withJournal = {
      ...sample,
      pages: [
        {
          slug: "phase-week-2026-03",
          title: "Week of March 2026",
          type: "journal-phase",
          file: "journal/phase-week-2026-03.md",
          outbound_links: [],
          source: "ai-authored",
          journal_content_hashes: { "phase-summary": "abc123" },
          parent_slug: "journal-index",
        },
      ],
    };
    const ok = validate(withJournal);
    if (!ok) {
      throw new Error("journal page schema validation failed: " + JSON.stringify(validate.errors));
    }
    expect(ok).toBe(true);
  });
});
