import { describe, it, expect, afterEach } from "vitest";
import { LspManager } from "../../src/lsp/lsp-manager.js";

describe("LspManager", () => {
  let manager: LspManager;

  afterEach(async () => {
    if (manager) await manager.shutdown();
  });

  it("returns null for unsupported language", async () => {
    manager = new LspManager();
    const client = await manager.getClient("/tmp/test", "markdown");
    expect(client).toBeNull();
  });

  it("returns null when LSP binary not installed", async () => {
    manager = new LspManager();
    // Ruby LSP binary typically not installed in dev/CI environments
    const client = await manager.getClient("/tmp/test", "ruby");
    expect(client).toBeNull();
  });

  it("shutdown completes without error when no sessions", async () => {
    manager = new LspManager();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it("getServerName returns command for known language", () => {
    manager = new LspManager();
    expect(manager.getServerName("typescript")).toBe("typescript-language-server");
    expect(manager.getServerName("python")).toBe("pylsp");
    expect(manager.getServerName("markdown")).toBeNull();
  });
});
