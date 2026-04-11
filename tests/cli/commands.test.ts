import { vi, type MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches the modules
// ---------------------------------------------------------------------------

const mockAnalyzeComplexity = vi.fn().mockResolvedValue({ functions: [], summary: {} });
const mockFindDeadCode = vi.fn().mockResolvedValue({ candidates: [], scanned_symbols: 0, scanned_files: 0 });
const mockAnalyzeHotspots = vi.fn().mockResolvedValue({ hotspots: [], summary: {} });
const mockDetectCommunities = vi.fn().mockResolvedValue({ communities: [], modularity: 0 });
const mockSearchPatterns = vi.fn().mockResolvedValue({ matches: [], pattern: "empty-catch" });
const mockFindClones = vi.fn().mockResolvedValue({ clones: [], summary: {} });
const mockSetup = vi.fn().mockResolvedValue({ platform: "claude", config_path: "/test", status: "created" });
const mockSetupAll = vi.fn().mockResolvedValue([]);
const mockFormatSetupLines = vi.fn().mockResolvedValue(["✓ created /test"]);

vi.mock("../../src/tools/complexity-tools.js", () => ({
  analyzeComplexity: mockAnalyzeComplexity,
}));
vi.mock("../../src/tools/symbol-tools.js", () => ({
  findDeadCode: mockFindDeadCode,
  // Keep other exports that may exist
  getSymbol: vi.fn(),
  getSymbols: vi.fn(),
  findAndShow: vi.fn(),
  findReferences: vi.fn(),
}));
vi.mock("../../src/tools/hotspot-tools.js", () => ({
  analyzeHotspots: mockAnalyzeHotspots,
}));
vi.mock("../../src/tools/community-tools.js", () => ({
  detectCommunities: mockDetectCommunities,
}));
vi.mock("../../src/tools/pattern-tools.js", () => ({
  searchPatterns: mockSearchPatterns,
}));
vi.mock("../../src/tools/clone-tools.js", () => ({
  findClones: mockFindClones,
}));
vi.mock("../../src/cli/setup.js", () => ({
  setup: mockSetup,
  setupAll: mockSetupAll,
  formatSetupResult: vi.fn().mockReturnValue("setup result"),
  formatSetupLines: mockFormatSetupLines,
  SUPPORTED_PLATFORMS: ["claude", "cursor", "codex", "gemini", "antigravity"],
}));

import { COMMAND_MAP } from "../../src/cli/commands.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let stdoutSpy: MockInstance;
let stderrSpy: MockInstance;
let exitSpy: MockInstance;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

describe("new CLI commands — registration", () => {
  it.each([
    "complexity",
    "dead-code",
    "hotspots",
    "communities",
    "patterns",
    "find-clones",
  ])("COMMAND_MAP contains '%s'", (cmd) => {
    expect(COMMAND_MAP[cmd]).toBeDefined();
    expect(typeof COMMAND_MAP[cmd]).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// complexity
// ---------------------------------------------------------------------------

describe("complexity command", () => {
  it("calls analyzeComplexity with repo and outputs result", async () => {
    await COMMAND_MAP["complexity"]!(["local/test-repo"], { compact: true });

    expect(mockAnalyzeComplexity).toHaveBeenCalledWith("local/test-repo", {
      file_pattern: undefined,
      top_n: undefined,
      min_complexity: undefined,
      include_tests: undefined,
    });
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("passes optional flags through", async () => {
    await COMMAND_MAP["complexity"]!(["local/test-repo"], {
      compact: true,
      "file-pattern": "*.ts",
      "top-n": "10",
      "min-complexity": "5",
      "include-tests": true,
    });

    expect(mockAnalyzeComplexity).toHaveBeenCalledWith("local/test-repo", {
      file_pattern: "*.ts",
      top_n: 10,
      min_complexity: 5,
      include_tests: true,
    });
  });

  it("dies when repo is missing", async () => {
    await COMMAND_MAP["complexity"]!([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Missing required argument"));
  });
});

// ---------------------------------------------------------------------------
// dead-code
// ---------------------------------------------------------------------------

describe("dead-code command", () => {
  it("calls findDeadCode with repo and outputs result", async () => {
    await COMMAND_MAP["dead-code"]!(["local/test-repo"], { compact: true });

    expect(mockFindDeadCode).toHaveBeenCalledWith("local/test-repo", {
      file_pattern: undefined,
      include_tests: undefined,
    });
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("passes optional flags through", async () => {
    await COMMAND_MAP["dead-code"]!(["local/test-repo"], {
      compact: true,
      "file-pattern": "src/",
      "include-tests": true,
    });

    expect(mockFindDeadCode).toHaveBeenCalledWith("local/test-repo", {
      file_pattern: "src/",
      include_tests: true,
    });
  });

  it("dies when repo is missing", async () => {
    await COMMAND_MAP["dead-code"]!([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// hotspots
// ---------------------------------------------------------------------------

describe("hotspots command", () => {
  it("calls analyzeHotspots with repo and outputs result", async () => {
    await COMMAND_MAP["hotspots"]!(["local/test-repo"], { compact: true });

    expect(mockAnalyzeHotspots).toHaveBeenCalledWith("local/test-repo", {
      since_days: undefined,
      top_n: undefined,
      file_pattern: undefined,
    });
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("passes --since-days flag through", async () => {
    await COMMAND_MAP["hotspots"]!(["local/test-repo"], {
      compact: true,
      "since-days": "30",
      "top-n": "20",
      "file-pattern": "*.ts",
    });

    expect(mockAnalyzeHotspots).toHaveBeenCalledWith("local/test-repo", {
      since_days: 30,
      top_n: 20,
      file_pattern: "*.ts",
    });
  });

  it("dies when repo is missing", async () => {
    await COMMAND_MAP["hotspots"]!([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// communities
// ---------------------------------------------------------------------------

describe("communities command", () => {
  it("calls detectCommunities with repo and outputs result", async () => {
    await COMMAND_MAP["communities"]!(["local/test-repo"], { compact: true });

    expect(mockDetectCommunities).toHaveBeenCalledWith(
      "local/test-repo",
      undefined, // focus
      undefined, // resolution
      undefined, // outputFormat
    );
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("passes --focus and --resolution flags through", async () => {
    await COMMAND_MAP["communities"]!(["local/test-repo"], {
      compact: true,
      focus: "src/lib",
      resolution: "1.5",
    });

    expect(mockDetectCommunities).toHaveBeenCalledWith(
      "local/test-repo",
      "src/lib",
      1.5,
      undefined,
    );
  });

  it("passes --output-format flag through", async () => {
    await COMMAND_MAP["communities"]!(["local/test-repo"], {
      compact: true,
      "output-format": "mermaid",
    });

    expect(mockDetectCommunities).toHaveBeenCalledWith(
      "local/test-repo",
      undefined,
      undefined,
      "mermaid",
    );
  });

  it("dies when repo is missing", async () => {
    await COMMAND_MAP["communities"]!([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------

describe("patterns command", () => {
  it("calls searchPatterns with repo, pattern, and outputs result", async () => {
    await COMMAND_MAP["patterns"]!(["local/test-repo"], { compact: true, pattern: "empty-catch" });

    expect(mockSearchPatterns).toHaveBeenCalledWith("local/test-repo", "empty-catch", {
      file_pattern: undefined,
      include_tests: undefined,
      max_results: undefined,
    });
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("passes optional flags through", async () => {
    await COMMAND_MAP["patterns"]!(["local/test-repo"], {
      compact: true,
      pattern: "any-type",
      "file-pattern": "*.ts",
      "include-tests": true,
      "max-results": "20",
    });

    expect(mockSearchPatterns).toHaveBeenCalledWith("local/test-repo", "any-type", {
      file_pattern: "*.ts",
      include_tests: true,
      max_results: 20,
    });
  });

  it("dies when repo is missing", async () => {
    await COMMAND_MAP["patterns"]!([], { pattern: "empty-catch" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("dies when --pattern flag is missing", async () => {
    await COMMAND_MAP["patterns"]!(["local/test-repo"], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--pattern"));
  });
});

// ---------------------------------------------------------------------------
// find-clones
// ---------------------------------------------------------------------------

describe("find-clones command", () => {
  it("calls findClones with repo and outputs result", async () => {
    await COMMAND_MAP["find-clones"]!(["local/test-repo"], { compact: true });

    expect(mockFindClones).toHaveBeenCalledWith("local/test-repo", {
      file_pattern: undefined,
      min_similarity: undefined,
      min_lines: undefined,
      include_tests: undefined,
    });
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("passes --threshold as min_similarity", async () => {
    await COMMAND_MAP["find-clones"]!(["local/test-repo"], {
      compact: true,
      threshold: "0.8",
      "file-pattern": "src/",
      "min-lines": "15",
      "include-tests": true,
    });

    expect(mockFindClones).toHaveBeenCalledWith("local/test-repo", {
      file_pattern: "src/",
      min_similarity: 0.8,
      min_lines: 15,
      include_tests: true,
    });
  });

  it("dies when repo is missing", async () => {
    await COMMAND_MAP["find-clones"]!([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

describe("handleSetup", () => {
  beforeEach(() => {
    mockFormatSetupLines.mockReset();
    mockFormatSetupLines.mockResolvedValue(["✓ created /test"]);
  });

  it("defaults hooks and rules to true", async () => {
    await COMMAND_MAP["setup"]!(["claude"], {});
    expect(mockFormatSetupLines).toHaveBeenCalledWith("claude", expect.objectContaining({ hooks: true, rules: true }));
  });

  it("respects --hooks false", async () => {
    await COMMAND_MAP["setup"]!(["claude"], { hooks: "false" });
    expect(mockFormatSetupLines).toHaveBeenCalledWith("claude", expect.objectContaining({ hooks: false }));
  });

  it("respects --no-rules flag", async () => {
    await COMMAND_MAP["setup"]!(["claude"], { rules: "false" });
    expect(mockFormatSetupLines).toHaveBeenCalledWith("claude", expect.objectContaining({ rules: false }));
  });

  it("respects --force flag", async () => {
    await COMMAND_MAP["setup"]!(["claude"], { force: "true" });
    expect(mockFormatSetupLines).toHaveBeenCalledWith("claude", expect.objectContaining({ force: true }));
  });

  it("defaults force to false", async () => {
    await COMMAND_MAP["setup"]!(["claude"], {});
    expect(mockFormatSetupLines).toHaveBeenCalledWith("claude", expect.objectContaining({ force: false }));
  });

  it("dies when platform is missing", async () => {
    await COMMAND_MAP["setup"]!([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
