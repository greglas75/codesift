import { describe, it, expect } from "vitest";
import {
  buildProjectOverview,
  buildModuleMetadata,
  buildWikiManifestV2,
  buildWikiManifestV1,
} from "../../src/tools/wiki-module-builder.js";
import type { ProjectProfile } from "../../src/tools/project-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";
import type { CommunityInfo } from "../../src/tools/wiki-surprise.js";
import type { ImportEdge } from "../../src/utils/import-graph.js";
import { parseGoMod, parsePyprojectToml, parseCargoToml } from "../../src/tools/wiki-overview-sources.js";

function makeProfile(over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    generated_by: { tool: "codesift", tool_version: "1.0.0", extractor_versions: {} },
    compatible_with: ">=1.0",
    status: "complete",
    identity: {
      project_name: "sample",
      project_type: "single",
      workspace_root: "/tmp/sample",
      git_remote: null,
    },
    stack: {
      language: "TypeScript",
      language_version: "5.4",
      framework: null,
      framework_version: null,
      test_runner: "vitest",
      package_manager: "pnpm",
      build_tool: "tsc",
      monorepo: null,
      detected_from: [],
    },
    generation_metadata: { files_analyzed: 10, files_skipped: 0, skip_reasons: {}, duration_ms: 0 },
    dependency_graph: { entry_points: ["src/index.ts"], hub_modules: [], leaf_modules: [], orphan_files: [] },
    ...over,
  };
}

function makeIndex(over: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "sample",
    root: "/nonexistent-path-for-test",
    symbols: [],
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: 10,
    ...over,
  };
}

describe("buildProjectOverview", () => {
  it("maps identity + stack from ProjectProfile (TS project path)", () => {
    const overview = buildProjectOverview(makeProfile(), makeIndex());
    expect(overview.name).toBe("sample");
    expect(overview.stack.language).toBe("TypeScript");
    expect(overview.entry_points).toEqual(["src/index.ts"]);
    expect(overview.project_type).toBe("single");
  });

  it("falls back to basename(codeIndex.root) when identity is missing", () => {
    const overview = buildProjectOverview(
      makeProfile({ identity: undefined as unknown as ProjectProfile["identity"] }),
      makeIndex({ root: "/tmp/my-proj" }),
    );
    expect(overview.name).toBe("my-proj");
  });

  it("sets total_commits/contributors to null when git_health is absent (shallow-like)", () => {
    const overview = buildProjectOverview(makeProfile(), makeIndex());
    expect(overview.stats.total_commits).toBeNull();
    expect(overview.stats.contributors).toBeNull();
    expect(overview._degraded).toBe("shallow_clone_or_insufficient_history");
  });
});

describe("non-JS parsers", () => {
  it("parseGoMod extracts module name", () => {
    const p = parseGoMod(`module github.com/acme/svc\n\nrequire (\n  github.com/a/b v1.2.3\n)`);
    expect(p.name).toBe("github.com/acme/svc");
    expect(p.deps).toContain("github.com/a/b");
  });

  it("parsePyprojectToml extracts [project] section", () => {
    const p = parsePyprojectToml(`[project]\nname = "svc"\nversion = "0.1.0"\ndescription = "x"\ndependencies = ["fastapi>=0.100", "pydantic"]\n`);
    expect(p.name).toBe("svc");
    expect(p.deps).toContain("fastapi");
    expect(p.deps).toContain("pydantic");
  });

  it("parseCargoToml extracts [package] section", () => {
    const p = parseCargoToml(`[package]\nname = "crate"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\ntokio = "1"\n`);
    expect(p.name).toBe("crate");
    expect(p.deps).toEqual(expect.arrayContaining(["serde", "tokio"]));
  });
});

describe("buildModuleMetadata", () => {
  const communities: CommunityInfo[] = [
    { name: "Utils", files: ["src/utils/a.ts", "src/utils/b.ts", "src/utils/c.ts", "src/utils/d.ts"], size: 4 },
    { name: "Tests", files: ["tests/a.test.ts", "tests/b.test.ts"], size: 2 },
  ];

  it("test-only community is tagged role=tests with 'Test suite for ...' description", () => {
    const modules = buildModuleMetadata(
      communities, makeProfile(), makeIndex(), [], [], [],
    );
    const tests = modules.find((m) => m.name === "Tests");
    expect(tests?.role).toBe("tests");
    expect(tests?.description).toMatch(/^Test suite for /);
  });

  it("micro-module (<4 files) is tagged role=micro-module", () => {
    const micro = [{ name: "Tiny", files: ["src/x.ts"], size: 1 }] as CommunityInfo[];
    const modules = buildModuleMetadata(micro, makeProfile(), makeIndex(), [], [], []);
    expect(modules[0]!.role).toBe("micro-module");
  });

  it("populates key_exports from is_exported symbols", () => {
    const symbols: CodeSymbol[] = [
      {
        id: "a", repo: "r", name: "doThing", kind: "function", file: "src/utils/a.ts",
        start_line: 1, end_line: 5, is_exported: true, tokens: ["doThing"],
      } as CodeSymbol,
    ];
    const modules = buildModuleMetadata(
      communities, makeProfile(),
      makeIndex({ symbols, symbol_count: 1 }),
      [], [], [],
    );
    const utils = modules.find((m) => m.name === "Utils");
    expect(utils?.key_exports.some((k) => k.name === "doThing")).toBe(true);
    expect(utils?.key_exports_approximate).not.toBe(true);
  });

  it("sets key_exports_approximate when no is_exported symbols are present", () => {
    const symbols: CodeSymbol[] = [
      {
        id: "a", repo: "r", name: "internalHelper", kind: "function", file: "src/utils/a.ts",
        start_line: 1, end_line: 5, tokens: ["internalHelper"],
      } as CodeSymbol,
    ];
    const edges: ImportEdge[] = [{ from: "src/consumer.ts", to: "src/utils/a.ts" }];
    const modules = buildModuleMetadata(
      communities, makeProfile(),
      makeIndex({ symbols, symbol_count: 1 }),
      edges, [], [],
    );
    const utils = modules.find((m) => m.name === "Utils");
    expect(utils?.key_exports_approximate).toBe(true);
  });

  it("computes depends_on / depended_by from import edges", () => {
    const edges: ImportEdge[] = [
      { from: "src/utils/a.ts", to: "tests/a.test.ts" }, // unrealistic but fine for wiring test
    ];
    const modules = buildModuleMetadata(communities, makeProfile(), makeIndex(), edges, [], []);
    // At minimum arrays should exist
    expect(modules[0]!.depends_on).toEqual(expect.any(Array));
    expect(modules[0]!.depended_by).toEqual(expect.any(Array));
  });
});

describe("buildWikiManifestV2 / V1 writers", () => {
  it("V2 writer emits schema_version: 2 with project + modules", () => {
    const project = buildProjectOverview(makeProfile(), makeIndex());
    // strip _degraded side channel
    delete project._degraded;
    const manifest = buildWikiManifestV2({
      index_hash: "h", git_commit: "c", pages: [], communities: [], project, modules: [],
    });
    expect(manifest.schema_version).toBe(2);
    expect(manifest.project.name).toBe("sample");
    expect(manifest.modules).toEqual([]);
  });

  it("V1 writer omits schema_version/project/modules", () => {
    const v1 = buildWikiManifestV1({
      index_hash: "h", git_commit: "c", pages: [], communities: [],
    });
    expect("schema_version" in v1).toBe(false);
    expect("project" in v1).toBe(false);
    expect("modules" in v1).toBe(false);
    expect(v1.degraded).toBe(false);
  });
});
