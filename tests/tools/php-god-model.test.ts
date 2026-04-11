import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two modules that findPhpGodModel depends on so we can feed
// fabricated models + a matching symbol index without touching the filesystem.
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
  // keep other exports stubbed — findPhpGodModel only uses getCodeIndex
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { findPhpGodModel, analyzeActiveRecord } from "../../src/tools/php-tools.js";

function makeClassSym(name: string, file: string, startLine: number, endLine: number) {
  return {
    id: `${file}:${name}:${startLine}`,
    repo: "test",
    name,
    kind: "class" as const,
    file,
    start_line: startLine,
    end_line: endLine,
    start_byte: 0,
    end_byte: 0,
    source: `class ${name} extends ActiveRecord {}`,
    tokens: [name.toLowerCase()],
  };
}

function makeMethodSym(name: string, parent: string, file: string, startLine: number) {
  return {
    id: `${file}:${name}:${startLine}`,
    repo: "test",
    name,
    kind: "method" as const,
    file,
    start_line: startLine,
    end_line: startLine + 3,
    start_byte: 0,
    end_byte: 0,
    source: `public function ${name}() {}`,
    tokens: [name.toLowerCase()],
    parent,
  };
}

describe("findPhpGodModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags models over method threshold", async () => {
    const classA = makeClassSym("ModelA", "models/ModelA.php", 1, 401);
    const methodsA = Array.from({ length: 60 }, (_, i) =>
      makeMethodSym(`method${i}`, classA.id, "models/ModelA.php", 10 + i),
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp/test",
      symbols: [classA, ...methodsA],
      files: [{ path: "models/ModelA.php", language: "php", symbol_count: 61, last_modified: 0 }],
      created_at: 0,
      updated_at: 0,
      symbol_count: 61,
      file_count: 1,
    });

    const r = await findPhpGodModel("test");
    expect(r.total).toBeGreaterThanOrEqual(1);
    const a = r.models.find((m) => m.name === "ModelA");
    expect(a).toBeDefined();
    expect(a!.method_count).toBe(60);
    expect(a!.reasons.some((x) => x.includes("methods"))).toBe(true);
  });

  it("flags models over line threshold even with few methods", async () => {
    const bigClass = makeClassSym("BigModel", "models/BigModel.php", 1, 650);
    const fewMethods = Array.from({ length: 10 }, (_, i) =>
      makeMethodSym(`small${i}`, bigClass.id, "models/BigModel.php", 10 + i),
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp/test",
      symbols: [bigClass, ...fewMethods],
      files: [{ path: "models/BigModel.php", language: "php", symbol_count: 11, last_modified: 0 }],
      created_at: 0,
      updated_at: 0,
      symbol_count: 11,
      file_count: 1,
    });

    const r = await findPhpGodModel("test");
    const big = r.models.find((m) => m.name === "BigModel");
    expect(big).toBeDefined();
    expect(big!.line_count).toBe(649);
    expect(big!.reasons.some((x) => x.includes("lines"))).toBe(true);
  });

  it("does not flag healthy models", async () => {
    const okClass = makeClassSym("OkModel", "models/OkModel.php", 1, 150);
    const okMethods = Array.from({ length: 10 }, (_, i) =>
      makeMethodSym(`ok${i}`, okClass.id, "models/OkModel.php", 10 + i),
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp/test",
      symbols: [okClass, ...okMethods],
      files: [{ path: "models/OkModel.php", language: "php", symbol_count: 11, last_modified: 0 }],
      created_at: 0,
      updated_at: 0,
      symbol_count: 11,
      file_count: 1,
    });

    const r = await findPhpGodModel("test");
    expect(r.models.find((m) => m.name === "OkModel")).toBeUndefined();
  });

  it("respects custom thresholds", async () => {
    const cls = makeClassSym("Small", "models/Small.php", 1, 60);
    const methods = Array.from({ length: 12 }, (_, i) =>
      makeMethodSym(`m${i}`, cls.id, "models/Small.php", 5 + i),
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp/test",
      symbols: [cls, ...methods],
      files: [{ path: "models/Small.php", language: "php", symbol_count: 13, last_modified: 0 }],
      created_at: 0,
      updated_at: 0,
      symbol_count: 13,
      file_count: 1,
    });

    // Default thresholds → not flagged
    const defaultR = await findPhpGodModel("test");
    expect(defaultR.models.find((m) => m.name === "Small")).toBeUndefined();

    // Lowered threshold → flagged
    const tightR = await findPhpGodModel("test", { min_methods: 10 });
    const hit = tightR.models.find((m) => m.name === "Small");
    expect(hit).toBeDefined();
    expect(hit!.reasons.some((x) => x.includes("methods: 12 > 10"))).toBe(true);
  });

  it("reports duplicate class names in different files separately", async () => {
    const survey1 = makeClassSym("Survey", "models/Survey.php", 1, 700);
    const survey2 = makeClassSym("Survey", "models/Survey copy.php", 1, 700);
    const ms1 = Array.from({ length: 60 }, (_, i) =>
      makeMethodSym(`m${i}`, survey1.id, "models/Survey.php", 10 + i),
    );
    const ms2 = Array.from({ length: 60 }, (_, i) =>
      makeMethodSym(`m${i}`, survey2.id, "models/Survey copy.php", 10 + i),
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp/test",
      symbols: [survey1, survey2, ...ms1, ...ms2],
      files: [
        { path: "models/Survey.php", language: "php", symbol_count: 61, last_modified: 0 },
        { path: "models/Survey copy.php", language: "php", symbol_count: 61, last_modified: 0 },
      ],
      created_at: 0,
      updated_at: 0,
      symbol_count: 122,
      file_count: 2,
    });

    const r = await findPhpGodModel("test");
    const surveys = r.models.filter((m) => m.name === "Survey");
    expect(surveys).toHaveLength(2);
    const paths = surveys.map((s) => s.file).sort();
    expect(paths).toEqual(["models/Survey copy.php", "models/Survey.php"]);
  });
});
