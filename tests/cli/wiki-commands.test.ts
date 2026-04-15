// ---------------------------------------------------------------------------
// Tests for wiki-generate and wiki-lint CLI commands
// ---------------------------------------------------------------------------

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/tools/wiki-tools.js", () => ({
  generateWiki: vi.fn().mockResolvedValue({
    wiki_dir: "/repo/.codesift/wiki",
    pages: 5,
    communities: 3,
    hubs: 10,
    surprises: 2,
    degraded: false,
  }),
}));
vi.mock("../../src/tools/wiki-lint.js", () => ({
  lintWiki: vi.fn().mockResolvedValue({ issues: [], warnings: [] }),
}));
vi.mock("../../src/tools/lens-tools.js", () => ({
  generateLens: vi.fn().mockResolvedValue({ path: "/repo/codesift-lens.html" }),
}));

describe("wiki CLI commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: COMMAND_MAP["wiki-generate"] exists and is a function
  it("COMMAND_MAP['wiki-generate'] exists and is a function", async () => {
    const { COMMAND_MAP } = await import("../../src/cli/commands.js");
    expect(COMMAND_MAP["wiki-generate"]).toBeDefined();
    expect(typeof COMMAND_MAP["wiki-generate"]).toBe("function");
  });

  // Test 2: COMMAND_MAP["wiki-lint"] exists and is a function
  it("COMMAND_MAP['wiki-lint'] exists and is a function", async () => {
    const { COMMAND_MAP } = await import("../../src/cli/commands.js");
    expect(COMMAND_MAP["wiki-lint"]).toBeDefined();
    expect(typeof COMMAND_MAP["wiki-lint"]).toBe("function");
  });

  // Test 3: handleWikiGenerate calls generateWiki with repo arg
  it("handleWikiGenerate calls generateWiki with repo arg", async () => {
    const { generateWiki } = await import("../../src/tools/wiki-tools.js");
    const { handleWikiGenerate } = await import("../../src/cli/wiki-commands.js");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handleWikiGenerate(["my-repo"], {});
    writeSpy.mockRestore();

    expect(generateWiki).toHaveBeenCalledWith("my-repo", expect.objectContaining({}));
  });

  // Test 4: handleWikiGenerate with --no-lens does NOT call generateLens
  it("handleWikiGenerate with --no-lens does NOT call generateLens", async () => {
    const { generateLens } = await import("../../src/tools/lens-tools.js");
    const { handleWikiGenerate } = await import("../../src/cli/wiki-commands.js");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handleWikiGenerate(["my-repo"], { "no-lens": true });
    writeSpy.mockRestore();

    expect(generateLens).not.toHaveBeenCalled();
  });

  // Test 5: handleWikiGenerate with --focus passes focus to generateWiki
  it("handleWikiGenerate with --focus passes focus to generateWiki", async () => {
    const { generateWiki } = await import("../../src/tools/wiki-tools.js");
    const { handleWikiGenerate } = await import("../../src/cli/wiki-commands.js");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handleWikiGenerate(["my-repo"], { focus: "src/auth" });
    writeSpy.mockRestore();

    expect(generateWiki).toHaveBeenCalledWith("my-repo", expect.objectContaining({ focus: "src/auth" }));
  });

  // Test 6: handleWikiGenerate with --output passes output_dir
  it("handleWikiGenerate with --output passes output_dir to generateWiki", async () => {
    const { generateWiki } = await import("../../src/tools/wiki-tools.js");
    const { handleWikiGenerate } = await import("../../src/cli/wiki-commands.js");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handleWikiGenerate(["my-repo"], { output: "/custom/wiki" });
    writeSpy.mockRestore();

    expect(generateWiki).toHaveBeenCalledWith("my-repo", expect.objectContaining({ output_dir: "/custom/wiki" }));
  });

  // Test 7: handleWikiLint calls lintWiki
  it("handleWikiLint calls lintWiki", async () => {
    const { lintWiki } = await import("../../src/tools/wiki-lint.js");
    const { handleWikiLint } = await import("../../src/cli/wiki-commands.js");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handleWikiLint(["/repo/.codesift/wiki"], {});
    writeSpy.mockRestore();

    expect(lintWiki).toHaveBeenCalledWith("/repo/.codesift/wiki");
  });

  // Test 8: COMMAND_HELP["wiki-generate"] exists
  it("COMMAND_HELP['wiki-generate'] exists", async () => {
    const { COMMAND_HELP } = await import("../../src/cli/help.js");
    expect(COMMAND_HELP["wiki-generate"]).toBeDefined();
    expect(typeof COMMAND_HELP["wiki-generate"]).toBe("string");
    expect(COMMAND_HELP["wiki-generate"].length).toBeGreaterThan(0);
  });
});
