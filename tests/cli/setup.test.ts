import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
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
const { setup, formatSetupResult, SUPPORTED_PLATFORMS, setupClaudeHooks } = await import(
  "../../src/cli/setup.js"
);

describe("setup", () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codesift-setup-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
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
      expect(content).toContain('command = "npx"');
      expect(content).toContain('args = ["-y", "codesift-mcp"]');
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
        command: "npx",
        args: ["-y", "codesift-mcp"],
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
        command: "npx",
        args: ["-y", "codesift-mcp"],
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
      expect(content.mcpServers.codesift.command).toBe("npx");
    });

    it("skips when already configured", async () => {
      const configDir = join(tempHome, ".claude");
      await mkdir(configDir, { recursive: true });
      const original = {
        mcpServers: { codesift: { command: "npx", args: ["-y", "codesift-mcp"] } },
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
        command: "npx",
        args: ["-y", "codesift-mcp"],
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
});
