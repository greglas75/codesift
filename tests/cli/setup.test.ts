import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

// Mock homedir to use a temp directory
let tempHome: string;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

// Import after mock so the module picks up our homedir
const { setup, setupAll, formatSetupResult, formatSetupLines, SUPPORTED_PLATFORMS, setupClaudeHooks, setupCodexHooks, setupGeminiHooks, setupHooksForPlatform, installRules } =
  await import("../../src/cli/setup.js");

// ---------------------------------------------------------------------------
// Test helper: run setup and collect output lines
// ---------------------------------------------------------------------------

async function setupWithLines(
  platform: string,
  options?: Parameters<typeof setup>[1],
): Promise<{ lines: string[] }> {
  const lines = await formatSetupLines(platform, options);
  return { lines };
}

describe("setup", () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codesift-setup-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("rejects unknown platform", async () => {
    await expect(setup("vscode")).rejects.toThrow(/Unknown platform.*vscode/);
  });

  it("exports supported platforms", () => {
    expect(SUPPORTED_PLATFORMS).toContain("codex");
    expect(SUPPORTED_PLATFORMS).toContain("claude");
    expect(SUPPORTED_PLATFORMS).toContain("cursor");
    expect(SUPPORTED_PLATFORMS).toContain("gemini");
    expect(SUPPORTED_PLATFORMS).toContain("antigravity");
  });

  // -------------------------------------------------------------------------
  // Codex
  // -------------------------------------------------------------------------

  describe("codex", () => {
    it("creates config.toml when none exists", async () => {
      const result = await setup("codex");

      expect(result.status).toBe("created");
      expect(result.platform).toBe("codex");
      expect(result.config_path).toBe(join(tempHome, ".codex", "config.toml"));

      const content = await readFile(result.config_path, "utf-8");
      expect(content).toContain("[mcp_servers.codesift]");
      expect(content).toMatch(/command = ".*(?:node|npx)"/);
      expect(content).toMatch(/args = \[.*codesift.*\]/);
      expect(content).toContain("tool_timeout_sec = 120");
    });

    it("appends to existing config.toml", async () => {
      const configDir = join(tempHome, ".codex");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.toml"),
        '[model]\nprovider = "openai"\n',
        "utf-8",
      );

      const result = await setup("codex");
      expect(result.status).toBe("updated");

      const content = await readFile(result.config_path, "utf-8");
      expect(content).toContain('[model]\nprovider = "openai"');
      expect(content).toContain("[mcp_servers.codesift]");
    });

    it("skips when already configured", async () => {
      const configDir = join(tempHome, ".codex");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.toml"),
        '[mcp_servers.codesift]\ncommand = "npx"\n',
        "utf-8",
      );

      const result = await setup("codex");
      expect(result.status).toBe("already_configured");

      // File unchanged
      const content = await readFile(result.config_path, "utf-8");
      expect(content).toBe('[mcp_servers.codesift]\ncommand = "npx"\n');
    });
  });

  // -------------------------------------------------------------------------
  // Claude Code
  // -------------------------------------------------------------------------

  describe("claude", () => {
    it("creates settings.json when none exists", async () => {
      const result = await setup("claude");

      expect(result.status).toBe("created");
      expect(result.config_path).toBe(join(tempHome, ".claude", "settings.json"));

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });

    it("adds to existing settings.json preserving other keys", async () => {
      const configDir = join(tempHome, ".claude");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify({ theme: "dark", mcpServers: { other: { command: "foo" } } }),
        "utf-8",
      );

      const result = await setup("claude");
      expect(result.status).toBe("updated");

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.theme).toBe("dark");
      expect(content.mcpServers.other.command).toBe("foo");
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });

    it("adds mcpServers key when missing from existing file", async () => {
      const configDir = join(tempHome, ".claude");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify({ theme: "dark" }),
        "utf-8",
      );

      const result = await setup("claude");
      expect(result.status).toBe("updated");

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.mcpServers.codesift.command).toMatch(/node$|npx$/);
    });

    it("skips when already configured", async () => {
      const configDir = join(tempHome, ".claude");
      await mkdir(configDir, { recursive: true });
      const original = {
        mcpServers: { codesift: { command: expect.stringMatching(/node$|npx$/), args: expect.arrayContaining([expect.stringMatching(/codesift/)]) } },
      };
      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify(original),
        "utf-8",
      );

      const result = await setup("claude");
      expect(result.status).toBe("already_configured");
    });

    it("throws on invalid JSON", async () => {
      const configDir = join(tempHome, ".claude");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "settings.json"), "not json{{{", "utf-8");

      await expect(setup("claude")).rejects.toThrow(/Failed to parse/);
    });

    it("treats empty settings.json as empty object", async () => {
      const configDir = join(tempHome, ".claude");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "settings.json"), "", "utf-8");

      const result = await setup("claude");
      expect(result.status).toBe("updated");

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.mcpServers.codesift.command).toMatch(/node$|npx$/);
    });
  });

  // -------------------------------------------------------------------------
  // Cursor
  // -------------------------------------------------------------------------

  describe("cursor", () => {
    it("creates mcp.json when none exists", async () => {
      const result = await setup("cursor");

      expect(result.status).toBe("created");
      expect(result.config_path).toBe(join(tempHome, ".cursor", "mcp.json"));

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });

    it("skips when already configured", async () => {
      const configDir = join(tempHome, ".cursor");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "mcp.json"),
        JSON.stringify({ mcpServers: { codesift: { command: "npx" } } }),
        "utf-8",
      );

      const result = await setup("cursor");
      expect(result.status).toBe("already_configured");
    });
  });

  // -------------------------------------------------------------------------
  // Gemini CLI
  // -------------------------------------------------------------------------

  describe("gemini", () => {
    it("creates settings.json when none exists", async () => {
      const result = await setup("gemini");

      expect(result.status).toBe("created");
      expect(result.platform).toBe("gemini");
      expect(result.config_path).toBe(join(tempHome, ".gemini", "settings.json"));

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });

    it("adds to existing settings.json preserving other keys", async () => {
      const configDir = join(tempHome, ".gemini");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify({ theme: "dark", mcpServers: { other: { command: "foo" } } }),
        "utf-8",
      );

      const result = await setup("gemini");
      expect(result.status).toBe("updated");

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.theme).toBe("dark");
      expect(content.mcpServers.other.command).toBe("foo");
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });

    it("skips when already configured", async () => {
      const configDir = join(tempHome, ".gemini");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify({ mcpServers: { codesift: { command: "npx" } } }),
        "utf-8",
      );

      const result = await setup("gemini");
      expect(result.status).toBe("already_configured");
    });
  });

  // -------------------------------------------------------------------------
  // Antigravity
  // -------------------------------------------------------------------------

  describe("antigravity", () => {
    it("creates mcp_config.json when none exists", async () => {
      const result = await setup("antigravity");

      expect(result.status).toBe("created");
      expect(result.platform).toBe("antigravity");
      expect(result.config_path).toBe(join(tempHome, ".gemini", "antigravity", "mcp_config.json"));

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });

    it("adds to existing mcp_config.json preserving other keys", async () => {
      const configDir = join(tempHome, ".gemini", "antigravity");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "mcp_config.json"),
        JSON.stringify({ theme: "dark", mcpServers: { other: { command: "foo" } } }),
        "utf-8",
      );

      const result = await setup("antigravity");
      expect(result.status).toBe("updated");

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.theme).toBe("dark");
      expect(content.mcpServers.other.command).toBe("foo");
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });

    it("skips when already configured", async () => {
      const configDir = join(tempHome, ".gemini", "antigravity");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "mcp_config.json"),
        JSON.stringify({ mcpServers: { codesift: { command: "npx" } } }),
        "utf-8",
      );

      const result = await setup("antigravity");
      expect(result.status).toBe("already_configured");
    });

    it("treats empty mcp_config.json as empty object", async () => {
      const configDir = join(tempHome, ".gemini", "antigravity");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "mcp_config.json"), "", "utf-8");

      const result = await setup("antigravity");
      expect(result.status).toBe("updated");

      const content = JSON.parse(await readFile(result.config_path, "utf-8"));
      expect(content.mcpServers.codesift).toEqual({
        command: expect.stringMatching(/node$|npx$/),
        args: expect.arrayContaining([expect.stringMatching(/codesift/)]),
      });
    });
  });

  // -------------------------------------------------------------------------
  // setupAll
  // -------------------------------------------------------------------------

  describe("setupAll", () => {
    it("configures all platforms", async () => {
      const results = await setupAll();

      expect(results).toHaveLength(SUPPORTED_PLATFORMS.length);
      for (const result of results) {
        expect(result.status).toBe("created");
      }
      const platforms = results.map((r) => r.platform);
      expect(platforms).toContain("codex");
      expect(platforms).toContain("claude");
      expect(platforms).toContain("cursor");
      expect(platforms).toContain("gemini");
      expect(platforms).toContain("antigravity");
    });

    it("is idempotent — second run returns already_configured for all", async () => {
      await setupAll();
      const results = await setupAll();

      for (const result of results) {
        expect(result.status).toBe("already_configured");
      }
    });
  });

  // -------------------------------------------------------------------------
  // formatSetupResult
  // -------------------------------------------------------------------------

  describe("formatSetupResult", () => {
    it("formats created status", () => {
      const msg = formatSetupResult({
        platform: "codex",
        config_path: "/home/.codex/config.toml",
        status: "created",
      });
      expect(msg).toContain("Created");
      expect(msg).toContain("config.toml");
    });

    it("formats updated status", () => {
      const msg = formatSetupResult({
        platform: "claude",
        config_path: "/home/.claude/settings.json",
        status: "updated",
      });
      expect(msg).toContain("Added");
      expect(msg).toContain("settings.json");
    });

    it("formats already_configured status", () => {
      const msg = formatSetupResult({
        platform: "cursor",
        config_path: "/home/.cursor/mcp.json",
        status: "already_configured",
      });
      expect(msg).toContain("already configured");
    });

    it("includes rules file path when rules were installed (action: created)", () => {
      const msg = formatSetupResult(
        {
          platform: "claude",
          config_path: "/home/.claude/settings.json",
          status: "created",
        },
        { path: "/home/.claude/rules/codesift.md", action: "created" },
      );
      expect(msg).toContain("/home/.claude/rules/codesift.md");
      expect(msg).toContain("created");
    });

    it("includes rules file path when rules were updated (action: updated)", () => {
      const msg = formatSetupResult(
        {
          platform: "claude",
          config_path: "/home/.claude/settings.json",
          status: "updated",
        },
        { path: "/home/.claude/rules/codesift.md", action: "updated" },
      );
      expect(msg).toContain("/home/.claude/rules/codesift.md");
      expect(msg).toContain("updated");
    });

    it("omits rules line when rules result action is skipped", () => {
      const msg = formatSetupResult(
        {
          platform: "claude",
          config_path: "/home/.claude/settings.json",
          status: "created",
        },
        { path: "/home/.claude/rules/codesift.md", action: "skipped" },
      );
      expect(msg).not.toContain("/home/.claude/rules/codesift.md");
    });

    it("omits rules line when no rules result passed", () => {
      const msg = formatSetupResult({
        platform: "codex",
        config_path: "/home/.codex/config.toml",
        status: "created",
      });
      // No rules path in output
      expect(msg).not.toContain("rules");
    });
  });

  // -------------------------------------------------------------------------
  // setup output lines — claude with config + rules + hooks
  // -------------------------------------------------------------------------

  describe("setup output lines", () => {
    it("setup('claude', { rules: true, hooks: true }) produces config + rules + hooks lines", async () => {
      const { lines } = await setupWithLines("claude", { rules: true, hooks: true });

      // config line
      expect(lines.some((l) => l.includes("settings.json"))).toBe(true);
      // rules line
      expect(lines.some((l) => l.includes("codesift.md"))).toBe(true);
      // hooks line
      expect(lines.some((l) => l.toLowerCase().includes("hook"))).toBe(true);
    });

    it("setup('codex') produces only config line (no rules, no hooks)", async () => {
      const { lines } = await setupWithLines("codex");

      expect(lines.some((l) => l.includes("config.toml"))).toBe(true);
      expect(lines.some((l) => l.includes("codesift.md"))).toBe(false);
      expect(lines.some((l) => l.toLowerCase().includes("hook"))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it("is idempotent — running twice returns already_configured", async () => {
    const first = await setup("codex");
    expect(first.status).toBe("created");

    const second = await setup("codex");
    expect(second.status).toBe("already_configured");
  });

  // -------------------------------------------------------------------------
  // Hook installation via setup("claude", { hooks: true })
  // -------------------------------------------------------------------------

  describe("hook installation", () => {
    it("setup('claude', { hooks: true }) writes PreToolUse + PostToolUse entries", async () => {
      const result = await setup("claude", { hooks: true });
      expect(result.status).toBe("created");

      const settingsPath = join(tempHome, ".claude", "settings.local.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

      const preToolUse = settings.hooks?.PreToolUse as Array<{ matcher: string }> | undefined;
      expect(preToolUse).toBeDefined();
      expect(preToolUse!.some((h) => h.matcher === "Read")).toBe(true);

      const postToolUse = settings.hooks?.PostToolUse as Array<{ matcher: string }> | undefined;
      expect(postToolUse).toBeDefined();
      expect(postToolUse!.some((h) => h.matcher === "Write|Edit")).toBe(true);
    });

    it("hook installation is idempotent (no duplicates on second run)", async () => {
      await setup("claude", { hooks: true });
      await setup("claude", { hooks: true });

      const settingsPath = join(tempHome, ".claude", "settings.local.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

      const preToolUse = settings.hooks?.PreToolUse as Array<{ matcher: string }> | undefined;
      const preReadCount = preToolUse!.filter((h) => h.matcher === "Read").length;
      expect(preReadCount).toBe(1);

      const postToolUse = settings.hooks?.PostToolUse as Array<{ matcher: string }> | undefined;
      const postWriteCount = postToolUse!.filter((h) => h.matcher === "Write|Edit").length;
      expect(postWriteCount).toBe(1);
    });

    it("setup('claude') without hooks flag does NOT write hook entries", async () => {
      await setup("claude");

      const settingsPath = join(tempHome, ".claude", "settings.local.json");
      // File should NOT exist because no hooks flag was passed
      let exists = true;
      try {
        await readFile(settingsPath, "utf-8");
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it("merges hooks into existing settings.local.json without overwriting other hooks", async () => {
      const claudeDir = join(tempHome, ".claude");
      await mkdir(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, "settings.local.json");

      // Write existing Stop hook
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            Stop: [{ matcher: "", hooks: [{ type: "command", command: "existing-stop-hook" }] }],
          },
        }),
        "utf-8",
      );

      await setup("claude", { hooks: true });

      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

      // Existing Stop hook must be preserved
      const stopHooks = settings.hooks?.Stop as Array<unknown> | undefined;
      expect(stopHooks).toBeDefined();
      expect(stopHooks!.length).toBe(1);

      // New hooks must be added
      expect(settings.hooks?.PreToolUse).toBeDefined();
      expect(settings.hooks?.PostToolUse).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // installRules
  // -------------------------------------------------------------------------

  describe("installRules", () => {
    it("setup('claude', { rules: true }) creates .claude/rules/codesift.md", async () => {
      await setup("claude", { rules: true });

      const rulesPath = join(tempHome, ".claude", "rules", "codesift.md");
      expect(existsSync(rulesPath)).toBe(true);

      const content = await readFile(rulesPath, "utf-8");
      expect(content).toMatch(/^<!-- codesift-rules v/);
      expect(content).toContain("Tool Mapping");
    });

    it("setup('cursor', { rules: true }) creates .cursor/rules/codesift.mdc", async () => {
      await setup("cursor", { rules: true });

      const rulesPath = join(tempHome, ".cursor", "rules", "codesift.mdc");
      expect(existsSync(rulesPath)).toBe(true);

      const content = await readFile(rulesPath, "utf-8");
      expect(content).toMatch(/<!-- codesift-rules v/);
      expect(content).toContain("Tool Mapping");
    });

    it("re-run with same version and unmodified content → skipped", async () => {
      await setup("claude", { rules: true });
      const result = await installRules("claude", tempHome, { rules: true });

      expect(result.action).toBe("skipped");
    });

    it("user-modified rules file → skipped with warning (no overwrite)", async () => {
      await setup("claude", { rules: true });

      // Simulate user modification
      const rulesPath = join(tempHome, ".claude", "rules", "codesift.md");
      const original = await readFile(rulesPath, "utf-8");
      await writeFile(rulesPath, original + "\n## My Custom Section\n", "utf-8");

      const result = await installRules("claude", tempHome, { rules: true });

      expect(result.action).toBe("skipped");
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/modified/i);

      // File should NOT be overwritten
      const content = await readFile(rulesPath, "utf-8");
      expect(content).toContain("My Custom Section");
    });

    it("force: true on modified file → force-updated", async () => {
      await setup("claude", { rules: true });

      // Simulate user modification
      const rulesPath = join(tempHome, ".claude", "rules", "codesift.md");
      const original = await readFile(rulesPath, "utf-8");
      await writeFile(rulesPath, original + "\n## My Custom Section\n", "utf-8");

      const result = await installRules("claude", tempHome, { rules: true, force: true });

      expect(result.action).toBe("force-updated");

      // File should be overwritten — no custom section
      const content = await readFile(rulesPath, "utf-8");
      expect(content).not.toContain("My Custom Section");
    });

    it("setup('claude', { rules: false }) → no rules file created", async () => {
      await setup("claude", { rules: false });

      const rulesPath = join(tempHome, ".claude", "rules", "codesift.md");
      expect(existsSync(rulesPath)).toBe(false);
    });

    it("auto-creates .claude/rules/ directory if absent", async () => {
      const rulesDir = join(tempHome, ".claude", "rules");
      expect(existsSync(rulesDir)).toBe(false);

      await installRules("claude", tempHome, { rules: true });

      expect(existsSync(rulesDir)).toBe(true);
      expect(existsSync(join(rulesDir, "codesift.md"))).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Codex — append-mode rules into AGENTS.md in cwd
    // -----------------------------------------------------------------------

    describe("codex append-mode rules", () => {
      let tempCwd: string;

      beforeEach(async () => {
        tempCwd = await mkdtemp(join(tmpdir(), "codesift-codex-cwd-"));
        vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
      });

      afterEach(async () => {
        vi.restoreAllMocks();
        await rm(tempCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });

      it("creates AGENTS.md with delimited block when file does not exist", async () => {
        const result = await installRules("codex", tempHome, { rules: true });

        expect(result.action).toBe("created");
        const agentsPath = join(tempCwd, "AGENTS.md");
        expect(existsSync(agentsPath)).toBe(true);

        const content = await readFile(agentsPath, "utf-8");
        expect(content).toContain("<!-- codesift-rules-start -->");
        expect(content).toContain("<!-- codesift-rules-end -->");
        expect(result.path).toBe(agentsPath);
      });

      it("re-run codex: block replaced in-place, not duplicated", async () => {
        await installRules("codex", tempHome, { rules: true });
        const second = await installRules("codex", tempHome, { rules: true });

        const agentsPath = join(tempCwd, "AGENTS.md");
        const content = await readFile(agentsPath, "utf-8");

        const startCount = (content.match(/<!-- codesift-rules-start -->/g) ?? []).length;
        const endCount = (content.match(/<!-- codesift-rules-end -->/g) ?? []).length;
        expect(startCount).toBe(1);
        expect(endCount).toBe(1);
        expect(second.action).toBe("skipped");
      });

      it("appends block to AGENTS.md that already has user content", async () => {
        const agentsPath = join(tempCwd, "AGENTS.md");
        await writeFile(agentsPath, "# My Project\n\nSome instructions.\n", "utf-8");

        await installRules("codex", tempHome, { rules: true });

        const content = await readFile(agentsPath, "utf-8");
        expect(content).toContain("# My Project");
        expect(content).toContain("<!-- codesift-rules-start -->");
        expect(content).toContain("<!-- codesift-rules-end -->");
      });

      it("preserves existing user content before block on re-run", async () => {
        const agentsPath = join(tempCwd, "AGENTS.md");
        await writeFile(agentsPath, "# My Project\n\nSome instructions.\n", "utf-8");

        await installRules("codex", tempHome, { rules: true });
        await installRules("codex", tempHome, { rules: true });

        const content = await readFile(agentsPath, "utf-8");
        expect(content).toContain("# My Project");

        // Only one block pair
        const startCount = (content.match(/<!-- codesift-rules-start -->/g) ?? []).length;
        expect(startCount).toBe(1);
      });

      it("setup('codex', { rules: true }) uses installRules codex path", async () => {
        const result = await setup("codex", { rules: true });
        expect(result.platform).toBe("codex");

        const agentsPath = join(tempCwd, "AGENTS.md");
        expect(existsSync(agentsPath)).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // Gemini — append-mode rules into GEMINI.md in cwd
    // -----------------------------------------------------------------------

    describe("gemini append-mode rules", () => {
      let tempCwd: string;

      beforeEach(async () => {
        tempCwd = await mkdtemp(join(tmpdir(), "codesift-gemini-cwd-"));
        vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
      });

      afterEach(async () => {
        vi.restoreAllMocks();
        await rm(tempCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });

      it("creates GEMINI.md with delimited block when file does not exist", async () => {
        const result = await installRules("gemini", tempHome, { rules: true });

        expect(result.action).toBe("created");
        const geminiPath = join(tempCwd, "GEMINI.md");
        expect(existsSync(geminiPath)).toBe(true);

        const content = await readFile(geminiPath, "utf-8");
        expect(content).toContain("<!-- codesift-rules-start -->");
        expect(content).toContain("<!-- codesift-rules-end -->");
        expect(result.path).toBe(geminiPath);
      });

      it("re-run gemini: block replaced in-place, not duplicated", async () => {
        await installRules("gemini", tempHome, { rules: true });
        const second = await installRules("gemini", tempHome, { rules: true });

        const geminiPath = join(tempCwd, "GEMINI.md");
        const content = await readFile(geminiPath, "utf-8");

        const startCount = (content.match(/<!-- codesift-rules-start -->/g) ?? []).length;
        const endCount = (content.match(/<!-- codesift-rules-end -->/g) ?? []).length;
        expect(startCount).toBe(1);
        expect(endCount).toBe(1);
        expect(second.action).toBe("skipped");
      });

      it("setup('gemini', { rules: true }) uses installRules gemini path", async () => {
        const result = await setup("gemini", { rules: true });
        expect(result.platform).toBe("gemini");

        const geminiPath = join(tempCwd, "GEMINI.md");
        expect(existsSync(geminiPath)).toBe(true);
      });
    });

    it("version change with unmodified template hash → updated", async () => {
      await setup("claude", { rules: true });

      const rulesPath = join(tempHome, ".claude", "rules", "codesift.md");
      const content = await readFile(rulesPath, "utf-8");
      // Simulate an older version header but keep the same body hash
      const modified = content.replace(/v[\d.]+/, "v0.0.1");
      await writeFile(rulesPath, modified, "utf-8");

      const result = await installRules("claude", tempHome, { rules: true });
      expect(result.action).toBe("updated");
    });
  });

  // -------------------------------------------------------------------------
  // Codex hooks
  // -------------------------------------------------------------------------

  describe("setupCodexHooks", () => {
    it("creates hooks.json with PreToolUse and Stop hooks when none exists", async () => {
      await setupCodexHooks();

      const hooksPath = join(tempHome, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);

      const content = JSON.parse(await readFile(hooksPath, "utf-8"));
      expect(content.hooks.PreToolUse).toHaveLength(1);
      expect(content.hooks.PreToolUse[0].matcher).toBe("Bash");
      expect(content.hooks.PreToolUse[0].hooks[0].command).toContain("codesift precheck-bash --stdin");
      expect(content.hooks.Stop).toHaveLength(1);
      expect(content.hooks.Stop[0].hooks[0].command).toContain("codesift index-conversations");
    });

    it("is idempotent — no duplicates on second run", async () => {
      await setupCodexHooks();
      await setupCodexHooks();

      const hooksPath = join(tempHome, ".codex", "hooks.json");
      const content = JSON.parse(await readFile(hooksPath, "utf-8"));
      expect(content.hooks.PreToolUse).toHaveLength(1);
      expect(content.hooks.Stop).toHaveLength(1);
    });

    it("preserves existing hooks in hooks.json", async () => {
      const configDir = join(tempHome, ".codex");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "hooks.json"),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-hook" }] }] } }),
        "utf-8",
      );

      await setupCodexHooks();

      const content = JSON.parse(await readFile(join(configDir, "hooks.json"), "utf-8"));
      // Existing user hook preserved + codesift PreToolUse added
      expect(content.hooks.PreToolUse).toHaveLength(2);
      expect(content.hooks.PreToolUse[0].hooks[0].command).toBe("my-hook");
      expect(content.hooks.PreToolUse[1].hooks[0].command).toContain("codesift precheck-bash");
      expect(content.hooks.Stop).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Gemini hooks
  // -------------------------------------------------------------------------

  describe("setupGeminiHooks", () => {
    it("adds all 4 hooks to settings.json when none exists", async () => {
      await setupGeminiHooks();

      const settingsPath = join(tempHome, ".gemini", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);

      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(content.hooks.BeforeTool).toHaveLength(1);
      expect(content.hooks.BeforeTool[0].matcher).toBe("read_file");
      expect(content.hooks.AfterTool).toHaveLength(1);
      expect(content.hooks.AfterTool[0].matcher).toBe("write_file|replace");
      expect(content.hooks.PreCompress).toHaveLength(1);
      expect(content.hooks.SessionEnd).toHaveLength(1);
    });

    it("is idempotent — no duplicates on second run", async () => {
      await setupGeminiHooks();
      await setupGeminiHooks();

      const settingsPath = join(tempHome, ".gemini", "settings.json");
      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(content.hooks.BeforeTool).toHaveLength(1);
      expect(content.hooks.AfterTool).toHaveLength(1);
      expect(content.hooks.PreCompress).toHaveLength(1);
      expect(content.hooks.SessionEnd).toHaveLength(1);
    });

    it("preserves existing mcpServers when adding hooks", async () => {
      const configDir = join(tempHome, ".gemini");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify({ mcpServers: { codesift: { command: "npx" } } }),
        "utf-8",
      );

      await setupGeminiHooks();

      const content = JSON.parse(await readFile(join(configDir, "settings.json"), "utf-8"));
      expect(content.mcpServers.codesift.command).toMatch(/node$|npx$/);
      expect(content.hooks.BeforeTool).toHaveLength(1);
    });

    it("uses Gemini event names (BeforeTool not PreToolUse)", async () => {
      await setupGeminiHooks();

      const settingsPath = join(tempHome, ".gemini", "settings.json");
      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(content.hooks.PreToolUse).toBeUndefined();
      expect(content.hooks.PostToolUse).toBeUndefined();
      expect(content.hooks.PreCompact).toBeUndefined();
      expect(content.hooks.Stop).toBeUndefined();
    });

    it("uses --stdin flag in commands for Gemini", async () => {
      await setupGeminiHooks();

      const settingsPath = join(tempHome, ".gemini", "settings.json");
      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(content.hooks.BeforeTool[0].hooks[0].command).toContain("--stdin");
      expect(content.hooks.AfterTool[0].hooks[0].command).toContain("--stdin");
      expect(content.hooks.PreCompress[0].hooks[0].command).toContain("--stdin");
    });
  });

  // -------------------------------------------------------------------------
  // setupHooksForPlatform
  // -------------------------------------------------------------------------

  describe("setupHooksForPlatform", () => {
    it("installs Claude hooks for platform 'claude'", async () => {
      await setupHooksForPlatform("claude");
      const hooksPath = join(tempHome, ".claude", "settings.local.json");
      expect(existsSync(hooksPath)).toBe(true);
      const content = JSON.parse(await readFile(hooksPath, "utf-8"));
      expect(content.hooks.PreToolUse).toBeDefined();
    });

    it("installs Codex hooks for platform 'codex'", async () => {
      await setupHooksForPlatform("codex");
      const hooksPath = join(tempHome, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
    });

    it("installs Gemini hooks for platform 'gemini'", async () => {
      await setupHooksForPlatform("gemini");
      const settingsPath = join(tempHome, ".gemini", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(content.hooks.BeforeTool).toBeDefined();
    });

    it("does nothing for platform 'unknown'", async () => {
      await setupHooksForPlatform("unknown");
      // Should not throw, should not create any files
      expect(existsSync(join(tempHome, ".claude", "settings.local.json"))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // CLI setup with --hooks for non-Claude platforms
  // -------------------------------------------------------------------------

  describe("setup --hooks for all platforms", () => {
    it("setup('codex', { hooks: true }) installs Codex hooks", async () => {
      const result = await setup("codex", { hooks: true });
      expect(result.platform).toBe("codex");

      const hooksPath = join(tempHome, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
    });

    it("setup('gemini', { hooks: true }) installs Gemini hooks", async () => {
      const result = await setup("gemini", { hooks: true });
      expect(result.platform).toBe("gemini");

      const settingsPath = join(tempHome, ".gemini", "settings.json");
      const content = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(content.hooks.BeforeTool).toBeDefined();
    });

    it("setup('all', { hooks: true }) via setupAll installs hooks for all supported platforms", async () => {
      await setupAll({ hooks: true });

      // Claude hooks
      expect(existsSync(join(tempHome, ".claude", "settings.local.json"))).toBe(true);
      // Codex hooks
      expect(existsSync(join(tempHome, ".codex", "hooks.json"))).toBe(true);
      // Gemini hooks
      const geminiSettings = JSON.parse(
        await readFile(join(tempHome, ".gemini", "settings.json"), "utf-8"),
      );
      expect(geminiSettings.hooks.BeforeTool).toBeDefined();
    });
  });
});
